import type {
	Adapter,
	BusyclawPlugin,
	Detector,
	PiiSpan,
	ToolDefinition,
	ToolGovernance,
} from "@busyclaw/contracts";
import { govern } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import {
	createApprovalStore,
	createEffectStore,
	createPiiMappingStore,
	createRunCheckpointStore,
} from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import type { ClawSendResult, RuntimeResult } from "../src/index";
import { createClaw } from "../src/index";

export type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];
/**
 * The V4 member of that union — what every fixture here actually builds.
 *
 * `V2Model` is `V2 | V3 | V4`, so a spread-and-override of `doGenerate` has no single call signature
 * to check against: `options` lands as `any` and the return type widens to the union, which then
 * fails the model gate at `createClaw` with an error about a missing model. Narrowing says which one
 * these mocks are.
 */
export type MockModel = Extract<V2Model, { specificationVersion: "v4" }>;

export const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			kind: "email",
			source: "regex",
			value,
		});
	}
	return spans;
};

export function textModel(
	text: string,
	options: { modelId?: string } = {},
): MockModel {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: options.modelId ?? "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
			warnings: [],
		}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

/**
 * A STRICT-mode model that emits an address it was never given — the model volunteering PII it holds
 * from training, or reassembles from fragments the ingress detector missed. The prompt is fully
 * tokenized, so this is output-side PII with no mapping behind it.
 */
export function volunteersPiiModel(email: string): MockModel {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [
				{ type: "text" as const, text: `You can reach them at ${email}` },
			],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
			warnings: [],
		}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

/**
 * Calls `lookup` once with no arguments, then finishes. Pairs with `lookupTool` to make PII enter a
 * run through a tool RESULT — the path the RUNTIME redacts (and therefore the namespace the runtime
 * mints into), as opposed to a user message, which the api has already tokenized before the run.
 */
export function lookupToolModel(): MockModel {
	let step = 0;
	const usage = {
		inputTokens: {
			total: 1,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: undefined, reasoning: undefined },
	};
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			if (step++ === 0) {
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: "lookup-1",
							toolName: "lookup",
							input: "{}",
						},
					],
					finishReason: { unified: "tool-calls" as const, raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text" as const, text: "done" }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

/** Returns an address the run had never seen — PII born INSIDE the run, in a tool result. */
export function lookupTool(email: string): ToolDefinition {
	return govern(
		tool({
			description: "Look up a contact.",
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
			}),
			execute: async () => ({ email }),
		}),
		// A lookup IS a read, and now has to say so: an unstamped tool is classed a WRITE, which under
		// the seeded posture needs confirmation. This used to pass `{}` and run ungoverned.
		{ access: "read" },
	);
}

export function approvalToolModel(): MockModel {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const usage = {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			};
			if (step++ === 0) {
				const promptText = JSON.stringify(options.prompt);
				const token =
					promptText.match(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/)?.[0] ?? "NOTOKEN";
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "send_email",
							input: JSON.stringify({ to: token }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop", raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

export function emailTool(
	input: {
		onExecute: (to: string) => unknown | Promise<unknown>;
	},
	governance: ToolGovernance = {},
	// Explicit annotation: the inferred type reaches into `ai` internals that aren't exported
	// (non-portable under vitest typecheck on v7).
): ToolDefinition {
	return govern(
		tool({
			description: "Send email.",
			inputSchema: jsonSchema<{ to: string }>({
				type: "object",
				properties: { to: { type: "string" } },
				required: ["to"],
			}),
			execute: async ({ to }) => input.onExecute(to),
		}),
		{ access: "write", ...governance },
	);
}

/**
 * The three durable ports a runtime needs, built over one adapter.
 *
 * `createRuntime` no longer constructs these from a `database` field — it takes the ports, and the
 * assembly (`createClaw`) does the wiring for real hosts. A suite that drives `createRuntime`
 * DIRECTLY is the other caller, so it wires them the same way rather than rediscovering that an
 * unsupplied checkpoint store means the loop cannot yield.
 *
 * `now` is threaded deliberately: the checkpoint store stamps its own rows, so a suite on a fake
 * clock must hand the SAME clock to both halves or its checkpoints carry wall-clock timestamps while
 * its run carries frozen ones.
 */
export function durableStores(
	adapter: Adapter,
	options?: { now?: () => string },
) {
	return {
		approvalStore: createApprovalStore(adapter),
		effectStore: createEffectStore(adapter),
		checkpoints: createRunCheckpointStore(
			adapter,
			options?.now ? { now: options.now } : undefined,
		),
	};
}

export function durableRedactor(db = memoryAdapter()) {
	return {
		db,
		redactor: createStoredRedactor({
			detector: emailDetector,
			mappings: createPiiMappingStore(db),
		}),
	};
}

function bindCaller(api: object, principal: string): object {
	return new Proxy(api, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value === "function") {
				// The app-authz caller rides at arg index 1, beside the single domain input — inject the
				// fixed principal when the test didn't pass one (its existing `method(input)` calls).
				return (...args: unknown[]) =>
					(value as (...a: unknown[]) => unknown).call(
						target,
						args[0],
						args[1] ?? { principal },
					);
			}
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value)
			) {
				return bindCaller(value, principal);
			}
			return value;
		},
	});
}

/**
 * Bind a fixed caller principal onto every governed `claw.api` call (flat + nested plugin namespaces)
 * so a test's existing `claw.api.method(input)` calls satisfy the app-authz principal floor without a
 * per-call edit. Pass the claw's `createdBy` so the owner rule permits its claw-scoped reads/writes.
 */
export function withPrincipal<T extends { readonly api: object }>(
	claw: T,
	principal: string,
): T {
	return new Proxy(claw, {
		get(target, prop, receiver) {
			if (prop === "api") {
				return bindCaller(Reflect.get(target, prop, receiver), principal);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

/** `createClaw` + a bound `user:actor-1` owner caller in one — for the common test whose api calls all
 *  act as the claw owner. `owned(config).api.method(input)` reads exactly like the pre-PEP call. */
export const owned: typeof createClaw = (config) =>
	withPrincipal(createClaw(config), "user:actor-1");

/**
 * A plugin whose only contribution is a policy slice permitting writes — the explicit way for a test
 * to say "the floor is not what I am exercising here".
 *
 * The floor sees every tool call now and classes a write as needing confirmation, so a suite about
 * something ELSE — event ordering, log lines, observer wiring — would otherwise park on an approval
 * it does not care about. `emailTool` genuinely IS a write, so the honest move is to permit it
 * loudly here rather than relabel it a read at the call site: a test that stamps `access: "read"` on
 * a tool that sends email has hidden the same hole one layer up, where the next reader cannot see it.
 *
 * It permits the `writes` GROUP and nothing else. The floor's sealed forbids still outrank it, and a
 * tool's OWN gate still runs — so this exempts a suite from the floor, never from governance.
 */
export const floorPermitsWrites = {
	id: "test:permit-writes",
	policies: [
		{
			name: "test:permit-writes",
			cedar: `permit(principal, action in Action::"writes", resource);`,
			mode: "enforce",
			// The TOOL floor — this exempts a suite from the agent-side floor and says nothing about
			// who may call the product api. Before planes existed it silently did both (R-H04).
			plane: "tool",
		},
	],
} satisfies BusyclawPlugin;

/**
 * The RESULT arm of a `sendMessage` outcome, or a failure naming what came back instead.
 *
 * `ClawSendResult` became a union when a chat turn became a durable run: a concurrent replica may
 * own the task, or this driver may have lost its lease, and neither of those has a result to report.
 * A test that wants the answer is asserting the driven arm, so it should say so — and fail loudly
 * naming the other arm rather than reading `undefined` off it and reporting some later mismatch.
 */
export function drivenResult(sent: ClawSendResult): RuntimeResult {
	if (!sent.driven) {
		throw new Error(
			`expected a driven send, got driven:false (${sent.reason}) for run ${sent.runId}`,
		);
	}
	return sent.result;
}

/**
 * A model that really streams: one `text-delta` per word. `textModel` throws on `doStream`, so any
 * suite exercising the streaming door — or the run stream behind it — needs this instead.
 */
export function streamingModel(text: string): MockModel {
	const usage = {
		inputTokens: {
			total: 1,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: undefined, reasoning: undefined },
	};
	const words = text.split(" ");
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock-streaming",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text" as const, text }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage,
			warnings: [],
		}),
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "text-start", id: "0" });
					words.forEach((word, index) => {
						controller.enqueue({
							type: "text-delta",
							id: "0",
							delta: index === 0 ? word : ` ${word}`,
						});
					});
					controller.enqueue({ type: "text-end", id: "0" });
					controller.enqueue({
						type: "finish",
						finishReason: { unified: "stop", raw: undefined },
						usage,
					});
					controller.close();
				},
			}),
			warnings: [],
		}),
	} as unknown as MockModel;
}
