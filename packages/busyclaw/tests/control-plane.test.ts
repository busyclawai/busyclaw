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

describe("run control plane — stop", () => {
	// The first writer of `cancelled` in the repo. The status has been in the enum since the engine
	// was written and no code path has ever set it, so "cancel" has until now meant "hope".
	it("stops a run mid-flight, writes cancelled, and keeps the transcript", async () => {
		let stopFrom: (() => Promise<void>) | undefined;
		const h = harness({
			toolSteps: 3,
			onTool: async (n) => {
				if (n === 1) await stopFrom?.();
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });
		stopFrom = async () => {
			await h.engine.controlRun({
				runId: run.id,
				intent: "stop",
				requestedBy: userPrincipal("operator"),
				reason: "runaway",
			});
		};

		expect((await h.engine.work()).status).toBe("parked");
		const stopped = await h.store.getRun(run.id);
		expect(stopped?.status).toBe("cancelled");
		// Terminal, so there is no wait to explain — but the checkpoint stays, because it is the
		// forensic record of what the run did and the one path back if the stop was a mistake.
		expect(stopped?.waitReason).toBeUndefined();
		if (stopped?.resumeCheckpointId === undefined) {
			throw new Error("expected the transcript to be kept");
		}
		expect(
			(await h.runtime.checkpoints?.get(stopped.resumeCheckpointId))?.status,
		).toBe("pending");

		// No further slice runs on any host: nothing pending, and the fence refuses a fresh claim.
		expect((await h.engine.work()).status).toBe("idle");
		expect(h.toolRuns()).toBe(1);

		const cancelled = (await h.store.events(run.id)).filter(
			(event) => event.type === "run.cancelled",
		);
		expect(cancelled).toHaveLength(1);
		// WHO stopped it survives the transaction that erases the latch it was read from.
		expect(cancelled[0]?.payload).toMatchObject({
			requestedBy: userPrincipal("operator"),
		});
	});

	it("a stop with nothing in flight settles as cancelled immediately", async () => {
		const h = harness({ toolSteps: 1 });
		const run = await h.engine.startRun({ prompt: "go" });

		expect(
			await h.engine.controlRun({
				runId: run.id,
				intent: "stop",
				requestedBy: userPrincipal("operator"),
			}),
		).toEqual({ accepted: true, settled: true });
		expect((await h.store.getRun(run.id))?.status).toBe("cancelled");
		expect((await h.engine.work()).status).toBe("idle");
		expect(h.toolRuns()).toBe(0);
	});

	// NOT a race, and the name says so: the stop is latched during step 0, so the control point at
	// the top of step 1 sees it and the run never reaches its completion at all. What this pins is
	// that ONE terminal status is written and the event stream agrees with it — the genuine race
	// (a stop landing after the final control point but before the worker's terminal transaction) is
	// not deterministically constructible from a tool, and is covered instead by the CAS itself:
	// every terminal write in the worker now goes through `updateRunIfStatus`, and the loser reads
	// the row back rather than relabelling it.
	it("a stop latched mid-run wins, and the events agree with the status", async () => {
		const h = harness({
			toolSteps: 1,
			// Fired from inside the LAST tool call, so the stop lands while the final step is still
			// running and both writers are genuinely in flight.
			onTool: async () => {
				await h.engine.controlRun({
					runId: raced,
					intent: "stop",
					requestedBy: userPrincipal("operator"),
				});
			},
		});
		let raced = "";
		const run = await h.engine.startRun({ prompt: "go" });
		raced = run.id;

		await h.engine.work();
		const final = await h.store.getRun(run.id);
		// One answer, and it is a terminal one.
		expect(["cancelled", "completed"]).toContain(final?.status);

		// …and the events agree with it rather than telling the other story.
		const terminalEvents = (await h.store.events(run.id))
			.map((event) => event.type)
			.filter((type) => type === "run.completed" || type === "run.cancelled");
		expect(terminalEvents).toHaveLength(1);
		expect(terminalEvents[0]).toBe(
			final?.status === "cancelled" ? "run.cancelled" : "run.completed",
		);
	});
});

describe("run control plane — abort", () => {
	/** A model that never resolves until its own AbortSignal fires — the only way to prove an abort
	 *  reached the PROVIDER rather than merely being noticed by the loop one step later. */
	function hangingModel(onAbort: () => void): RuntimeModel {
		return {
			specificationVersion: "v4",
			provider: "mock",
			modelId: "mock",
			supportedUrls: {},
			doGenerate: async (options: { abortSignal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					const signal = options.abortSignal;
					if (!signal) throw new Error("no abort signal reached the model");
					signal.addEventListener("abort", () => {
						onAbort();
						reject(new Error("aborted"));
					});
				}),
			doStream: async () => {
				throw new Error("stream not used");
			},
		} as RuntimeModel;
	}

	// Bounded explicitly. Without the heartbeat's latch read this test does not fail an assertion, it
	// HANGS — the model never resolves and nothing ever fires the signal. A hang reads as a broken
	// runner rather than a broken mechanism, so the timeout is what turns the negative case into a
	// report somebody can act on.
	it("tears down an in-flight model call and records the run cancelled, not failed", async () => {
		const { db, redactor } = durableRedactor();
		const store = createSqlEngineStore(db);
		let providerSawAbort = false;
		const runtime = createRuntime({
			model: hangingModel(() => {
				providerSawAbort = true;
			}),
			database: db,
			redactor,
		});
		// A short lease so the heartbeat — which is what observes the latch — ticks promptly.
		const { engine } = sqlEngine({
			store,
			workerId: "worker-1",
			leaseTtlMs: 600,
		}).create(runtime);

		const run = await engine.startRun({ prompt: "go" });
		// Latched BEFORE the claim, so the very first heartbeat of the slice sees it. The run is
		// `queued`, so this settles synchronously — which is not what we want to test, so drive the
		// run to `running` first by claiming it, then latch.
		const tick = engine.work();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await engine.controlRun({
			runId: run.id,
			intent: "abort",
			requestedBy: userPrincipal("operator"),
		});

		const result = await tick;
		// THE assertion that matters: the provider's own signal fired. A cooperative stop would have
		// left this false and simply never returned.
		expect(providerSawAbort).toBe(true);
		expect(result.status).toBe("cancelled");

		const aborted = await store.getRun(run.id);
		expect(aborted?.status).toBe("cancelled"); // NOT failed
		const events = (await store.events(run.id)).filter(
			(event) => event.type === "run.cancelled",
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({
			reason: "aborted",
			requestedBy: userPrincipal("operator"),
		});
		// A genuine failure still reads as one — the two paths do not collapse.
		expect(
			(await store.events(run.id)).some((event) => event.type === "run.failed"),
		).toBe(false);
	}, 15_000);
});

describe("run control plane — a stop while awaiting approval", () => {
	/** Calls a tool the floor will gate, so the run parks on an approval rather than finishing. */
	function approvalSeekingModel(): RuntimeModel {
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
			doGenerate: async () =>
				call++ === 0
					? {
							content: [
								{
									type: "tool-call" as const,
									toolCallId: "c1",
									toolName: "ping",
									input: JSON.stringify({ n: 1 }),
								},
							],
							finishReason: { unified: "tool-calls" as const, raw: undefined },
							usage,
							warnings: [],
						}
					: {
							content: [{ type: "text" as const, text: "done" }],
							finishReason: { unified: "stop" as const, raw: undefined },
							usage,
							warnings: [],
						},
			doStream: async () => {
				throw new Error("stream not used");
			},
		} as RuntimeModel;
	}

	// `waiting_approval` returns from inside the tool loop, so it never reaches the loop-top control
	// site. Without this branch a stop sits latched until a human decides an approval for an action
	// that is never going to run — waiting on a decision that cannot matter.
	it("cancels rather than waiting for a decision that cannot matter", async () => {
		const { db, redactor } = durableRedactor();
		const store = createSqlEngineStore(db);
		const claw = owned({
			cronHandler: false,
			database: db,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: approvalSeekingModel(),
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
						execute: async ({ n }) => ({ pong: n }),
					}),
					{},
				),
			},
		});

		const run = await claw.api.startRun({ prompt: "go" });
		// The floor gates the unconfirmed autonomous write, so this slice parks on an approval.
		const parked = await claw.$context.engine?.work?.();
		expect((parked as { status?: string } | undefined)?.status).toBe(
			"waiting_approval",
		);
		expect((await store.getRun(run.id))?.status).toBe("waiting");

		// A stop, while the run sits on that approval and nothing is in flight.
		await claw.api.controlRun({ runId: run.id, intent: "stop" });

		// It is honoured by the SYNCHRONOUS branch — the run is `waiting`, so there is no holder to
		// observe a latch, and leaving it parked would be the hang this test exists to prevent.
		const stopped = await store.getRun(run.id);
		expect(stopped?.status).toBe("cancelled");
		expect(
			(await store.events(run.id)).some(
				(event) => event.type === "run.cancelled",
			),
		).toBe(true);
	});
});

describe("run control plane — the inbox: admit", () => {
	it("admits a message, mints a per-run seq, and is exactly-once", async () => {
		const h = harness({ toolSteps: 1 });
		const run = await h.engine.startRun({ prompt: "go" });

		const first = await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "hello" },
			mode: "next_step",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});
		expect(first).toMatchObject({ admitted: true, seq: 1 });

		// A REDELIVERY. The id is derived from (run, sender, key), so the duplicate loses at the
		// database rather than appearing twice in somebody's context window.
		const repeat = await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "hello" },
			mode: "next_step",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});
		expect(repeat.admitted).toBe(false);
		expect(repeat.id).toBe(first.id);

		// A genuinely different message is different work and gets its own row and its own place in
		// the run's order.
		const second = await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "again" },
			mode: "next_step",
			sender: userPrincipal("operator"),
			idempotencyKey: "k2",
		});
		expect(second.admitted).toBe(true);
		expect(second.seq).toBeGreaterThan(first.seq);

		const rows = await h.db.findMany({
			model: "run_message",
			where: [{ field: "toRunId", value: run.id }],
		});
		expect(rows).toHaveLength(2);
	});

	// The obvious shape — read the run, check it is not terminal, then insert — loses the race with a
	// terminal transition committing elsewhere. The admit already has to touch the run row to mint
	// `seq`, so that conditional write IS the guard and there is no window between them.
	it("bounces a message to a terminal run instead of queueing against a corpse", async () => {
		const h = harness({ toolSteps: 0 });
		const run = await h.engine.startRun({ prompt: "go" });
		expect((await h.engine.work()).status).toBe("completed");

		const bounced = await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "too late" },
			mode: "next_step",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});
		expect(bounced).toMatchObject({ admitted: false, bounced: "completed" });

		// Nothing was written. A message queued against a finished run is a message nobody will ever
		// read, and it would sit there looking like pending work.
		const rows = await h.db.findMany({
			model: "run_message",
			where: [{ field: "toRunId", value: run.id }],
		});
		expect(rows).toHaveLength(0);
	});

	it("bounces a cancelled run too, not just a completed one", async () => {
		const h = harness({ toolSteps: 1 });
		const run = await h.engine.startRun({ prompt: "go" });
		await h.engine.controlRun({
			runId: run.id,
			intent: "stop",
			requestedBy: userPrincipal("operator"),
		});
		expect((await h.store.getRun(run.id))?.status).toBe("cancelled");

		expect(
			await h.engine.deliverMessage({
				toRunId: run.id,
				body: { text: "hi" },
				mode: "next_step",
				sender: userPrincipal("operator"),
				idempotencyKey: "k1",
			}),
		).toMatchObject({ admitted: false, bounced: "cancelled" });
	});

	// The seq mint is a CAS-retry, because the Adapter port takes literal values only — there is no
	// `col = col + 1`, so a read-modify-write loses bumps the moment two admits overlap.
	it("mints a distinct seq for every message under concurrent admits", async () => {
		const h = harness({ toolSteps: 1 });
		const run = await h.engine.startRun({ prompt: "go" });

		const admitted = await Promise.all(
			Array.from({ length: 6 }, (_unused, i) =>
				h.engine.deliverMessage({
					toRunId: run.id,
					body: { text: `m${i}` },
					mode: "next_step",
					sender: userPrincipal("operator"),
					idempotencyKey: `k${i}`,
				}),
			),
		);
		expect(admitted.every((result) => result.admitted)).toBe(true);
		const seqs = admitted.map((result) => result.seq).sort((a, b) => a - b);
		expect(new Set(seqs).size).toBe(6); // no two messages share a place in the order
	});
});
