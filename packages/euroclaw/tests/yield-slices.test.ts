import { createSqlEngineStore, sqlEngine } from "@euroclaw/engine-sql";
import { createRunCheckpointStore } from "@euroclaw/storage-durable";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, owned, type V2Model } from "./fixtures";

/** Tool-calls for `toolSteps` model turns, then finishes with text — a run too long for one slice. */
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

describe("createClaw deadline slicing", () => {
	it("completes a long run as a chain of cron invocations, one slice each", async () => {
		const { db, redactor } = durableRedactor();
		let clock = 0;
		const now = () => iso(clock);
		const store = createSqlEngineStore(db, { now });
		let toolRuns = 0;
		const claw = owned({
			cronHandler: { secret: "s3cret" },
			database: db,
			effectLeaseTtlMs: 600_000,
			engine: sqlEngine({
				// leaseTtl outlives the simulated clock jumps — heartbeats renew in real time, but the
				// injected test clock leaps 100s per tool call.
				leaseTtlMs: 600_000,
				softDeadlineMs: 50_000,
				store,
				workerId: "worker-1",
			}),
			environment: { now },
			model: multiStepModel(2),
			redaction: { redactor },
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
						clock += 100_000; // every tool call burns past the 50s soft deadline
						return { pong: n };
					},
				}),
			},
		});
		const cronTask = claw.$context.plugins?.find(
			(plugin) => plugin.id === "engine-sql",
		)?.cron?.[0];
		if (!cronTask) throw new Error("expected engine-sql cron task");

		const run = await claw.api.startRun({
			prompt: "email alice@personal.com",
			run: { principal: "user:alice" },
		});

		// Invocation 1: slice runs step 0, yields, and the drain stops claiming past the budget.
		const first = await cronTask.handler({ claw: {} });
		expect(first).toMatchObject({ processed: 1, status: "idle" });
		await expect(claw.api.getRun({ id: run.id })).resolves.toMatchObject({
			status: "queued",
		});
		expect(toolRuns).toBe(1);
		clock += 1_000; // next cron firing

		// Invocation 2: fresh budget, resumes from the checkpoint, runs step 1, yields again.
		const second = await cronTask.handler({ claw: {} });
		expect(second).toMatchObject({ processed: 1, status: "idle" });
		expect(toolRuns).toBe(2);
		clock += 1_000;

		// Invocation 3: resumes and finishes — no tool call left, so no clock jump.
		const third = await cronTask.handler({ claw: {} });
		expect(third).toMatchObject({ processed: 1, status: "idle" });

		await expect(claw.api.getRun({ id: run.id })).resolves.toMatchObject({
			status: "completed",
			principal: "user:alice",
		});
		expect(toolRuns).toBe(2); // each step executed exactly once across all slices

		const events = await claw.api.listRunEvents({ runId: run.id });
		expect(events.map((event) => event.type)).toEqual([
			"run.started",
			"run.yielded",
			"run.started",
			"run.yielded",
			"run.started",
			"run.completed",
		]);

		// Both parked checkpoints were consumed exactly once by their continuations.
		const checkpoints = createRunCheckpointStore(db);
		const yieldedEvents = events.filter(
			(event) => event.type === "run.yielded",
		);
		expect(yieldedEvents).toHaveLength(2);
		for (const event of yieldedEvents) {
			const checkpointId = event.payload.checkpointId;
			if (typeof checkpointId !== "string")
				throw new Error("expected checkpointId in run.yielded payload");
			await expect(checkpoints.get(checkpointId)).resolves.toMatchObject({
				status: "consumed",
				runId: run.id,
			});
		}
	});

	it("runs to completion in one invocation when the deadline is never hit", async () => {
		const { db, redactor } = durableRedactor();
		const clock = 0;
		const now = () => iso(clock);
		const store = createSqlEngineStore(db, { now });
		const claw = owned({
			cronHandler: { secret: "s3cret" },
			database: db,
			engine: sqlEngine({
				softDeadlineMs: 50_000,
				store,
				workerId: "worker-1",
			}),
			environment: { now },
			model: multiStepModel(2),
			redaction: { redactor },
			tools: {
				ping: tool({
					description: "Ping.",
					inputSchema: jsonSchema<{ n: number }>({
						type: "object",
						properties: { n: { type: "number" } },
						required: ["n"],
					}),
					execute: async ({ n }) => ({ pong: n }), // fast tool — clock never moves
				}),
			},
		});
		const cronTask = claw.$context.plugins?.find(
			(plugin) => plugin.id === "engine-sql",
		)?.cron?.[0];
		if (!cronTask) throw new Error("expected engine-sql cron task");

		const run = await claw.api.startRun({ prompt: "hello" });
		const result = await cronTask.handler({ claw: {} });

		expect(result).toMatchObject({ processed: 1, status: "idle" });
		await expect(claw.api.getRun({ id: run.id })).resolves.toMatchObject({
			status: "completed",
		});
		const events = await claw.api.listRunEvents({ runId: run.id });
		expect(events.map((event) => event.type)).toEqual([
			"run.started",
			"run.completed",
		]);
	});
});
