import type { Detector, PiiSpan } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import {
	createPiiMappingStore,
	createRunCheckpointStore,
} from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, govern } from "../src/index";

const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			value,
			kind: "email",
			source: "regex",
		});
	}
	return spans;
};

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

function pingCall(toolCallId: string) {
	return {
		content: [
			{
				type: "tool-call" as const,
				toolCallId,
				toolName: "ping",
				input: JSON.stringify({ n: 1 }),
			},
		],
		finishReason: { unified: "tool-calls" as const, raw: undefined },
		usage: USAGE,
		warnings: [],
	};
}

function answer(value: string) {
	return {
		content: [{ type: "text" as const, text: value }],
		finishReason: { unified: "stop" as const, raw: undefined },
		usage: USAGE,
		warnings: [],
	};
}

function harness(model: V2Model, pings: { count: number }) {
	const db = memoryAdapter();
	return createRuntime({
		model,
		checkpoints: createRunCheckpointStore(db),
		redactor: createStoredRedactor({
			detector: emailDetector,
			mappings: createPiiMappingStore(db),
		}),
		tools: {
			ping: govern(
				tool({
					description: "Ping.",
					inputSchema: jsonSchema<{ n: number }>({
						type: "object",
						properties: { n: { type: "number" } },
						required: ["n"],
					}),
					execute: async ({ n }) => {
						pings.count++;
						return { pong: n };
					},
				}),
				{},
			),
		},
	});
}

describe("checkpoint on model failure", () => {
	// Checkpoints used to come only from `parkHere` — a deadline, a control park, a handover — so a
	// run that DIED mid-slice left nothing behind, and the worker's next claim fell through to
	// `generate` from the prompt. The transcript was on the floor; the step was paid for twice.
	it("leaves a resumable checkpoint when the model call fails mid-run", async () => {
		const pings = { count: 0 };
		let call = 0;
		const runtime = harness(
			{
				specificationVersion: "v4",
				provider: "mock",
				modelId: "mock",
				supportedUrls: {},
				doGenerate: async () => {
					call++;
					if (call === 1) return pingCall("call_1");
					if (call === 2) throw new Error("provider exploded");
					return answer("done");
				},
				doStream: async () => {
					throw new Error("stream not used");
				},
			},
			pings,
		);

		await expect(
			runtime.generate("ping then answer", undefined, { runId: "run-1" }),
		).rejects.toThrow(/provider exploded/);
		expect(pings.count).toBe(1);

		const checkpoint = await runtime.checkpoints?.latestPendingForRun("run-1");
		expect(checkpoint).not.toBeNull();
		// The FAILED step is the one to re-run — the tool result before it is already in the transcript.
		expect(checkpoint?.metadata).toMatchObject({ nextStep: 1 });

		// And it really is resumable: the run finishes from where it stopped, and the tool it already
		// ran is not run again. That last assertion is the difference between resuming and replaying.
		const resumed = checkpoint
			? await runtime.resumeRun(checkpoint.id)
			: undefined;

		expect(resumed).toMatchObject({ status: "completed", text: "done" });
		expect(pings.count).toBe(1);
	});

	// An abort is not a failure to recover from. The worker settles such a run `cancelled` and says so
	// explicitly — "an abort tears down mid-step, so there is no resumable point to record" — so a
	// checkpoint written here would be one nothing ever retires.
	it("writes no checkpoint when the run was aborted", async () => {
		const pings = { count: 0 };
		const controller = new AbortController();
		const runtime = harness(
			{
				specificationVersion: "v4",
				provider: "mock",
				modelId: "mock",
				supportedUrls: {},
				doGenerate: async () => {
					controller.abort();
					throw new Error("torn down mid-call");
				},
				doStream: async () => {
					throw new Error("stream not used");
				},
			},
			pings,
		);

		await expect(
			runtime.generate("go", undefined, {
				runId: "run-2",
				abortSignal: controller.signal,
			}),
		).rejects.toThrow();

		await expect(
			runtime.checkpoints?.latestPendingForRun("run-2"),
		).resolves.toBeNull();
	});
});
