// The shared, provider-agnostic execution engine: code normalization, invoker wrapping (input
// validation + defect opacity), and result validation. Providers implement isolate mechanics only.

import { validationError } from "@busyclaw/contracts";
import { type } from "arktype";
import {
	type ExecutionContext,
	executionResult,
	type Sandbox,
	type SandboxExecution,
	type SandboxToolInvoker,
	sandboxInvokeInput,
} from "./contracts";

/** Reason code for a malformed invoke shape coming out of sandboxed code. */
const SANDBOX_INVOKE_INVALID = "SANDBOX_INVOKE_INVALID";

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
function wrapInvoker(invoker: SandboxToolInvoker): SandboxToolInvoker {
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
			try {
				return await invoker.invoke(valid);
			} catch (error) {
				const id = host.crypto.randomUUID();
				host.console.error(
					`[sandboxes] internal invoker defect [${id}]`,
					error,
				);
				return { status: "error", error: `internal sandbox error [${id}]` };
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
	const invoker = wrapInvoker(input.invoker);
	const { output, fsTree } = await input.sandbox.execute({
		code,
		invoker,
		context: input.context,
	});
	const valid = executionResult(output);
	if (valid instanceof type.errors) {
		throw validationError("sandbox execution result invalid", valid.summary, {
			provider: input.sandbox.provider,
		});
	}
	return fsTree !== undefined ? { output: valid, fsTree } : { output: valid };
}
