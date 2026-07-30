// The shared, provider-agnostic execution engine: code normalization, invoker wrapping (input
// validation + defect opacity), and result validation. Providers implement isolate mechanics only.

import { limitError, validationError } from "@busyclaw/contracts";
import { FETCH_TOOL_PATH } from "@busyclaw/egress";
import { type } from "arktype";
import {
	type ExecutionContext,
	executionResult,
	type ProviderExecutionContext,
	type Sandbox,
	type SandboxBudget,
	type SandboxExecution,
	type SandboxToolInvoker,
	sandboxInvokeInput,
	type VolumeTree,
} from "./contracts";

/** Reason code for a malformed invoke shape coming out of sandboxed code. */
const SANDBOX_INVOKE_INVALID = "SANDBOX_INVOKE_INVALID";
/** Reason code for an execution that has spent its whole host allowance. */
const SANDBOX_BUDGET_EXHAUSTED = "SANDBOX_BUDGET_EXHAUSTED";
/** Reason code for a tool result that cannot cross as data (a cycle, a BigInt). */
const SANDBOX_RESULT_UNREPRESENTABLE = "SANDBOX_RESULT_UNREPRESENTABLE";

const DEFAULT_MAX_HOST_CALLS = 200;
const DEFAULT_MAX_CONCURRENT_HOST_CALLS = 8;

/**
 * Reduce a tool result to data before it crosses into the guest.
 *
 * A HandleResult is host-authored, so nobody treated the host→guest direction as a boundary — only
 * guest→host. But a tool that returns a function, or an object holding one, hands the guest a live
 * HOST CALLABLE: the wrapper marshals it, and `result.output.call("arg")` runs host code from inside
 * the sandbox. That is the one thing the wasm isolate exists to prevent, reached without touching
 * the isolate at all — through a tool doing something merely unusual, not hostile.
 *
 * A JSON round-trip is the whole fix: functions, symbols and undefined do not survive it, and what
 * arrives is data. A value that cannot survive it (a cycle, a BigInt) is refused rather than
 * partially marshalled, because "most of it crossed" is not a boundary.
 */
function jsonSafe(
	value: unknown,
): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
	} catch {
		return { ok: false };
	}
}

/**
 * The execution's shared allowance, held by the engine because the engine is the only place BOTH
 * doors pass through — nested tool calls and fetch. A budget either door owned would bound half the
 * work and let a guest spend the rest through the other one.
 *
 * `enter` refuses when the total is gone and otherwise waits for a concurrency slot, so the guest's
 * own speed cannot turn a legal total into a thousand simultaneous sockets. It returns the release,
 * which the caller runs in a `finally` — an operation that never releases would wedge the execution,
 * so the release is a value rather than a rule to remember.
 */
function createExecutionBudget(limits: SandboxBudget | undefined): {
	enter: () => Promise<() => void>;
} {
	const maxCalls = limits?.maxHostCalls ?? DEFAULT_MAX_HOST_CALLS;
	const maxConcurrent =
		limits?.maxConcurrentHostCalls ?? DEFAULT_MAX_CONCURRENT_HOST_CALLS;
	let spent = 0;
	let inFlight = 0;
	const waiting: (() => void)[] = [];

	return {
		enter: async () => {
			if (spent >= maxCalls) {
				throw limitError(`sandbox execution exceeded ${maxCalls} host calls`, {
					limit: maxCalls,
				});
			}
			spent += 1;
			if (inFlight >= maxConcurrent) {
				await new Promise<void>((resolve) => waiting.push(resolve));
			}
			inFlight += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				inFlight -= 1;
				waiting.shift()?.();
			};
		},
	};
}

// Globals via a typed cast — this repo builds without a DOM/node lib, so `crypto`/`console` are not
// ambiently typed (channels' globalThis-cast convention).
const host = globalThis as typeof globalThis & {
	crypto: { randomUUID: () => string };
	console: { error: (...args: unknown[]) => void };
};

/**
 * Strip a single wrapping markdown fence (```lang … ```) and trim. Nothing else — the wrapper owns
 * its own TypeScript support, so busyclaw adds no transpile step. Pure and exported for tests.
 */
export function normalizeCode(code: string): string {
	const trimmed = code.trim();
	const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	const inner = fenced?.[1];
	return (inner ?? trimmed).trim();
}

/**
 * Wrap the host invoker so the sandbox→host boundary is enforced:
 *  - the `{ path, args }` from sandboxed code is validated (arktype) before it crosses further;
 *    an invalid shape becomes a denied-like VALUE the sandbox reads, never a throw;
 *  - a governed outcome (ok/denied) is the value the invoker already returns — passed through;
 *  - an infra defect from the invoker is caught and replaced with an opaque correlation id, the
 *    original logged host-side. Host error text (paths, connection strings) never reaches the model.
 */
function wrapInvoker(
	invoker: SandboxToolInvoker,
	budget: { enter: () => Promise<() => void> },
	signal: AbortSignal,
): SandboxToolInvoker {
	return {
		invoke: async (input) => {
			const valid = sandboxInvokeInput(input);
			if (valid instanceof type.errors) {
				return {
					status: "denied",
					reason: `invalid sandbox invoke input: ${valid.summary}`,
					reasonCode: SANDBOX_INVOKE_INVALID,
				};
			}
			// Exhaustion is a denied VALUE, not a throw — the same shape a governed refusal takes, so
			// model code reads "you have run out" and can adapt instead of dying on it.
			let release: () => void;
			try {
				release = await budget.enter();
			} catch (error) {
				return {
					status: "denied",
					reason: error instanceof Error ? error.message : String(error),
					reasonCode: SANDBOX_BUDGET_EXHAUSTED,
				};
			}
			try {
				const outcome = await invoker.invoke(valid, { signal });
				const safe = jsonSafe(outcome);
				if (!safe.ok) {
					return {
						status: "denied",
						reason: "tool result is not representable as data",
						reasonCode: SANDBOX_RESULT_UNREPRESENTABLE,
					};
				}
				return safe.value;
			} catch (error) {
				const id = host.crypto.randomUUID();
				host.console.error(
					`[sandboxes] internal invoker defect [${id}]`,
					error,
				);
				return { status: "error", error: `internal sandbox error [${id}]` };
			} finally {
				release();
			}
		},
	};
}

/**
 * Normalize the code, wrap the invoker, run it on the provider, and validate the provider's `output`
 * against the floor `executionResult`. A shape mismatch is a provider bug (not model input) →
 * host-side validationError. The mutated `fsTree` (present only when a tree was mounted) is passed
 * back UNVALIDATED — it is host-assembled, not guest-facing. Timeout ownership stays with the
 * provider (the wrapper's executionTimeout); the engine adds no second racing timer. The runcode
 * layer, not the provider, owns the store load/save around this call.
 */
export async function executeInSandbox(input: {
	sandbox: Sandbox;
	code: string;
	invoker: SandboxToolInvoker;
	context: ExecutionContext;
}): Promise<SandboxExecution> {
	const code = normalizeCode(input.code);

	// The floor goes on the path HERE, once, for every execution — a host declares network policy and
	// cannot hand over an unfenced door (see ExecutionContext.network).
	//
	// The controller is the other half. A sandbox deadline rejects the GUEST's promise, but the host
	// request it was waiting on carried on to completion: the guest saw a timeout, the socket did
	// not. A guest could therefore retire promises faster than the host retired connections, and
	// abandoned requests still spent their full 30 seconds against whatever they were aimed at.
	// Aborting in `finally` binds them — when the execution is over, so is its network.
	const { network, budget: limits } = input.context;
	const outstanding = new AbortController();
	const budget = createExecutionBudget(limits);
	const invoker = wrapInvoker(input.invoker, budget, outstanding.signal);

	// The guest's fetch goes through the INVOKER — the same road `tools.x()` takes, so the same
	// chokepoint: the run's principal, a floor decision on `busyclaw.fetch` with `context.server`
	// stamped from the URL, an audit record, and re-redaction of the response before it crosses back
	// into untrusted guest code. The engine used to call the transport itself and got the SSRF floor,
	// a destination list, and none of the rest.
	//
	// `wrapInvoker` charges the same budget it charges a nested tool call, which is now literally what
	// this is — so a guest cannot spend the host by alternating between two counters that were never
	// aware of each other, and nothing bills one request twice.
	//
	// A refusal comes back as a denied VALUE, the shape governed refusals already take. This rethrows
	// it, because a `fetch` that did not happen is an error to the code that called it.
	const governed = network
		? async (target: string | { readonly href: string }, init?: unknown) => {
				const request = (init ?? {}) as {
					method?: string;
					headers?: Record<string, string>;
					body?: string;
				};
				const result = (await invoker.invoke({
					path: FETCH_TOOL_PATH,
					args: {
						url: typeof target === "string" ? target : target.href,
						...(request.method !== undefined ? { method: request.method } : {}),
						...(request.headers !== undefined
							? { headers: request.headers }
							: {}),
						...(request.body !== undefined ? { body: request.body } : {}),
					},
				})) as { status?: string; reason?: string; output?: unknown };
				if (result?.status !== "ok") {
					throw new Error(
						result?.reason ?? "sandbox fetch was refused by governance",
					);
				}
				return result.output;
			}
		: undefined;
	// Built from NAMED fields, never a rest-spread of the host's object. A spread carries every extra
	// key through — including `fetchAdapter`, the ungoverned door removed from `ExecutionContext`
	// above — because removing a field from a TYPE removes it from the type and nothing else: the
	// value still arrives at runtime, and any JS caller (or a widened TS one) still sends it. Verified
	// the hard way: with the spread in place, a raw adapter reached the guest and returned 200 from
	// loopback. An allowlist cannot leak what it does not name.
	const context: ProviderExecutionContext = {
		...(input.context.timeoutMs !== undefined
			? { timeoutMs: input.context.timeoutMs }
			: {}),
		...(input.context.memoryLimitBytes !== undefined
			? { memoryLimitBytes: input.context.memoryLimitBytes }
			: {}),
		...(input.context.modules !== undefined
			? { modules: input.context.modules }
			: {}),
		...(input.context.mountFs !== undefined
			? { mountFs: input.context.mountFs }
			: {}),
		...(governed
			? {
					// No budget wrapper here: the call goes through `invoker`, which charges it as the
					// nested tool call it now is. Charging again would bill one request twice.
					fetchAdapter: (target: unknown, init?: unknown) =>
						governed(target as string | { readonly href: string }, init),
				}
			: {}),
	};

	let output: unknown;
	let fsTree: VolumeTree | undefined;
	try {
		({ output, fsTree } = await input.sandbox.execute({
			code,
			invoker,
			context,
		}));
	} finally {
		outstanding.abort();
	}
	const valid = executionResult(output);
	if (valid instanceof type.errors) {
		throw validationError("sandbox execution result invalid", valid.summary, {
			provider: input.sandbox.provider,
		});
	}
	return fsTree !== undefined ? { output: valid, fsTree } : { output: valid };
}
