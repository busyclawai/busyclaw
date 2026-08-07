// A capability stops the run to wait on something outside it.
//
// The fifth way a run can stop was built with no way to reach it: the result variant, the event and
// the worker branch all landed, and nothing could produce one. This is the producer — a capability
// asks, the loop parks at the next step boundary, and the token it carries out is the only thing that
// will ever bring the run back.
//
// The two properties worth having tests for are both about WHERE the park happens, not whether it
// does. It must be at a step boundary (or the checkpoint holds an outstanding tool call), and it must
// lose to an operator's stop (or "cancel this run" waits on a subagent that may never finish).

import type { Adapter } from "@busyclaw/contracts";
import { govern, userPrincipal } from "@busyclaw/contracts";
import { createMemoryAudit, createStoredRedactor } from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, runtimeRunOptionsWithCaller } from "../src/index";
import { durableStores } from "./durable-stores";

/** A checkpoint persists redacted text, so the runtime refuses one without a mapping that outlives
 *  the process. Nothing here is about PII; this is the price of having somewhere to park. */
const durableRedactor = (adapter: Adapter) =>
	createStoredRedactor({
		detector: () => [],
		mappings: createPiiMappingStore(adapter),
	});

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/** Calls `toolName` on step 0, says something on every step after. */
function callsThenTalks(toolName: string): V2Model {
	let step = 0;
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
							type: "tool-call",
							toolCallId: "call-1",
							toolName,
							input: "{}",
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "carried on" }],
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

/** A claw whose one tool arms a wait through the capability seam. */
function harness(options?: {
	waitId?: string;
	control?: { park?: "suspended" | "stopped" };
}) {
	const adapter = memoryAdapter();
	const stores = durableStores(adapter);
	const runtime = createRuntime({
		model: callsThenTalks("park"),
		audit: createMemoryAudit(),
		checkpoints: stores.checkpoints,
		redactor: durableRedactor(adapter),
		approvals: stores.approvalStore,
		capabilities: {
			agent: (ctx) => ({
				wait: () => {
					if (ctx.requestAwait === undefined) {
						throw new Error("no loop to park");
					}
					ctx.requestAwait(options?.waitId ?? "wait-1");
				},
			}),
		},
		tools: {
			park: govern(
				tool({
					description: "Arms a wait.",
					inputSchema: jsonSchema({ type: "object" }),
					execute: async (_args, opts) => {
						(
							opts as unknown as Record<string, { wait: () => void }>
						).agent?.wait();
						return { armed: true };
					},
				}),
				{ capability: "agent" },
			),
		},
	});
	return { runtime, checkpoints: stores.checkpoints };
}

describe("a capability parks its run", () => {
	it("stops the run `awaiting`, carrying the token that wakes it", async () => {
		const { runtime } = harness({ waitId: "join-42" });

		const result = await runtime.generate(
			"go",
			{},
			runtimeRunOptionsWithCaller({ runId: "run-1" }, userPrincipal("alice")),
		);

		expect(result.status).toBe("awaiting");
		// The token is opaque to everything here — the runtime never interprets it — so carrying it out
		// unchanged is the whole contract. A park that dropped it would leave a run nothing can name.
		expect(result).toMatchObject({ waitId: "join-42" });
	});

	it("parks at the STEP BOUNDARY, with the tool's own result already in the transcript", async () => {
		// The placement property, and the reason this is not parked inside the tool. A checkpoint taken
		// mid-step holds a tool call with no result, so the resumed model is handed a call it never sees
		// answered. Asserted through the persisted transcript rather than through step counting: the
		// checkpoint is what a resume actually reads.
		const { runtime, checkpoints } = harness();

		const result = await runtime.generate(
			"go",
			{},
			runtimeRunOptionsWithCaller({ runId: "run-1" }, userPrincipal("alice")),
		);

		expect(result.status).toBe("awaiting");
		const checkpointId = (result as { checkpointId: string }).checkpointId;
		const record = await checkpoints.get(checkpointId);
		const messages = JSON.stringify(record?.metadata?.messages ?? []);
		// The arming call AND its result. Without the result the transcript is not a legal resume point.
		expect(messages).toContain("call-1");
		expect(messages).toContain("armed");
	});

	it("does not park a run whose capability never asked", async () => {
		// The latch is the whole mechanism, so a run that armed nothing must reach the end normally —
		// otherwise every capability tool would be parking runs by existing.
		const adapter = memoryAdapter();
		const stores = durableStores(adapter);
		const runtime = createRuntime({
			model: callsThenTalks("quiet"),
			audit: createMemoryAudit(),
			checkpoints: stores.checkpoints,
			redactor: durableRedactor(adapter),
			capabilities: { agent: () => ({}) },
			tools: {
				quiet: govern(
					tool({
						description: "Arms nothing.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async () => ({ ok: true }),
					}),
					{ capability: "agent" },
				),
			},
		});

		const result = await runtime.generate(
			"go",
			{},
			runtimeRunOptionsWithCaller({ runId: "run-1" }, userPrincipal("alice")),
		);
		expect(result.status).toBe("completed");
	});

	it("loses to an operator's stop, which arrives at the same boundary", async () => {
		// ORDER, and it is the one that matters. Both are read at the top of the step, so whichever is
		// checked first wins — and "somebody asked for this run to end" must outrank "this run chose to
		// wait", or a cancel hangs behind a subagent that may never finish.
		const adapter = memoryAdapter();
		const stores = durableStores(adapter);
		const runtime = createRuntime({
			model: callsThenTalks("park"),
			audit: createMemoryAudit(),
			checkpoints: stores.checkpoints,
			redactor: durableRedactor(adapter),
			capabilities: {
				agent: (ctx) => ({
					wait: () => ctx.requestAwait?.("wait-1"),
				}),
			},
			tools: {
				park: govern(
					tool({
						description: "Arms a wait.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async (_args, opts) => {
							(
								opts as unknown as Record<string, { wait: () => void }>
							).agent?.wait();
							return { armed: true };
						},
					}),
					{ capability: "agent" },
				),
			},
		});

		const result = await runtime.generate(
			"go",
			{},
			runtimeRunOptionsWithCaller(
				{
					runId: "run-1",
					control: {
						// Says "stop" from the second look onward — the first is the step that runs the tool.
						poll: (() => {
							let seen = 0;
							return async () =>
								seen++ === 0
									? { seq: 0 }
									: { seq: 0, park: "stopped" as const };
						})(),
					},
				},
				userPrincipal("alice"),
			),
		);

		expect(result.status).toBe("parked");
		expect(result).toMatchObject({ reason: "stopped" });
	});
});
