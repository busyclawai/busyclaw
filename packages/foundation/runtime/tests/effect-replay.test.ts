import { memoryAdapter } from "@busyclaw/storage-core";
import { createEffectStore } from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, govern } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const USAGE = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

function toolCall(toolCallId: string, input: unknown) {
	return {
		content: [
			{
				type: "tool-call" as const,
				toolCallId,
				toolName: "charge_card",
				input: JSON.stringify(input),
			},
		],
		finishReason: { unified: "tool-calls" as const, raw: undefined },
		usage: USAGE,
		warnings: [],
	};
}

function text(value: string) {
	return {
		content: [{ type: "text" as const, text: value }],
		finishReason: { unified: "stop" as const, raw: undefined },
		usage: USAGE,
		warnings: [],
	};
}

/**
 * One model driving TWO runs of the same durable run id — the attempt that dies mid-flight, and the
 * attempt the engine re-claims afterwards.
 *
 * The replay emits a DIFFERENT `toolCallId` for the same logical call, because that is what a real
 * provider does: a call id is a nonce, minted per generation. That single detail is what the ledger
 * used to key on, and it is what made a re-claimed run charge the card twice.
 */
function replayedModel(calls: { count: number }): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			calls.count++;
			switch (calls.count) {
				// ── attempt 1: the effect commits, then the provider dies ──
				case 1:
					return toolCall("call_a1b2", { amount: 100, currency: "eur" });
				case 2:
					throw new Error("provider exploded");
				// ── attempt 2: the engine re-claims the task and the run starts from its prompt ──
				case 3:
					// SAME arguments, different key order. Both halves matter: the same order would not
					// prove the hash is canonical, and a different call id would not prove the id no
					// longer depends on the provider's nonce.
					return toolCall("call_z9y8", { currency: "eur", amount: 100 });
				default:
					return text("charged");
			}
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

describe("effect identity across a replayed run", () => {
	// THE REGRESSION. A run task is enqueued with maxAttempts 3, a mid-slice failure writes no
	// checkpoint, and the worker's second claim therefore falls through to `generate` from the
	// prompt — replaying every tool call the first attempt already made. The effect ledger is what
	// is supposed to stop that, and it could not: its key embedded the provider's `toolCallId`, so a
	// replay looked up an id that had never been written and admitted the charge as a first one.
	it("executes a committed effect once when the run is replayed from its prompt", async () => {
		const executed: Array<{ amount: number }> = [];
		const adapter = memoryAdapter();
		const calls = { count: 0 };
		const runtime = createRuntime({
			model: replayedModel(calls),
			effectStore: createEffectStore(adapter),
			tools: {
				charge_card: govern(
					tool({
						description: "Charge the customer's card.",
						inputSchema: jsonSchema<{ amount: number; currency: string }>({
							type: "object",
							properties: {
								amount: { type: "number" },
								currency: { type: "string" },
							},
							required: ["amount", "currency"],
						}),
						execute: async ({ amount }) => {
							executed.push({ amount });
							return { charged: amount };
						},
					}),
					{
						// The strongest declaration a tool can make — and the one the old key silently
						// downgraded to nothing across a replay.
						effect: { idempotency: "required", output: "full" },
					},
				),
			},
		});

		// Attempt 1 — the card is charged, then the provider fails the run.
		await expect(
			runtime.generate("charge the customer", undefined, { runId: "run-1" }),
		).rejects.toThrow(/provider exploded/);
		expect(executed).toEqual([{ amount: 100 }]);

		// Attempt 2 — the same durable run id, re-driven from the prompt, exactly as the worker does.
		const replay = await runtime.generate("charge the customer", undefined, {
			runId: "run-1",
		});

		expect(replay).toMatchObject({ status: "completed", text: "charged" });
		// The whole point: still ONE charge. The replayed call found its own committed record and was
		// answered from it instead of running.
		expect(executed).toEqual([{ amount: 100 }]);
	});

	// A run that genuinely calls the same tool with the same arguments twice is not a replay, and
	// must not be collapsed into one effect — which is why the step ordinal is part of the identity
	// rather than the tool and its arguments alone.
	it("does not collapse two identical calls made at different steps of one run", async () => {
		const executed: number[] = [];
		const adapter = memoryAdapter();
		let step = 0;
		const runtime = createRuntime({
			model: {
				specificationVersion: "v4",
				provider: "mock",
				modelId: "mock",
				supportedUrls: {},
				doGenerate: async () => {
					step++;
					if (step <= 2) return toolCall(`call_${step}`, { amount: 5 });
					return text("done");
				},
				doStream: async () => {
					throw new Error("stream not used");
				},
			} satisfies V2Model,
			effectStore: createEffectStore(adapter),
			tools: {
				charge_card: govern(
					tool({
						description: "Charge the customer's card.",
						inputSchema: jsonSchema<{ amount: number }>({
							type: "object",
							properties: { amount: { type: "number" } },
							required: ["amount"],
						}),
						execute: async ({ amount }) => {
							executed.push(amount);
							return { charged: amount };
						},
					}),
					{ effect: { idempotency: "required", output: "full" } },
				),
			},
		});

		const result = await runtime.generate("charge twice", undefined, {
			runId: "run-2",
		});

		expect(result).toMatchObject({ status: "completed" });
		expect(executed).toEqual([5, 5]);
	});
});
