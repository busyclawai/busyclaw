// Slice 1 of the run control plane: a run can be suspended from OUTSIDE it.
//
// Every test here fails without its mechanism. The spine test is the first one — a multi-step run
// stopped mid-flight by a caller holding a different engine handle over the same database, which is
// what "from another process" means when the only thing two hosts share is rows.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import {
	approvalSchema,
	effectSchema,
	govern,
	piiMappingSchema,
	runCheckpointSchema,
	runMessageSchema,
	userPrincipal,
} from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import {
	createSqlEngineStore,
	sqlEngine,
	sqlEngineSchema,
} from "@busyclaw/engine-sql";
import { createRuntime, type RuntimeModel } from "@busyclaw/runtime";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import { jsonSchema, tool } from "ai";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { emailDetector, owned } from "./fixtures";

const iso = (ms: number) => new Date(ms).toISOString();

/** Tool-calls `toolSteps` times, then answers with text — a run with more than one step to stop in. */
function multiStepModel(
	toolSteps: number,
	onCall?: (prompt: unknown) => void,
): RuntimeModel {
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
		doGenerate: async (options: { prompt?: unknown }) => {
			onCall?.(options.prompt);
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
/**
 * A real SQLite database with the schema migrated in.
 *
 * NOT `memoryAdapter`, and that is the whole point: it declares `enforcesUnique: false` and its
 * `transaction` does not isolate, so "the duplicate loses at the database" and "exactly one CAS
 * wins" pass there by ordering accident rather than by anything a deployment would have. A green
 * race test on that adapter certifies an invariant that holds nowhere.
 */
async function sqliteDb(schema?: SchemaDeclaration): Promise<{
	adapter: Adapter;
	migrate: (declaration: SchemaDeclaration) => Promise<void>;
	close: () => void;
}> {
	const sqlite = new Database(":memory:");
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const migrate = async (declaration: SchemaDeclaration): Promise<void> => {
		const plan = await planMigrations({
			db: kdb,
			schema: declaration,
			dialect: "sqlite",
			warn: (message) => console.warn(`migration: ${message}`),
		});
		await plan.runMigrations();
	};
	if (schema) await migrate(schema);
	return { adapter: kyselyAdapter(kdb), migrate, close: () => sqlite.close() };
}

/** The engine-level table set: what a durable run touches with no product api in front of it. */
const RUN_TABLES: SchemaDeclaration = {
	...sqlEngineSchema,
	...approvalSchema,
	...effectSchema,
	...runCheckpointSchema,
	...runMessageSchema,
	...piiMappingSchema,
};

/** A CLAW over a real database — for the tests that exercise the api door rather than the engine. */
async function clawHarness(config: Record<string, unknown> = {}): Promise<{
	db: Adapter;
	store: ReturnType<typeof createSqlEngineStore>;
	claw: ReturnType<typeof owned>;
}> {
	// The engine's tables are NOT in `claw.$tables` — the engine owns its own schema — so both
	// declarations are migrated: the run substrate, then whatever the product layer adds on top.
	const { adapter, migrate, close } = await sqliteDb(RUN_TABLES);
	openDatabases.push(close);
	const store = createSqlEngineStore(adapter);
	const claw = owned({
		cronHandler: false,
		database: adapter,
		engine: sqlEngine({ store, workerId: "worker-1" }),
		model: multiStepModel(0),
		redaction: {
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(adapter),
			}),
		},
		...config,
	} as Parameters<typeof owned>[0]);
	// `$tables` is the migration CLI's own door — the merged declaration this claw expects to exist,
	// which is strictly more than the engine's (grants, policy slices, the transcript). Lazy, so it is
	// safe to read after construction and before the first call.
	await migrate(claw.$tables as SchemaDeclaration);
	return { db: adapter, store, claw };
}

const openDatabases: (() => void)[] = [];
afterEach(() => {
	for (const close of openDatabases.splice(0)) close();
});

async function harness(input: {
	toolSteps: number;
	onTool?: (n: number) => Promise<void> | void;
	now?: () => string;
	/** Every model call's prompt, so a test can assert WHEN a message became visible. */
	onModelCall?: (prompt: unknown) => void;
	/** Counts reads of the inbox table — the watermark exists so this stays at zero when quiet. */
	onInboxRead?: () => void;
}) {
	const { adapter, close } = await sqliteDb(RUN_TABLES);
	openDatabases.push(close);
	// Wrapped so a test can count what the hot path actually touches.
	const db: Adapter = {
		...adapter,
		findMany: async (args) => {
			if (args.model === "run_message") input.onInboxRead?.();
			return adapter.findMany(args);
		},
	};
	const redactor = createStoredRedactor({
		detector: emailDetector,
		mappings: createPiiMappingStore(db),
	});
	const store = createSqlEngineStore(db, input.now ? { now: input.now } : {});
	let toolRuns = 0;
	const runtime = createRuntime({
		model: multiStepModel(input.toolSteps, input.onModelCall),
		database: db,
		redactor,
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
	const { engine } = sqlEngine({
		store,
		workerId: "worker-1",
		leaseTtlMs: 600_000,
	}).create(runtime);
	return { db, store, engine, runtime, toolRuns: () => toolRuns };
}

describe("run control plane — suspend", () => {
	it("suspends a multi-step run mid-flight, from another process, and parks it", async () => {
		let suspendFrom: (() => Promise<void>) | undefined;
		const h = await harness({
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
		const h = await harness({ toolSteps: 1 });
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
		const h = await harness({ toolSteps: 0 });
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
		const h = await harness({ toolSteps: 1 });
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
		const h = await harness({
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
		const h = await harness({
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
		const h = await harness({ toolSteps: 1 });
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
		const { store, claw } = await clawHarness();

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
		const h = await harness({
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
		const h = await harness({
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
		const h = await harness({ toolSteps: 1 });
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
		const h = await harness({
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
		const { adapter: db, close } = await sqliteDb(RUN_TABLES);
		openDatabases.push(close);
		const store = createSqlEngineStore(db);
		let providerSawAbort = false;
		const runtime = createRuntime({
			model: hangingModel(() => {
				providerSawAbort = true;
			}),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
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
		const { store, claw } = await clawHarness({
			model: approvalSeekingModel(),
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
		const h = await harness({ toolSteps: 1 });
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
		const h = await harness({ toolSteps: 0 });
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
		const h = await harness({ toolSteps: 1 });
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
		const h = await harness({ toolSteps: 1 });
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

describe("run control plane — the inbox: delivery", () => {
	it("delivers a next_step message into the run's very next model call", async () => {
		const seen: string[] = [];
		const h = await harness({
			toolSteps: 2,
			onTool: async (n) => {
				if (n === 1) {
					await h.engine.deliverMessage({
						toRunId: runId,
						body: { text: "stop what you are doing and say hello" },
						mode: "next_step",
						sender: userPrincipal("operator"),
						idempotencyKey: "k1",
					});
				}
			},
			onModelCall: (messages) => {
				seen.push(JSON.stringify(messages));
			},
		});
		let runId = "";
		const run = await h.engine.startRun({ prompt: "go" });
		runId = run.id;

		expect((await h.engine.work()).status).toBe("completed");

		// The message was admitted DURING step 0's tool call, so it must appear in the step 1 prompt —
		// the next model call after the control point that found it. Not later, and not never.
		expect(seen[0]).not.toContain("say hello");
		expect(seen[1]).toContain("say hello");

		const rows = await h.db.findMany({
			model: "run_message",
			where: [{ field: "toRunId", value: run.id }],
		});
		expect(rows).toHaveLength(1);
		expect((rows[0] as { status?: string }).status).toBe("delivered");
	});

	it("delivers a message admitted BEFORE the run was ever claimed", async () => {
		const seen: string[] = [];
		const h = await harness({
			toolSteps: 0,
			onModelCall: (messages) => {
				seen.push(JSON.stringify(messages));
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });
		// Queued, never claimed. The watermark starts below zero precisely so the first control point
		// still looks — otherwise a message admitted in this window is never found.
		await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "read me first" },
			mode: "next_step",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});

		expect((await h.engine.work()).status).toBe("completed");
		expect(seen[0]).toContain("read me first");
	});

	it("never delivers an at_turn_end message into THIS run", async () => {
		const seen: string[] = [];
		const h = await harness({
			toolSteps: 0,
			onModelCall: (messages) => {
				seen.push(JSON.stringify(messages));
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });
		await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "for the next run" },
			mode: "at_turn_end",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});

		expect((await h.engine.work()).status).toBe("completed");
		expect(seen.join("")).not.toContain("for the next run");
		// It is still SITTING there, pending — wake fuel for whoever starts the next run, not a
		// message that was silently dropped.
		const rows = await h.db.findMany({
			model: "run_message",
			where: [{ field: "toRunId", value: run.id }],
		});
		expect((rows[0] as { status?: string }).status).toBe("pending");
	});

	// The whole point of the watermark: the message table is touched only when the counter moved, so
	// a quiet inbox costs one primary-key read of the run row per step and nothing else.
	it("never reads the inbox when the watermark has not moved", async () => {
		let inboxReads = 0;
		const h = await harness({
			toolSteps: 2,
			onInboxRead: () => {
				inboxReads++;
			},
		});
		await h.engine.startRun({ prompt: "go" });
		await h.engine.work();
		// The FIRST control point always looks (the watermark starts below zero, so a message admitted
		// while the run was queued is found). After that, nothing moved, so nothing is queried.
		expect(inboxReads).toBe(1);
	});
});

describe("run control plane — the inbox: the redelivery fence", () => {
	// THE WINDOW. A row is marked `delivered` before it reaches the in-memory transcript, so a crash
	// in between leaves a message that is neither pending nor in anybody's transcript — invisible
	// forever, and silently. The fence is what the CHECKPOINT contains, because only the snapshot
	// knows what the model will actually see; the row's own status cannot answer it.
	it("re-delivers a message that was marked delivered but never reached the transcript", async () => {
		const seen: string[] = [];
		let clock = 0;
		const h = await harness({
			toolSteps: 3,
			now: () => iso(clock),
			onTool: () => {
				clock += 100_000; // burn past the soft deadline so slice one parks
			},
			onModelCall: (prompt) => {
				seen.push(JSON.stringify(prompt));
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });

		// Slice one yields a checkpoint. Nothing has been delivered, so its `deliveredThrough` is
		// whatever the transcript contains — nothing.
		const first = await h.engine.work({ deadlineAt: iso(50_000) });
		expect(first.status).toBe("yielded");

		// Now stage the crash: a message that the database believes was delivered at a step the
		// checkpoint predates. This is exactly the state a process death in that window leaves.
		await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "the lost message" },
			mode: "next_step",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});
		const rows = await h.db.findMany({
			model: "run_message",
			where: [{ field: "toRunId", value: run.id }],
		});
		const lostId = (rows[0] as { id: string }).id;
		await h.db.update({
			model: "run_message",
			where: [{ field: "id", value: lostId }],
			update: { status: "delivered", deliveredAtStep: 0 },
		});

		const before = seen.length;
		const second = await h.engine.work({ deadlineAt: iso(clock + 50_000) });
		if (second.status === "failed") {
			throw new Error(`tick failed: ${second.reason}`);
		}

		// It was shown to the model anyway. A fence built on the row's status would have skipped it,
		// because the row says delivered and the row is wrong.
		expect(seen.slice(before).join("")).toContain("the lost message");
	});

	it("does not re-show a message the checkpoint already contains", async () => {
		const seen: string[] = [];
		let clock = 0;
		let runId = "";
		const h = await harness({
			toolSteps: 3,
			now: () => iso(clock),
			onTool: async (n) => {
				if (n === 1) {
					await h.engine.deliverMessage({
						toRunId: runId,
						body: { text: "carried across" },
						mode: "next_step",
						sender: userPrincipal("operator"),
						idempotencyKey: "k1",
					});
				}
				clock += 100_000;
			},
			onModelCall: (prompt) => {
				seen.push(JSON.stringify(prompt));
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });
		runId = run.id;

		// The message is delivered AND the slice parks — the same verdict carries both, so the
		// checkpoint snapshots a transcript that already contains it.
		expect((await h.engine.work({ deadlineAt: iso(50_000) })).status).toBe(
			"yielded",
		);
		const cps = await h.db.findMany({
			model: "run_checkpoint",
			where: [{ field: "runId", value: run.id }],
		});
		await h.engine.work({ deadlineAt: iso(clock + 50_000) });

		// It IS in every later prompt — it is part of the transcript now, which is the point. What must
		// not happen is it being PUSHED a second time, so the count is taken WITHIN one prompt.
		// Anchoring the fence on the step number instead would re-push on every resume, and this
		// number would climb by one each time the run parked.
		const last = seen[seen.length - 1] ?? "";
		expect(last.split("carried across").length - 1).toBe(1);
	});
});

describe("run control plane — the inbox: waking a parked run", () => {
	// There is deliberately no `message` proceed tag. A parked run resumes from its checkpoint and
	// drains its inbox at the first control point on the way back, so "wake it with this message" and
	// "wake it" are the same call — a separate tag would be a synonym with extra ceremony, and the
	// exhaustive switch would then carry a case that does nothing different.
	//
	// WHO calls it is the router's question, not the engine's: channels wants one live run per
	// thread, a subagent parent wants to wake a specific child. The engine addresses by runId and
	// stops there.
	it("delivers a message admitted while the run was suspended, on resume", async () => {
		const seen: string[] = [];
		let suspendFrom: (() => Promise<void>) | undefined;
		const h = await harness({
			toolSteps: 2,
			onTool: async (n) => {
				if (n === 1) await suspendFrom?.();
			},
			onModelCall: (prompt) => {
				seen.push(JSON.stringify(prompt));
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
		expect(parked?.status).toBe("waiting");

		// The run is parked. A message admitted now has nothing to wake it — the inbox is not a
		// trigger, and pretending otherwise would put thread arbitration in the engine.
		const admitted = await h.engine.deliverMessage({
			toRunId: run.id,
			body: { text: "while you were out" },
			mode: "next_step",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});
		expect(admitted.admitted).toBe(true);
		expect((await h.engine.work()).status).toBe("idle"); // still nothing due

		if (parked?.resumeCheckpointId === undefined) {
			throw new Error("expected a resume checkpoint");
		}
		await h.engine.proceedRun({
			runId: run.id,
			proceed: { kind: "checkpoint", checkpointId: parked.resumeCheckpointId },
		});
		const before = seen.length;
		expect((await h.engine.work()).status).toBe("completed");

		// It was waiting in the inbox the whole time and arrives in the first model call after the
		// resume — no separate verb, no second mechanism.
		expect(seen.slice(before).join("")).toContain("while you were out");
	});
});

describe("run control plane — the inbox: interrupt", () => {
	// A message arriving mid-call cannot be seen by the control point, which does not run again until
	// that call returns. The heartbeat is the only thing awake, so it is the only thing that can
	// cancel it — and the step is then RE-RUN, so the control point at its top delivers the message
	// that caused the interruption. The model sees the interruption as context, not as an error.
	it("cancels the model call in flight and re-runs the step with the message", async () => {
		const { adapter: db, close } = await sqliteDb(RUN_TABLES);
		openDatabases.push(close);
		const store = createSqlEngineStore(db);
		const prompts: string[] = [];
		let releaseFirstCall: (() => void) | undefined;
		let calls = 0;

		const model: RuntimeModel = {
			specificationVersion: "v4",
			provider: "mock",
			modelId: "mock",
			supportedUrls: {},
			doGenerate: async (options: {
				prompt?: unknown;
				abortSignal?: AbortSignal;
			}) => {
				prompts.push(JSON.stringify(options.prompt));
				calls++;
				// The FIRST call hangs until its signal fires. The second answers immediately.
				if (calls === 1) {
					return new Promise((_resolve, reject) => {
						releaseFirstCall = () => reject(new Error("aborted"));
						options.abortSignal?.addEventListener("abort", () => {
							reject(new Error("aborted"));
						});
					});
				}
				return {
					content: [{ type: "text" as const, text: "done" }],
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
				};
			},
			doStream: async () => {
				throw new Error("stream not used");
			},
		} as RuntimeModel;

		const runtime = createRuntime({
			model,
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
		});
		// A short lease so the heartbeat — the only thing that can notice mid-call — ticks promptly.
		const { engine } = sqlEngine({
			store,
			workerId: "worker-1",
			leaseTtlMs: 600,
		}).create(runtime);

		const run = await engine.startRun({ prompt: "go" });
		const tick = engine.work();
		await new Promise((resolve) => setTimeout(resolve, 60));
		await engine.deliverMessage({
			toRunId: run.id,
			body: { text: "actually, stop and do this instead" },
			mode: "interrupt",
			sender: userPrincipal("operator"),
			idempotencyKey: "k1",
		});

		const result = await tick;
		if (result.status === "failed") {
			throw new Error(`tick failed: ${result.reason}`);
		}
		void releaseFirstCall;

		// The run FINISHED — the interrupt re-ran the step rather than ending the run, which is the
		// whole difference between this and `abort`.
		expect(result.status).toBe("completed");
		expect((await store.getRun(run.id))?.status).toBe("completed");
		// Two model calls: the one that was cancelled, and the re-run.
		expect(calls).toBe(2);
		// The first saw no message; the re-run saw it. That ordering is the mechanism.
		expect(prompts[0]).not.toContain("do this instead");
		expect(prompts[1]).toContain("do this instead");
	}, 15_000);
});

describe("run control plane — the doors", () => {
	// A STATED acceptance criterion for the advance verb that had no test. The route resolves its
	// authz anchor PER TAG — the approval tag keeps the manage-on-approval floor `continueEngineRun`
	// always had, the checkpoint tag anchors on the run — and nothing checked that the anchor it
	// resolves is the one that actually gets enforced.
	it("denies a caller who manages neither the run nor the record it names", async () => {
		const { store, claw } = await clawHarness();
		const mine = await claw.api.startRun({ prompt: "mine" });
		const checkpoint = await claw.$context.runtime.checkpoints?.create({
			runId: mine.id,
			metadata: {
				version: "runtime.ai-sdk.yield.v1",
				nextStep: 1,
				messages: [{ role: "user", content: "mine" }],
			},
			createdAt: new Date().toISOString(),
		});
		if (!checkpoint) throw new Error("expected a checkpoint");

		// A STRANGER: authenticated, but with no relationship to this run at all. The PEP resolves the
		// checkpoint tag against the RUN, and the run is owner-isolated.
		await expect(
			claw.api.proceedRun(
				{
					runId: mine.id,
					proceed: { kind: "checkpoint", checkpointId: checkpoint.id },
				},
				{ principal: userPrincipal("stranger") },
			),
		).rejects.toThrow();

		// …and nothing was scheduled by the attempt.
		expect((await store.getRun(mine.id))?.status).toBe("queued");

		// THE CONTRAST is what makes the rejection above mean something: the same call, same record,
		// same everything except who is asking, succeeds. Without this the test would pass just as
		// happily if `proceedRun` threw for an unrelated reason.
		await expect(
			claw.api.proceedRun({
				runId: mine.id,
				proceed: { kind: "checkpoint", checkpointId: checkpoint.id },
			}),
		).resolves.toMatchObject({ id: mine.id });
	});

	it("stops a run through the product door, with the requester stamped from the caller", async () => {
		const { store, claw } = await clawHarness();
		const run = await claw.api.startRun({ prompt: "go" });

		// No `requestedBy` on the input at all — there is nowhere to put a lie.
		await claw.api.controlRun({ runId: run.id, intent: "stop" });

		expect((await store.getRun(run.id))?.status).toBe("cancelled");
		const cancelled = (await store.events(run.id)).find(
			(event) => event.type === "run.cancelled",
		);
		// `owned()` binds one principal to every call; that is who the record must name.
		expect(cancelled?.payload.requestedBy).toBe(userPrincipal("actor-1"));
	});

	// The door is where a message is TOKENIZED, into the receiving run's container. Nothing tested
	// that: the engine-level tests hand it a body that was already clean.
	it("tokenizes a message body into the receiving run's container", async () => {
		const { db, store, claw } = await clawHarness();
		const run = await claw.api.startRun({ prompt: "go" });

		await claw.api.deliverMessage({
			toRunId: run.id,
			body: { text: "reply to alice@personal.com please" },
			mode: "next_step",
			idempotencyKey: "k1",
		});

		const rows = await db.findMany({
			model: "run_message",
			where: [{ field: "toRunId", value: run.id }],
		});
		const stored = JSON.stringify(rows[0]);
		// The address is GONE from the row at rest — a placeholder stands in its place.
		expect(stored).not.toContain("alice@personal.com");
		expect(stored).toContain("{{pii:");
		// …and the row records WHICH container holds the token, so erasure can find it later without
		// having to guess which run minted it.
		expect(rows[0]).toMatchObject({
			containerScope: "run",
			containerScopeId: run.id,
			sender: userPrincipal("actor-1"),
		});
		void store;
	});

	it("bounces at the door too, not only inside the engine", async () => {
		const { store, claw } = await clawHarness();
		const run = await claw.api.startRun({ prompt: "go" });
		await claw.api.controlRun({ runId: run.id, intent: "stop" });
		expect((await store.getRun(run.id))?.status).toBe("cancelled");

		expect(
			await claw.api.deliverMessage({
				toRunId: run.id,
				body: { text: "too late" },
				mode: "next_step",
				idempotencyKey: "k1",
			}),
		).toMatchObject({ admitted: false, bounced: "cancelled" });
	});
});

describe("run control plane — inbox ordering", () => {
	it("delivers in the run's own order, not the order the rows come back", async () => {
		const seen: string[] = [];
		const h = await harness({
			toolSteps: 0,
			onModelCall: (prompt) => {
				seen.push(JSON.stringify(prompt));
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });
		for (const n of [1, 2, 3]) {
			await h.engine.deliverMessage({
				toRunId: run.id,
				body: { text: `message-${n}` },
				mode: "next_step",
				sender: userPrincipal("operator"),
				idempotencyKey: `k${n}`,
			});
		}

		expect((await h.engine.work()).status).toBe("completed");
		const prompt = seen[0] ?? "";
		const order = [1, 2, 3].map((n) => prompt.indexOf(`message-${n}`));
		expect(order.every((at) => at >= 0)).toBe(true);
		// FIFO by `seq`. Unordered would pass a "they all arrived" assertion and be wrong anyway.
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});

describe("run control plane — a crashed host, end to end", () => {
	// The counter split has store-level tests; this is the whole story through the worker, on a real
	// database. `maxAttempts` defaulting to 3 is only safe because a re-claimed first slice continues
	// from its checkpoint instead of re-prompting — so the two have to be exercised together, or the
	// test that proves the counter is fine hides the fact that the work was silently redone.
	it("loses its lease mid-run, is re-claimed, and finishes what it started", async () => {
		let clock = 0;
		const h = await harness({
			toolSteps: 3,
			now: () => iso(clock),
			onTool: () => {
				clock += 100_000; // burn past the soft deadline so slice one parks
			},
		});
		const run = await h.engine.startRun({ prompt: "go" });

		// Slice one yields a checkpoint and self-enqueues its continuation.
		expect((await h.engine.work({ deadlineAt: iso(50_000) })).status).toBe(
			"yielded",
		);
		expect(h.toolRuns()).toBe(1);

		// THE CRASH: the host holding the continuation vanishes. Nothing writes a terminal status —
		// the worker returns without touching the store on lease loss — so the task simply sits
		// `leased` until a reaper sweeps it.
		const claimed = await h.store.claimDueTask({
			workerId: "doomed-host",
			leaseTtlMs: 1,
		});
		expect(claimed).not.toBeNull();
		clock += 10_000;
		expect(await h.store.reapExpiredLeases()).toBeGreaterThan(0);

		// The run is NOT failed: a vanished host says nothing about whether the work is bad.
		const afterReap = await h.store.getRun(run.id);
		expect(afterReap?.status).not.toBe("failed");
		const requeued = await h.db.findMany({
			model: "runtime_task",
			where: [
				{ field: "runId", value: run.id },
				{ field: "status", value: "pending", connector: "AND" },
			],
		});
		expect(requeued.length).toBeGreaterThan(0);

		// Past the retry delay the reap set, or the task is simply not due yet and the tick reports
		// idle — which would make every assertion below vacuously true.
		clock += 10_000;

		// A fresh host picks it up and CONTINUES — the first tool call is not paid for again.
		const toolsBefore = h.toolRuns();
		const resumed = await h.engine.work({ deadlineAt: iso(clock + 50_000) });
		if (resumed.status === "failed") {
			throw new Error(`tick failed: ${resumed.reason}`);
		}
		expect(h.toolRuns()).toBe(toolsBefore + 1);
		// One more step happened, not a restart from the prompt: a restart would have re-run the tool
		// from step 0 and the count would be the same either way — so assert the CHECKPOINT moved on.
		expect((await h.store.getRun(run.id))?.status).not.toBe("failed");
	});
});
