import type { Detector, PiiSpan } from "@euroclaw/contracts";
import { createStoredRedactor } from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import {
	createPiiMappingStore,
	createRunCheckpointStore,
} from "@euroclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, type RuntimeEvent } from "../src/index";

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

/** Tool-calls for `toolSteps` model turns, then finishes with text — a multi-slice run. */
function multiStepModel(toolSteps: number): V2Model {
	let call = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			const usage = {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			};
			if (call++ < toolSteps) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: `c${call}`,
							toolName: "ping",
							input: JSON.stringify({ n: call }),
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

const iso = (ms: number) => new Date(ms).toISOString();

describe("runtime yield & resume", () => {
	it("yields at the soft deadline, resumes from the checkpoint, consume is single-use", async () => {
		const db = memoryAdapter();
		const events: RuntimeEvent[] = [];
		let clock = 0;
		let toolRuns = 0;
		const runtime = createRuntime({
			model: multiStepModel(2),
			database: db,
			environment: { now: () => iso(clock) },
			effectLeaseTtlMs: 600_000,
			events: {
				emit: async (event) => {
					events.push(event);
				},
			},
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				ping: tool({
					description: "Ping.",
					inputSchema: jsonSchema<{ n: number }>({
						type: "object",
						properties: { n: { type: "number" } },
						required: ["n"],
					}),
					execute: async ({ n }) => {
						toolRuns++;
						clock += 100_000; // each tool call burns past the soft deadline
						return { pong: n };
					},
				}),
			},
		});

		const first = await runtime.run("email alice@personal.com", undefined, {
			deadlineAt: iso(50_000),
			runId: "run-1",
		});
		expect(first.status).toBe("yielded");
		if (first.status !== "yielded") throw new Error("expected yield");
		expect(first.steps).toBe(1);
		expect(toolRuns).toBe(1);

		// The parked checkpoint: pending, run-scoped, envelope redacted (claim-check posture).
		const checkpoints = createRunCheckpointStore(db);
		const parked = await checkpoints.get(first.checkpointId);
		expect(parked?.status).toBe("pending");
		expect(parked?.runId).toBe("run-1");
		expect(JSON.stringify(parked?.metadata)).not.toContain(
			"alice@personal.com",
		);
		expect(parked?.metadata).toMatchObject({
			version: "runtime.ai-sdk.yield.v1",
			nextStep: 1,
		});

		// No deadline on the continuation — it runs to completion without re-running step 0.
		const resumed = await runtime.resumeRun(first.checkpointId);
		expect(resumed).toMatchObject({ status: "completed", text: "done" });
		expect(toolRuns).toBe(2);
		expect((await checkpoints.get(first.checkpointId))?.status).toBe(
			"consumed",
		);
		expect(await runtime.resumeRun(first.checkpointId)).toBeNull(); // single-use

		// Events carry the durable run id across slices — including the resumed slice,
		// whose runId comes from the checkpoint envelope, not the caller.
		const kinds = events.map((event) => [event.type, event.runId]);
		expect(kinds).toEqual(
			expect.arrayContaining([
				["run.started", "run-1"],
				["run.yielded", "run-1"],
				["run.completed", "run-1"],
			]),
		);
		const yielded = events.find((event) => event.type === "run.yielded");
		expect(yielded).toMatchObject({ checkpointId: first.checkpointId });
	});

	it("a continuation can yield again — slices chain", async () => {
		const db = memoryAdapter();
		let clock = 0;
		const runtime = createRuntime({
			model: multiStepModel(2),
			database: db,
			environment: { now: () => iso(clock) },
			effectLeaseTtlMs: 600_000,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				ping: tool({
					description: "Ping.",
					inputSchema: jsonSchema<{ n: number }>({
						type: "object",
						properties: { n: { type: "number" } },
						required: ["n"],
					}),
					execute: async () => {
						clock += 100_000;
						return { pong: true };
					},
				}),
			},
		});

		const first = await runtime.run("go", undefined, {
			deadlineAt: iso(50_000),
		});
		if (first.status !== "yielded") throw new Error("expected yield");

		const second = await runtime.resumeRun(first.checkpointId, undefined, {
			deadlineAt: iso(150_000),
		});
		expect(second).toMatchObject({ status: "yielded", steps: 2 });
		if (second?.status !== "yielded") throw new Error("expected yield");

		const third = await runtime.resumeRun(second.checkpointId);
		expect(third).toMatchObject({ status: "completed", text: "done" });
	});

	it("fails fast when a deadline is set without a checkpoint store", async () => {
		const runtime = createRuntime({ model: multiStepModel(0) });
		await expect(
			runtime.run("hello", undefined, { deadlineAt: iso(0) }),
		).rejects.toThrow(/run checkpoint store/);
		expect(await runtime.resumeRun("missing")).toBeNull();
	});

	it("does not yield on the final step — maxSteps exhaustion stays terminal", async () => {
		const db = memoryAdapter();
		let clock = 0;
		const runtime = createRuntime({
			model: multiStepModel(5),
			database: db,
			environment: { now: () => iso(clock) },
			effectLeaseTtlMs: 600_000,
			maxSteps: 1,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				ping: tool({
					description: "Ping.",
					inputSchema: jsonSchema<{ n: number }>({
						type: "object",
						properties: { n: { type: "number" } },
						required: ["n"],
					}),
					execute: async () => {
						clock += 100_000;
						return { pong: true };
					},
				}),
			},
		});

		await expect(
			runtime.run("go", undefined, { deadlineAt: iso(50_000) }),
		).rejects.toThrow(/maxSteps/);
	});
});
