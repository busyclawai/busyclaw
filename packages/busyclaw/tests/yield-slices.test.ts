import { govern, userPrincipal } from "@busyclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { createRunCheckpointStore } from "@busyclaw/storage-durable";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	durableRedactor,
	type MockModel,
	owned,
	type V2Model,
} from "./fixtures";

/** Tool-calls for `toolSteps` model turns, then finishes with text — a run too long for one slice. */
function multiStepModel(toolSteps: number): MockModel {
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
				ping: govern(
					tool({
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
					// A ping is a read. Unstamped now means WRITE, which the floor gates.
					{ access: "read" },
				),
			},
		});
		const cronTask = claw.$context.plugins?.find(
			(plugin) => plugin.id === "engine-sql",
		)?.cron?.[0];
		if (!cronTask) throw new Error("expected engine-sql cron task");

		const run = await claw.api.startRun({
			prompt: "email alice@personal.com",
		});

		// Invocation 1: slice runs step 0, yields, and the drain stops claiming past the budget.
		const first = await cronTask.handler({ claw: {} });
		expect(first).toMatchObject({ processed: 1, status: "idle" });
		// getRun/listRunEvents are owner-isolated (app-authz slice 5): read the run AS its principal.
		await expect(
			claw.api.getRun({ id: run.id }, { principal: userPrincipal("actor-1") }),
		).resolves.toMatchObject({
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

		await expect(
			claw.api.getRun({ id: run.id }, { principal: userPrincipal("actor-1") }),
		).resolves.toMatchObject({
			status: "completed",
			principal: userPrincipal("actor-1"),
		});
		expect(toolRuns).toBe(2); // each step executed exactly once across all slices

		const events = await claw.api.listRunEvents(
			{ runId: run.id },
			{ principal: userPrincipal("actor-1") },
		);
		expect(events.map((event) => event.type)).toEqual([
			"run.started",
			"run.yielded",
			"run.started",
			"run.yielded",
			"run.started",
			"run.completed",
		]);

		// EACH CHECKPOINT WAS CONSUMED, AND ONLY THE LAST ONE SURVIVES (hazard P3(a)).
		//
		// This used to assert both rows were still there, `consumed`, which was true and was the
		// problem: every departure minted a permanent full-transcript checkpoint and nothing collected
		// any of them. `complete` now drops what the run has moved past, so a three-slice run leaves
		// one row rather than three copies of a growing conversation.
		const checkpoints = createRunCheckpointStore(db);
		const yieldedEvents = events.filter(
			(event) => event.type === "run.yielded",
		);
		expect(yieldedEvents).toHaveLength(2);
		const checkpointIds = yieldedEvents.map((event) => {
			const id = event.payload.checkpointId;
			if (typeof id !== "string")
				throw new Error("expected checkpointId in run.yielded payload");
			return id;
		});
		// The first is gone — superseded by the second, which the slice that consumed it had already
		// written before it retired its own.
		expect(await checkpoints.get(checkpointIds[0] as string)).toBeNull();
		expect(await checkpoints.get(checkpointIds[1] as string)).toMatchObject({
			status: "consumed",
			runId: run.id,
		});
		expect(
			await db.findMany({ model: "run_checkpoint", where: [] }),
		).toHaveLength(1);
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
				ping: govern(
					tool({
						description: "Ping.",
						inputSchema: jsonSchema<{ n: number }>({
							type: "object",
							properties: { n: { type: "number" } },
							required: ["n"],
						}),
						execute: async ({ n }) => ({ pong: n }), // fast tool — clock never moves
					}),
					// A ping is a read. Unstamped now means WRITE, which the floor gates.
					{ access: "read" },
				),
			},
		});
		const cronTask = claw.$context.plugins?.find(
			(plugin) => plugin.id === "engine-sql",
		)?.cron?.[0];
		if (!cronTask) throw new Error("expected engine-sql cron task");

		// The run's principal matches the owned caller (user:actor-1), so the owner-isolated getRun/
		// listRunEvents (app-authz slice 5) permit the reads below.
		const run = await claw.api.startRun({
			prompt: "hello",
			run: { principal: userPrincipal("actor-1") },
		});
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
