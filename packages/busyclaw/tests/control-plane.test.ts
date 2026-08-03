// Slice 1 of the run control plane: a run can be suspended from OUTSIDE it.
//
// Every test here fails without its mechanism. The spine test is the first one — a multi-step run
// stopped mid-flight by a caller holding a different engine handle over the same database, which is
// what "from another process" means when the only thing two hosts share is rows.

import { govern, userPrincipal } from "@busyclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { createRuntime, type RuntimeModel } from "@busyclaw/runtime";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { durableRedactor, owned } from "./fixtures";

const iso = (ms: number) => new Date(ms).toISOString();

/** Tool-calls `toolSteps` times, then answers with text — a run with more than one step to stop in. */
function multiStepModel(toolSteps: number): RuntimeModel {
	let call = 0;
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
			if (call++ < toolSteps) {
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: `c${call}`,
							toolName: "ping",
							input: JSON.stringify({ n: call }),
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
	} as RuntimeModel;
}

/** A claw-shaped fixture: one database, a runtime that can checkpoint, an engine over the same store. */
function harness(input: {
	toolSteps: number;
	onTool?: (n: number) => Promise<void> | void;
	now?: () => string;
}) {
	// A database-backed runtime requires a durable redactor — the transcript a checkpoint persists
	// must already be placeholder-clean, so there has to be something that tokenized it.
	const { db, redactor } = durableRedactor();
	const store = createSqlEngineStore(db, input.now ? { now: input.now } : {});
	let toolRuns = 0;
	const runtime = createRuntime({
		model: multiStepModel(input.toolSteps),
		database: db,
		redactor,
		// Same reason as the task lease below: a tool that advances the fake clock past the default
		// would have its EFFECT lease expire mid-call, and the run would fail for a reason that has
		// nothing to do with what these tests assert.
		effectLeaseTtlMs: 600_000,
		...(input.now ? { environment: { now: input.now } } : {}),
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
						await input.onTool?.(n);
						return { pong: n };
					},
				}),
				{},
			),
		},
	});
	// A generous lease: the deadline tests advance a fake clock by more than the 60s default INSIDE a
	// tool call, which would otherwise read as a lost lease rather than the yield being tested.
	const { engine } = sqlEngine({
		store,
		workerId: "worker-1",
		leaseTtlMs: 600_000,
	}).create(runtime);
	return {
		db,
		store,
		engine,
		runtime,
		toolRuns: () => toolRuns,
	};
}

describe("run control plane — suspend", () => {
	it("suspends a multi-step run mid-flight, from another process, and parks it", async () => {
		let suspendFrom: (() => Promise<void>) | undefined;
		const h = harness({
			toolSteps: 3,
			// Fired from INSIDE the first tool call, i.e. while the run holds its lease and is
			// unambiguously in flight. The caller is a second engine handle over the same rows.
			onTool: async (n) => {
				if (n === 1) await suspendFrom?.();
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });
		// A DIFFERENT handle over the same store — no shared memory, only the database.
		const other = sqlEngine({ store: h.store, workerId: "operator" }).create(
			createRuntime({ model: multiStepModel(0) }),
		).engine;
		suspendFrom = async () => {
			const outcome = await other.controlRun({
				runId: run.id,
				intent: "suspend",
				requestedBy: userPrincipal("operator"),
				reason: "budget review",
			});
			// The run is running, so the intent is LATCHED, not settled here.
			expect(outcome).toEqual({ accepted: true, settled: false });
		};

		const tick = await h.engine.work();
		expect(tick.status).toBe("parked");

		const parkedRun = await h.store.getRun(run.id);
		expect(parkedRun?.status).toBe("waiting");
		expect(parkedRun?.waitReason).toBe("suspended");
		expect(parkedRun?.resumeCheckpointId).toBeDefined();
		// The latch is cleared by the transaction that honours it — not before, so a crash on the way
		// here leaves the intent live for the re-run.
		expect(parkedRun?.controlRequestedAt).toBeUndefined();
		expect(parkedRun?.controlIntent).toBeUndefined();

		// NO continuation was enqueued. This single omission is the whole difference between a park
		// and a yield: a parked run does not come back on its own.
		const tasks = await h.db.findMany({
			model: "runtime_task",
			where: [
				{ field: "runId", value: run.id },
				{ field: "status", value: "pending", connector: "AND" },
			],
		});
		expect(tasks).toHaveLength(0);
		expect(await h.engine.work()).toMatchObject({ status: "idle" });

		// It stopped at a LEGAL point: the tool call it was in the middle of has its result in the
		// transcript. A park between a call and its result would be unresumable.
		if (parkedRun?.resumeCheckpointId === undefined) {
			throw new Error("expected a resume checkpoint");
		}
		// Read the row straight off the adapter rather than pulling in the durable-store package for
		// one assertion — this test cares that the transcript is THERE, not how it is fetched.
		const checkpoint = await h.db.findOne({
			model: "run_checkpoint",
			where: [{ field: "id", value: parkedRun.resumeCheckpointId }],
		});
		const transcript = JSON.stringify(checkpoint);
		expect(transcript).toContain("tool-call");
		expect(transcript).toContain("tool-result");
		expect(h.toolRuns()).toBe(1);
	});

	it("settles synchronously when nothing is in flight, and withholds the queued task", async () => {
		const h = harness({ toolSteps: 1 });
		const run = await h.engine.startRun({ prompt: "go" });

		// Never claimed, so there is no holder that could ever observe a latch. Latching and hoping
		// would be a run that waits forever.
		const outcome = await h.engine.controlRun({
			runId: run.id,
			intent: "suspend",
			requestedBy: userPrincipal("operator"),
		});
		expect(outcome).toEqual({ accepted: true, settled: true });

		const suspended = await h.store.getRun(run.id);
		expect(suspended?.status).toBe("waiting");
		expect(suspended?.waitReason).toBe("suspended");
		// The withheld task is dead, so no host anywhere can pick it up later.
		expect(await h.engine.work()).toMatchObject({ status: "idle" });
		expect(h.toolRuns()).toBe(0);
	});

	it("refuses a terminal run loudly, writing no latch and exactly one ignored event", async () => {
		const h = harness({ toolSteps: 0 });
		const run = await h.engine.startRun({ prompt: "go" });
		expect(await h.engine.work()).toMatchObject({ status: "completed" });

		const outcome = await h.engine.controlRun({
			runId: run.id,
			intent: "suspend",
			requestedBy: userPrincipal("operator"),
		});
		expect(outcome).toMatchObject({
			accepted: false,
			reason: "already-terminal",
		});

		// A latch on a finished run would poison a later operator-driven resume of a leftover
		// checkpoint, so nothing is written at all.
		const done = await h.store.getRun(run.id);
		expect(done?.status).toBe("completed");
		expect(done?.controlRequestedAt).toBeUndefined();
		expect(done?.controlIntent).toBeUndefined();

		const ignored = (await h.store.events(run.id)).filter(
			(event) => event.type === "run.control_ignored",
		);
		expect(ignored).toHaveLength(1);
	});

	it("raises the latch but never lowers it", async () => {
		const h = harness({ toolSteps: 1 });
		const run = await h.engine.startRun({ prompt: "go" });
		await h.store.updateRun(run.id, { status: "running" });

		await h.engine.controlRun({
			runId: run.id,
			intent: "suspend",
			requestedBy: userPrincipal("first"),
		});
		const raised = await h.engine.controlRun({
			runId: run.id,
			intent: "stop",
			requestedBy: userPrincipal("second"),
		});
		expect(raised).toMatchObject({ accepted: true });
		const afterRaise = await h.store.getRun(run.id);
		expect(afterRaise?.controlIntent).toBe("stop");
		// The FIRST requester's identity survives the escalation — both are in the record, and the
		// question "who asked for this run to stop" keeps its original answer.
		expect(afterRaise?.controlRequestedBy).toBe(userPrincipal("first"));

		const lowered = await h.engine.controlRun({
			runId: run.id,
			intent: "suspend",
			requestedBy: userPrincipal("third"),
		});
		expect(lowered).toMatchObject({
			accepted: false,
			reason: "already-requested",
		});
		expect((await h.store.getRun(run.id))?.controlIntent).toBe("stop");
	});

	// THE LIVELOCK REGRESSION. Moving the deadline check to the top of the loop makes it reachable on
	// a run that has done no work this slice: park at step N, resume at step N, park at step N again,
	// for as long as anyone keeps draining. Driven through the RUNTIME rather than the worker, because
	// the worker's own tick guard refuses to claim past its invocation deadline and would hide the
	// bug — the livelock belongs to the loop, so the loop is what this asks.
	it("a resume whose deadline has already passed still makes progress", async () => {
		let clock = 0;
		const h = harness({
			toolSteps: 3,
			now: () => iso(clock),
			onTool: () => {
				clock += 100_000; // every tool call lands past the soft deadline
			},
		});

		const first = await h.runtime.generate("go", undefined, {
			deadlineAt: iso(50_000),
			runId: "run-livelock",
		});
		expect(first.status).toBe("yielded");
		if (first.status !== "yielded") throw new Error("expected a yield");
		expect(h.toolRuns()).toBe(1);

		// Resumed with a deadline that is ALREADY behind us. Without `step > startStep` the loop parks
		// at the step it just resumed at, having run nothing — and every retry does the same.
		const second = await h.runtime.resumeRun(first.checkpointId, undefined, {
			deadlineAt: iso(50_000),
			runId: "run-livelock",
		});
		expect(second?.status).toBe("yielded");
		// THE assertion: a step actually ran. Zero progress here is the livelock.
		expect(h.toolRuns()).toBe(2);
		if (second?.status !== "yielded") throw new Error("expected a yield");
		expect(second.checkpointId).not.toBe(first.checkpointId);
	});
});

describe("run control plane — proceed", () => {
	// THE PAYOFF OF SLICE 1. A suspended run is only genuinely suspended if it can be brought back,
	// and until this verb existed nothing outside the engine worker could bring one back at all.
	it("resumes a suspended run from its checkpoint, finishing the work it had left", async () => {
		let suspendFrom: (() => Promise<void>) | undefined;
		const h = harness({
			toolSteps: 2,
			onTool: async (n) => {
				if (n === 1) await suspendFrom?.();
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });
		suspendFrom = async () => {
			await h.engine.controlRun({
				runId: run.id,
				intent: "suspend",
				requestedBy: userPrincipal("operator"),
			});
		};

		expect((await h.engine.work()).status).toBe("parked");
		const parked = await h.store.getRun(run.id);
		if (parked?.resumeCheckpointId === undefined) {
			throw new Error("expected a resume checkpoint");
		}
		expect(h.toolRuns()).toBe(1);

		// Back through the front door, naming the run and the record that parked it.
		const handle = await h.engine.proceedRun({
			runId: run.id,
			proceed: {
				kind: "checkpoint",
				checkpointId: parked.resumeCheckpointId,
			},
		});
		expect(handle.id).toBe(run.id); // the SAME run, not a second identity beside it
		const resumedRun = await h.store.getRun(run.id);
		expect(resumedRun?.status).toBe("queued");
		// The wait is over, so the reason for it is gone too — a stale `suspended` here would tell
		// every later reader the run is still parked.
		expect(resumedRun?.waitReason).toBeUndefined();

		expect((await h.engine.work()).status).toBe("completed");
		expect((await h.store.getRun(run.id))?.status).toBe("completed");
		// It CONTINUED rather than restarting: the first tool call is not paid for twice.
		expect(h.toolRuns()).toBe(2);
	});

	it("admits one slice however many times it is asked", async () => {
		const h = harness({ toolSteps: 1 });
		const run = await h.engine.startRun({ prompt: "go" });
		await h.store.updateRun(run.id, { status: "waiting" });

		const first = await h.engine.proceedRun({
			runId: run.id,
			proceed: { kind: "approval", approvalId: "appr-1" },
		});
		const second = await h.engine.proceedRun({
			runId: run.id,
			proceed: { kind: "approval", approvalId: "appr-1" },
		});
		expect(first).toEqual(second);

		// The insert IS the admission, so the duplicate lost at the database rather than becoming a
		// second task that could only fail and take the run's status down with it.
		const continuations = await h.db.findMany({
			model: "runtime_task",
			where: [
				{ field: "runId", value: run.id },
				{ field: "kind", value: "runtime.continueRun", connector: "AND" },
			],
		});
		expect(continuations).toHaveLength(1);
	});

	// The record↔run verification lives at the DOOR, because the door is the only layer that can read
	// a checkpoint's own runId — the engine sees an opaque id and would schedule it happily.
	it("refuses a record that belongs to a different run", async () => {
		const { db, redactor } = durableRedactor();
		const store = createSqlEngineStore(db);
		const claw = owned({
			cronHandler: false,
			database: db,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: multiStepModel(0),
			redaction: { redactor },
		});

		const mine = await claw.api.startRun({ prompt: "mine" });
		const theirs = await claw.api.startRun({ prompt: "theirs" });

		// A checkpoint carrying THEIR run id. Minted directly: how it came to exist is not what this
		// asserts, only whose it is.
		const theirCheckpoint = await claw.$context.runtime.checkpoints?.create({
			runId: theirs.id,
			metadata: {
				version: "runtime.ai-sdk.yield.v1",
				nextStep: 1,
				messages: [{ role: "user", content: "theirs" }],
			},
			createdAt: new Date().toISOString(),
		});
		expect(theirCheckpoint).toBeDefined();

		// A caller who legitimately manages BOTH runs still cannot graft one run's resume state onto
		// another. Authorization is not the question here; identity is.
		await expect(
			claw.api.proceedRun({
				runId: mine.id,
				proceed: {
					kind: "checkpoint",
					checkpointId: theirCheckpoint?.id ?? "none",
				},
			}),
		).rejects.toThrow("does not belong to the run");

		// …and a record that does not exist at all is refused too, rather than admitting a slice whose
		// only possible outcome is discovering there was nothing to resume.
		await expect(
			claw.api.proceedRun({
				runId: mine.id,
				proceed: { kind: "checkpoint", checkpointId: "no-such-checkpoint" },
			}),
		).rejects.toThrow("no such record");
	});
});

describe("run control plane — a re-claimed first slice", () => {
	// THE ORDERING CONSTRAINT, made executable. `runtime.run` carries only a prompt, so a second
	// claim used to seed the transcript from that prompt and start at step 0 — re-running every step
	// the first attempt paid for, re-executing its tool calls, and orphaning the checkpoint it wrote.
	// That is why the kind is single-attempt today; raising the counter before fixing it destroys
	// work silently, which is the worst way to lose it.
	it("continues from its checkpoint instead of re-running the whole run", async () => {
		let clock = 0;
		const h = harness({
			toolSteps: 3,
			now: () => iso(clock),
			onTool: () => {
				clock += 100_000; // burns past the soft deadline, so slice one parks
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });

		// Slice one runs a step and yields a checkpoint.
		const first = await h.engine.work({ deadlineAt: iso(50_000) });
		expect(first.status).toBe("yielded");
		if (first.status !== "yielded") throw new Error("expected a yield");
		expect(h.toolRuns()).toBe(1);

		// Now simulate the crash this exists for: the yield's self-enqueued continuation never
		// survived, and the ORIGINAL first-slice task is what comes back around. Re-admitting it by
		// hand is the same thing a lease lapse produces once the retry counter is allowed to rise.
		const resumeTasks = await h.db.findMany({
			model: "runtime_task",
			where: [
				{ field: "runId", value: run.id },
				{ field: "kind", value: "runtime.resumeRun", connector: "AND" },
			],
		});
		for (const row of resumeTasks) {
			const taskId = (row as { id?: unknown }).id;
			if (typeof taskId !== "string") continue;
			await h.db.update({
				model: "runtime_task",
				where: [{ field: "id", value: taskId }],
				update: { status: "dead" },
			});
		}
		await h.store.enqueueTask({
			runId: run.id,
			kind: "runtime.run",
			payload: { prompt: "go" },
		});

		const second = await h.engine.work({ deadlineAt: iso(clock + 50_000) });
		if (second.status === "failed") {
			throw new Error(`tick failed: ${second.reason}`);
		}

		// THE assertion, and it is about the FIRST checkpoint rather than a step count. A slice that
		// continues CONSUMES the checkpoint it resumed from; a slice that re-prompts never touches it,
		// leaving a pending row on disk that nothing will ever read again — the orphan.
		expect(second.status).toBe("yielded");
		expect((await h.runtime.checkpoints?.get(first.checkpointId))?.status).toBe(
			"consumed",
		);
		expect(h.toolRuns()).toBe(2);
	});
});
