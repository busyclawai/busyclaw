import type {
	BusyclawPlugin,
	ClawEngineFactory,
	ClawEngineHandle,
	ClawEngineInstance,
	EngineControlRunInput,
	EngineControlRunResult,
	EngineProceedRunInput,
	EngineRunHandle,
	EngineStartRunInput,
	RunControlIntent,
} from "@busyclaw/contracts";
import {
	drainWork as drainEngineWork,
	isConflict,
	stateError,
} from "@busyclaw/contracts";
import type { Runtime } from "@busyclaw/runtime";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { addMs, type SqlEngineStore } from "./store";
import type {
	SqlEngineWorkerConfig,
	WorkerTickOptions,
	WorkerTickResult,
} from "./worker";
import {
	createSqlEngineWorker,
	RESUME_MAX_ATTEMPTS,
	RUNTIME_CONTINUE_RUN_TASK,
	RUNTIME_RESUME_RUN_TASK,
	RUNTIME_RUN_TASK,
} from "./worker";

/** A run in one of these has nothing left to continue; a continuation against it is a mistake. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

/** The monotone ladder. `suspend < stop < abort`, compared by position so a later value can be
 *  added without every comparison site learning about it. */
const CONTROL_INTENT_RANK: Record<RunControlIntent, number> = {
	suspend: 0,
	stop: 1,
	abort: 2,
};

/** Is `next` strictly above `current` on the ladder? Only then may the latch move. */
function raises(current: RunControlIntent, next: RunControlIntent): boolean {
	return CONTROL_INTENT_RANK[next] > CONTROL_INTENT_RANK[current];
}

/**
 * The task id for advancing `runId` from the record `recordId`. Derived, so the insert itself is the
 * admission — the same construction `deliveryRowId` uses in the channels inbox, NUL-joined for the
 * same reason: `runId` and `approvalId` are opaque ids from different stores and must not be able
 * to collide by concatenation. Written as the escape rather than a literal NUL byte, because a
 * source file carrying a raw NUL is binary to git.
 */
function proceedTaskId(
	runId: string,
	taskKind: string,
	recordId: string,
): string {
	return bytesToHex(
		sha256(utf8ToBytes(`${runId}\u0000${taskKind}\u0000${recordId}`)),
	);
}

export type SqlEngineConfig = {
	store: SqlEngineStore;
	workerId?: string;
	leaseTtlMs?: number;
	/**
	 * Invocation soft deadline for cron-driven work, in ms (e.g. 240_000 of Vercel's 300s budget).
	 * Computed ONCE per cron invocation: the drain stops claiming past it, and an in-flight run
	 * parks a yield checkpoint + continuation task instead of being killed by the platform.
	 * Unset = never yield (daemon/no-timeout hosts). Deadlines read the store's clock
	 * (`createSqlEngineStore(adapter, { now })`) — one time source for leases and budgets.
	 */
	softDeadlineMs?: number;
	cron?: false | { limit?: number };
};

type SqlEngineCronFlag<Config extends SqlEngineConfig> = Config extends {
	cron: false;
}
	? "no-cron"
	: "has-cron";

export type SqlEngineHandle = ClawEngineHandle<WorkerTickResult> & {
	kind: "sql";
	work: (options?: WorkerTickOptions) => Promise<WorkerTickResult>;
};

function createSqlEngineHandle(input: {
	config: SqlEngineConfig;
	runtime: Runtime;
}): SqlEngineHandle {
	const worker = createSqlEngineWorker({
		leaseTtlMs: input.config.leaseTtlMs,
		runtime: input.runtime,
		store: input.config.store,
		workerId: input.config.workerId ?? "busyclaw-worker",
	} satisfies SqlEngineWorkerConfig);
	return {
		kind: "sql",
		async startRun(startInput: EngineStartRunInput): Promise<EngineRunHandle> {
			const run = await input.config.store.transaction(async (store) => {
				const run = await store.createRun({
					...startInput.run,
					input: { prompt: startInput.prompt, ctx: startInput.ctx ?? {} },
				});
				await store.enqueueTask({
					kind: RUNTIME_RUN_TASK,
					payload: {
						prompt: startInput.prompt,
						...(startInput.ctx ? { ctx: startInput.ctx } : {}),
					},
					runId: run.id,
				});
				return run;
			});
			return { id: run.id };
		},
		async proceedRun(
			proceedInput: EngineProceedRunInput,
		): Promise<EngineRunHandle> {
			// One admit body for every tag. The tag decides two things and nothing else: which task
			// kind carries the work, and which record id the derived task id is built from.
			const { proceed } = proceedInput;
			const [kind, recordId] =
				proceed.kind === "approval"
					? ([RUNTIME_CONTINUE_RUN_TASK, proceed.approvalId] as const)
					: ([RUNTIME_RESUME_RUN_TASK, proceed.checkpointId] as const);

			await input.config.store.transaction(async (store) => {
				const run = await store.getRun(proceedInput.runId);
				// R-M10, generalized. A continuation used to CREATE a run when it could not find one,
				// so a resumed run got a second engine row while the runtime restored the original id
				// from the record — two identities for one logical run, and the row that recorded the
				// park was not the row that recorded the resume. There is nothing to continue here.
				if (!run) {
					throw stateError("no such run to proceed", {
						runId: proceedInput.runId,
					});
				}
				// A TERMINAL run has nothing left to advance. Resetting one to `queued` resurrects it,
				// and the slice that follows finds its record already spent and dead-letters — which is
				// how `completed` used to be rewritten as `failed` by a second click.
				if (TERMINAL_RUN_STATUSES.has(run.status)) {
					throw stateError("run is already terminal and cannot proceed", {
						runId: run.id,
						status: run.status,
					});
				}

				// The INSERT is the admission: two calls naming the same (run, kind, record) derive one
				// id and the second loses at the database, so one record can only ever schedule one
				// slice. Before this, each call minted its own id and the loser was a task that could
				// only fail — taking its run's status down with it.
				try {
					await store.enqueueTask({
						id: proceedTaskId(run.id, kind, recordId),
						kind,
						payload: {
							...(proceed.kind === "approval"
								? { approvalId: proceed.approvalId }
								: { checkpointId: proceed.checkpointId }),
							...(proceedInput.ctx ? { ctx: proceedInput.ctx } : {}),
						},
						runId: run.id,
						...(kind === RUNTIME_RESUME_RUN_TASK
							? { maxAttempts: RESUME_MAX_ATTEMPTS }
							: {}),
					});
				} catch (error) {
					// Already admitted by an earlier call — the run is scheduled, which is what the
					// caller wanted. Anything else is real and must not be swallowed.
					if (!isConflict(error)) throw error;
					return;
				}

				// Back to queued so a worker picks it up — and CONDITIONALLY, because a run left
				// `running` by a park is not ours to relabel and a terminal one must never be revived
				// by a write that raced the check above.
				await store.updateRunIfStatus(run.id, {
					from: ["queued", "running", "waiting"],
					patch: {
						status: "queued",
						waitReason: null,
						resumeCheckpointId: null,
					},
				});
			});
			return { id: proceedInput.runId };
		},
		async controlRun(
			controlInput: EngineControlRunInput,
		): Promise<EngineControlRunResult> {
			return input.config.store.transaction(async (store) => {
				const run = await store.getRun(controlInput.runId);
				if (!run) {
					throw stateError("no such run", { runId: controlInput.runId });
				}
				const ts = store.now();

				// TERMINAL — write no latch at all. A latch on a finished run poisons a later
				// operator-driven resume of a leftover checkpoint, and would sit there forever with
				// nothing left to observe it. Loud and recorded, not a 404 and not a lie.
				if (TERMINAL_RUN_STATUSES.has(run.status)) {
					await store.appendEvent({
						runId: run.id,
						type: "run.control_ignored",
						payload: {
							intent: controlInput.intent,
							status: run.status,
							reason: "already-terminal",
						},
					});
					return {
						accepted: false,
						settled: false,
						reason: "already-terminal",
					};
				}

				// The latch is RAISE-ONLY, and the first requester's identity is write-once. So an
				// escalation lands, a de-escalation is refused, and "who asked" survives both.
				const current = run.controlIntent;
				if (current && !raises(current, controlInput.intent)) {
					return {
						accepted: false,
						settled: false,
						reason: "already-requested",
					};
				}
				const latch = {
					controlIntent: controlInput.intent,
					controlSeq: (run.controlSeq ?? 0) + 1,
					...(current
						? {}
						: {
								controlRequestedAt: ts,
								...(controlInput.requestedBy
									? { controlRequestedBy: controlInput.requestedBy }
									: {}),
								...(controlInput.reason
									? { controlReason: controlInput.reason }
									: {}),
							}),
				};

				// NOTHING IN FLIGHT — honour it here, terminally, in this transaction. A queued run has
				// no holder that will ever reach a control point, so latching and hoping is a run that
				// waits forever. Its pending tasks are dead-lettered so no host can pick one up later.
				if (run.status === "queued" || run.status === "waiting") {
					const withheld = await store.deadLetterPendingTasks(
						run.id,
						"run suspended before this task was claimed",
					);
					const settledRun = await store.updateRunIfStatus(run.id, {
						from: ["queued", "waiting"],
						patch: {
							...latch,
							status: "waiting",
							waitReason: "suspended",
							controlRequestedAt: null,
							controlIntent: null,
							controlRequestedBy: null,
							controlReason: null,
						},
					});
					// Lost to a claim that started between the read and here. The latch below is the
					// correct answer now: the holder observes it at its next control point.
					if (settledRun) {
						await store.appendEvent({
							runId: run.id,
							type: "run.suspended",
							payload: {
								intent: controlInput.intent,
								withheldTasks: withheld,
								...(controlInput.requestedBy
									? { requestedBy: controlInput.requestedBy }
									: {}),
							},
						});
						return { accepted: true, settled: true };
					}
				}

				await store.updateRun(run.id, latch);
				await store.appendEvent({
					runId: run.id,
					type: "run.control_requested",
					payload: {
						intent: controlInput.intent,
						...(controlInput.requestedBy
							? { requestedBy: controlInput.requestedBy }
							: {}),
					},
				});
				return { accepted: true, settled: false };
			});
		},
		work: (options?: WorkerTickOptions) => worker.tick(options),
	};
}

function sqlCronPlugin<const Config extends SqlEngineConfig>(
	config: Config,
	engine: SqlEngineHandle,
): BusyclawPlugin<SqlEngineCronFlag<Config>> {
	const now = config.store.now;
	return {
		id: "engine-sql",
		cron:
			config.cron === false
				? []
				: [
						{
							id: "engine-sql:work",
							handler: ({ limit }) => {
								// Invocation-scoped, computed ONCE per cron firing: a warm drain that keeps
								// claiming must not grant each task a fresh budget past the platform's wall.
								const deadlineAt =
									config.softDeadlineMs !== undefined
										? addMs(now(), config.softDeadlineMs)
										: undefined;
								return drainEngineWork({
									limit:
										limit ??
										(config.cron === false ? undefined : config.cron?.limit),
									work: () =>
										engine.work(
											deadlineAt !== undefined ? { deadlineAt } : undefined,
										),
								});
							},
						},
					],
	};
}

export function sqlEngine<const Config extends SqlEngineConfig>(
	config: Config,
): ClawEngineFactory<Runtime, SqlEngineHandle, SqlEngineCronFlag<Config>> {
	return {
		kind: "sql",
		create: (
			runtime,
		): ClawEngineInstance<SqlEngineHandle, SqlEngineCronFlag<Config>> => {
			const engine = createSqlEngineHandle({ config, runtime });
			return {
				engine,
				plugins: [sqlCronPlugin(config, engine)],
				runs: {
					get: (id) => config.store.getRun(id),
					events: (runId) => config.store.events(runId),
				},
			};
		},
	};
}
