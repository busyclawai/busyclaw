import type {
	BusyclawPlugin,
	ClawEngineFactory,
	ClawEngineHandle,
	ClawEngineInstance,
	EngineControlRunInput,
	EngineControlRunResult,
	EngineDeliverMessageInput,
	EngineDeliverMessageResult,
	EngineProceedRunInput,
	EngineRunHandle,
	EngineStartRunInput,
	EngineStartRunResult,
	RunControlIntent,
	RunStreamPort,
} from "@busyclaw/contracts";
import {
	drainWork as drainEngineWork,
	isConflict,
	runStreamKey,
	stateError,
	threadStreamKey,
} from "@busyclaw/contracts";
import type { Runtime, RuntimeResult } from "@busyclaw/runtime";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sqlEngineModels } from "./schema";
import { addMs, type SqlEngineStore } from "./store";
import type {
	SqlEngineWorkerConfig,
	WorkerTickOptions,
	WorkerTickResult,
} from "./worker";
import {
	createSqlEngineWorker,
	driveClaim,
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

/**
 * The row id for a message. Derived so the INSERT is the admission — the same construction the
 * channels inbox uses, NUL-joined for the same reason: three opaque ids from different sources must
 * not be able to collide by concatenation. Written as the escape rather than a literal NUL byte,
 * because a source file carrying a raw NUL is binary to git.
 */
function messageRowId(
	toRunId: string,
	sender: string,
	idempotencyKey: string,
): string {
	return bytesToHex(
		sha256(utf8ToBytes(`${toRunId}\u0000${sender}\u0000${idempotencyKey}`)),
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
	/**
	 * Live deltas for whoever is watching. Threaded to the worker so the CRON path writes them too —
	 * the second slice of a parked turn is driven here, minutes later and in another process, and a
	 * watcher who saw the first half must see the rest.
	 */
	runStream?: RunStreamPort;
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
	// ONE resolved id for both drivers. `workerId` is forensic — the lease is fenced on
	// `leaseId`/`tokenHash`, never on this — but a caller driving its own run and the cron drain must
	// not disagree about what to record, so the default is resolved once here rather than twice.
	const workerId = input.config.workerId ?? "busyclaw-worker";
	const worker = createSqlEngineWorker({
		leaseTtlMs: input.config.leaseTtlMs,
		runtime: input.runtime,
		store: input.config.store,
		workerId,
		...(input.config.runStream !== undefined
			? { runStream: input.config.runStream }
			: {}),
	} satisfies SqlEngineWorkerConfig);
	return {
		kind: "sql",
		// Surfaced so a door can derive its own `drive.deadlineAt` from the same budget the cron
		// drain uses. One number, one source.
		...(input.config.softDeadlineMs !== undefined
			? { softDeadlineMs: input.config.softDeadlineMs }
			: {}),
		// WHO CLAIMS A CONTINUATION. A yield enqueues a `pending` task, and `claimDueTask` — the only
		// thing that takes one — has exactly one caller: the cron drain. So with `cron: false` a
		// yielded run is a stopped run, and a door that yields on it turns a turn that would have
		// finished into one that never lands.
		resumesPendingWork: input.config.cron !== false,
		async startRun(
			startInput: EngineStartRunInput,
		): Promise<EngineStartRunResult> {
			// ONE TRANSACTION for create + enqueue + claim, and that is what makes the first slice
			// race-free rather than race-resolved: an uncommitted INSERT is invisible to another
			// connection's `findMany`, so no cron replica can see this task before this caller already
			// holds its lease. The caller wins by construction, not by luck.
			//
			// The CLAIM is targeted (`claimTask`), never `claimDueTask`. A caller running the candidate
			// scan would take the OLDEST due task — driving somebody else's run under that run's
			// principal and handing back their result — which is a cross-tenant disclosure, not a
			// latency question.
			const opened = await input.config.store.transaction(async (store) => {
				const run = await store.createRun({
					...startInput.run,
					// NO PROMPT (D13). This column is `immutable`, nothing prunes it, no api
					// re-identifies it and `forgetSubject` cannot reach text that was never tokenized —
					// so a prompt written here is a permanent cleartext copy of whatever the caller
					// typed, sitting one row away from the transcript that took care to tokenize the
					// same words. `getRun` no longer returns it either; the control plane needs status,
					// scope and wait reason, not content.
					//
					// Where the prompt IS: the task payload, which is what actually seeds the run, and —
					// for a conversational run — the `origin_message_id` column, which points at the
					// tokenized transcript row. Copying that id in here too would be a second slot for
					// one fact, which is the fork this schema keeps refusing.
					input: { ctx: startInput.ctx ?? {} },
					// COLUMNS, not the task payload. The payload is `completed` and unindexed by the
					// time a reader asks which thread a run answered, and the `deliverMessage` door
					// needs the claw before any task has been claimed — neither question a payload can
					// answer. `model` and `runMode` join them for the same reason one rung out: a
					// continuation claimed months later reads the row, not the invocation that is gone.
					recording: startInput.recording,
					model: startInput.model,
					runMode: startInput.runMode,
				});
				const task = await store.enqueueTask({
					kind: RUNTIME_RUN_TASK,
					payload: {
						prompt: startInput.prompt,
						...(startInput.ctx ? { ctx: startInput.ctx } : {}),
					},
					runId: run.id,
				});
				const claim =
					startInput.drive === undefined
						? null
						: await store.claimTask(task.id, {
								workerId,
								...(input.config.leaseTtlMs !== undefined
									? { leaseTtlMs: input.config.leaseTtlMs }
									: {}),
							});
				return { run, claim };
			});
			// ANNOUNCED HERE, not at the door, for the reason the text chunks moved: one writer per
			// fact. The door only knows about conversational turns, so a run started through
			// `startRun` — cron work, a subagent — would never be announced at all, and its watcher
			// would see text arrive with nothing saying whose turn it was or when it began.
			//
			// Before the drive, so a watcher already attached sees the turn open rather than
			// discovering it when the first delta lands. Advisory like every write to this buffer.
			if (input.config.runStream !== undefined) {
				const key =
					startInput.recording?.threadId !== undefined
						? threadStreamKey(startInput.recording.threadId)
						: runStreamKey(opened.run.id);
				try {
					await input.config.runStream.append(key, {
						kind: "run.started",
						runId: opened.run.id,
						attempt: 1,
						...(startInput.run?.principal !== undefined
							? { by: startInput.run.principal }
							: {}),
					});
				} catch {
					// A run whose start nobody could announce still runs.
				}
			}
			if (startInput.drive === undefined) return { id: opened.run.id };
			// Losing a claim on a task nobody else could see yet means the run went terminal between
			// create and claim — a `controlRun` arriving in that window. Report the winner rather than
			// driving a corpse.
			if (!opened.claim) {
				return { id: opened.run.id, notDriven: "already-terminal" };
			}
			// OUTSIDE the transaction. One that spans a model call is not a design.
			//
			// `runtimeResult` is what a door waiting on its own turn gets back — the model's answer,
			// not the task's obituary. `EngineStartRunResult.result` is documented as the shape
			// busyclaw parses against `RuntimeResult`, so this is the field honouring that contract.
			let runtimeResult: RuntimeResult | undefined;
			const result = await driveClaim({
				claim: opened.claim,
				runtime: input.runtime,
				store: input.config.store,
				workerId,
				onResult: (produced) => {
					runtimeResult = produced;
				},
				...(input.config.leaseTtlMs !== undefined
					? { leaseTtlMs: input.config.leaseTtlMs }
					: {}),
				...(startInput.drive.deadlineAt !== undefined
					? { deadlineAt: startInput.drive.deadlineAt }
					: {}),
				...(startInput.drive.onDelta !== undefined
					? { onDelta: startInput.drive.onDelta }
					: {}),
				// The SAME sink the cron drain uses. `onDelta` above is the door's own in-memory tee
				// for the reader in this invocation; this is the log everybody else reads, and the
				// two must not both write it or every delta lands twice.
				...(input.config.runStream !== undefined
					? { runStream: input.config.runStream }
					: {}),
			});
			// A driver that lost its lease mid-slice cannot claim to know how the run ended — a
			// successor may already own it. Reported, never guessed at.
			if (result.status === "failed" && result.task === null) {
				return { id: opened.run.id, notDriven: "driver-lost" };
			}
			// A slice that produced no result produced nothing to report. `skipped` is the reachable
			// case: the resume state this task named was already claimed, so somebody else is driving
			// and it is THEIR result that will land in the thread.
			if (runtimeResult === undefined) {
				return { id: opened.run.id, notDriven: "running-elsewhere" };
			}
			return { id: opened.run.id, result: runtimeResult };
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
					const stops = controlInput.intent !== "suspend";
					const withheld = await store.deadLetterPendingTasks(
						run.id,
						stops
							? "run cancelled before this task was claimed"
							: "run suspended before this task was claimed",
					);
					const settledRun = await store.updateRunIfStatus(run.id, {
						from: ["queued", "waiting"],
						patch: {
							...latch,
							status: stops ? "cancelled" : "waiting",
							waitReason: stops ? null : "suspended",
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
							type: stops ? "run.cancelled" : "run.suspended",
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
		async deliverMessage(
			messageInput: EngineDeliverMessageInput,
		): Promise<EngineDeliverMessageResult> {
			const admitted = await input.config.store.admitMessage({
				id: messageRowId(
					messageInput.toRunId,
					messageInput.sender,
					messageInput.idempotencyKey,
				),
				toRunId: messageInput.toRunId,
				body: messageInput.body,
				mode: messageInput.mode,
				sender: messageInput.sender,
				...(messageInput.containerKind !== undefined
					? { containerKind: messageInput.containerKind }
					: {}),
				...(messageInput.containerId !== undefined
					? { containerId: messageInput.containerId }
					: {}),
			});
			return admitted.admitted
				? { id: admitted.id, seq: admitted.seq, admitted: true }
				: {
						id: admitted.id,
						seq: admitted.seq,
						admitted: false,
						...(admitted.bounced ? { bounced: admitted.bounced } : {}),
					};
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
		// THIS ENGINE'S scheduling tables, readable without constructing it. `run`/`run_event` are not
		// here — they are core, because they are the governance record rather than scheduling state.
		models: sqlEngineModels,
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
