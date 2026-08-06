/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (patterns/architecture, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * - The claim/heartbeat/complete/fail loop is adapted from NullTickets' external worker protocol.
 * - The explicit runtime-task dispatch boundary is informed by NullBoiler's orchestrator/executor split.
 *
 * The worker drives operational runtime state only. Governance decisions and compliance audit remain
 * inside @busyclaw/core via @busyclaw/runtime.
 */

import type {
	EngineRecording,
	RunMode,
	RunStreamChunk,
	RunStreamLifecycle,
	RunStreamPort,
} from "@busyclaw/contracts";
import {
	asPrincipal,
	errorMessage,
	isReservedScope,
	type Principal,
	runStreamKey,
	safeFailureMessage,
	stateError,
	threadStreamKey,
	unsupportedOperationError,
	validationError,
} from "@busyclaw/contracts";
import {
	type RunControlPort,
	type RunParkReason,
	type Runtime,
	type RuntimeAbortSignal,
	type RuntimeResult,
	RuntimeResult as RuntimeResultSchema,
	runtimeRunOptionsWithCaller,
	runtimeRunOptionsWithRecording,
} from "@busyclaw/runtime";
import { type } from "arktype";
import type { ClaimedTask, RuntimeTask, SqlEngineStore } from "./store";
import { NON_TERMINAL_RUN_STATUSES } from "./store";

export const RUNTIME_RUN_TASK = "runtime.run";
export const RUNTIME_CONTINUE_RUN_TASK = "runtime.continueRun";
export const RUNTIME_RESUME_RUN_TASK = "runtime.resumeRun";

/** Attempts allowed for a resume task — see the enqueue site for why only this kind gets more
 *  than one. Small on purpose: this covers a crashed host, not a failing run. */
export const RESUME_MAX_ATTEMPTS = 3;

/** The principal a TASK names, when it names one. Only a handover continuation does. */
function slicePrincipalOf(task: RuntimeTask): Principal | undefined {
	const declared = task.payload["principal"];
	return typeof declared === "string" && declared.trim() !== ""
		? asPrincipal(declared)
		: undefined;
}

export const RuntimeRunTaskPayload = type({
	prompt: "string",
	"ctx?": type.Record("string", "unknown"),
});
export type RuntimeRunTaskPayload = typeof RuntimeRunTaskPayload.infer;

export const RuntimeContinueRunTaskPayload = type({
	approvalId: "string",
	"ctx?": type.Record("string", "unknown"),
});
export type RuntimeContinueRunTaskPayload =
	typeof RuntimeContinueRunTaskPayload.infer;

export const RuntimeResumeRunTaskPayload = type({
	checkpointId: "string",
	"ctx?": type.Record("string", "unknown"),
	/** WHOSE turn this continuation is. Present only on a handover — a slice that stopped because the
	 *  next message came from somebody else — and it is what makes per-slice authority real: the
	 *  continuation's tool calls are authorized against, and audited as, this principal rather than
	 *  the one who happened to start the run. */
	"principal?": "string | undefined",
});
export type RuntimeResumeRunTaskPayload =
	typeof RuntimeResumeRunTaskPayload.infer;

export type SqlEngineWorkerConfig = {
	store: SqlEngineStore;
	runtime: Runtime;
	workerId: string;
	leaseTtlMs?: number;
	/**
	 * Live deltas, for whoever is watching the conversation this run belongs to.
	 *
	 * WIRED HERE RATHER THAN AT THE DOOR, and that is the whole point: a run is sliced across
	 * invocations, so the second slice of a parked turn is driven by CRON — under a different
	 * process, minutes later — and a watcher who saw the first half must see the rest. Wherever the
	 * lease is, the chunks come from there.
	 *
	 * It also makes the writes single-sourced. The door briefly emitted its own text chunks beside
	 * this, which double-wrote every delta for the one path that has both.
	 */
	runStream?: RunStreamPort;
};

export type WorkerTickOptions = {
	/** Invocation soft deadline (ISO). Past it, tick claims nothing and reports idle. */
	deadlineAt?: string;
};

export type WorkerTickResult =
	| { status: "idle"; reason?: "deadline" }
	| { status: "waiting_approval"; task: RuntimeTask; approvalIds: string[] }
	| { status: "yielded"; task: RuntimeTask; checkpointId: string }
	/** Parked on an external intent. Unlike `yielded`, NO continuation task was enqueued — the run
	 *  waits until somebody asks it to proceed. `reason` is carried because a watcher shown "paused"
	 *  cannot act on it: "waiting for your approval" and "an operator suspended this" want different
	 *  things from the person reading. */
	| {
			status: "parked";
			task: RuntimeTask;
			checkpointId: string;
			reason: RunParkReason;
	  }
	/** Torn down mid-step by an abort. Distinct from `parked` because there is NO checkpoint: the
	 *  step was cancelled in flight, so there is no resumable point to have written. */
	| { status: "cancelled"; task: RuntimeTask }
	| { status: "completed"; task: RuntimeTask }
	/** The task had nothing left to do — its resume state is already claimed or spent. The task is
	 *  retired and the RUN is left exactly as it was. Not a failure: nobody's work was lost. */
	| { status: "skipped"; task: RuntimeTask; reason: string }
	| { status: "failed"; task: RuntimeTask | null; reason: string };

const WorkerRuntimeResult = RuntimeResultSchema;
type WorkerRuntimeResult = typeof WorkerRuntimeResult.infer;

function runtimeRunPayload(
	payload: Record<string, unknown>,
): RuntimeRunTaskPayload {
	const valid = RuntimeRunTaskPayload(payload);
	if (valid instanceof type.errors) {
		throw validationError("runtime.run task payload invalid", valid.summary);
	}
	return valid;
}

function runtimeContinueRunPayload(
	payload: Record<string, unknown>,
): RuntimeContinueRunTaskPayload {
	const valid = RuntimeContinueRunTaskPayload(payload);
	if (valid instanceof type.errors) {
		throw validationError(
			"runtime.continueRun task payload invalid",
			valid.summary,
		);
	}
	return valid;
}

function runtimeResumeRunPayload(
	payload: Record<string, unknown>,
): RuntimeResumeRunTaskPayload {
	const valid = RuntimeResumeRunTaskPayload(payload);
	if (valid instanceof type.errors) {
		throw validationError(
			"runtime.resumeRun task payload invalid",
			valid.summary,
		);
	}
	return valid;
}

function runtimeResult(result: unknown, label: string): RuntimeResult {
	const valid = RuntimeResultSchema(result);
	if (valid instanceof type.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	return valid;
}

function workerRuntimeResult(result: unknown): WorkerRuntimeResult {
	const valid = WorkerRuntimeResult(result);
	if (valid instanceof type.errors) {
		throw validationError("worker runtime result invalid", valid.summary);
	}
	return valid;
}

type TaskExecution =
	| {
			outcome: "ran";
			result: WorkerRuntimeResult;
			/** The task's parsed ctx — carried forward onto any continuation this slice enqueues. */
			ctx: Record<string, unknown> | undefined;
	  }
	/** Nothing to run: the resume state this task names is already claimed by a live attempt or has
	 *  been retired by one. Distinct from a failure, and the distinction is load-bearing — treating
	 *  it as one is what used to kill a healthy run. */
	| { outcome: "skipped"; reason: string };

async function runTask(
	runtime: Runtime,
	claim: ClaimedTask,
	control: RunControlPort,
	onBoundary: (boundary: { scope: string; scopeId: string }) => void,
	abortSignal?: RuntimeAbortSignal,
	deadlineAt?: string | (() => string | undefined),
	principal?: Principal,
	recording?: EngineRecording,
	model?: string,
	runMode?: RunMode,
	onDelta?: (text: string) => void | Promise<void>,
): Promise<TaskExecution> {
	// runId scopes effect ids and runtime events to the durable run, across attempts and slices;
	// deadlineAt lets the runtime park a yield checkpoint before the invocation's budget runs out.
	//
	// The PRINCIPAL comes from the durable RUN ROW, seeded through the forge-proof symbol option so it
	// lands as the stamped `busyclaw__principal` the floor reads. A durable run is the same run as the
	// one that started it — it is sliced across invocations, not re-authored by the worker — so it must
	// execute as the identity it was created for, and the run row is the only record of that which
	// survives the process. It went unnoticed while unstamped tools skipped the floor; with every tool
	// gated, a worker that omits it cannot execute ANY tool: the floor fails closed on an absent
	// identity rather than authorize a modeled action for nobody.
	// BOTH READ FROM THE RUN ROW, for the same reason the principal is. A run is sliced across
	// invocations, not re-authored by each one, so the invocation that chose the model and observed
	// the human is long gone by the time a continuation is claimed. `runMode` matters most on the
	// conversational path: leaving it unset here would default a chat turn to `autonomous` and
	// silently withdraw the human-presence exemption `authz/src/system-posture.ts` grants — a
	// fail-CLOSED behaviour change, which is the kind that ships unnoticed.
	const options = {
		abortSignal,
		runId: claim.task.runId,
		...(model !== undefined ? { model } : {}),
		...(runMode !== undefined ? { runMode } : {}),
		...(deadlineAt !== undefined ? { deadlineAt } : {}),
		// The engine, not the ingress, binds this — the intent outlives whichever process received it,
		// so every slice including a resumed one has to be able to see it.
		control,
		// Captured here, written by the caller once the slice ends. The runtime resolves the boundary
		// mid-run and has no store to write it with; the worker has the store and no idea what the
		// boundary is until the runtime says so.
		onAuthorityResolved: onBoundary,
	};
	const withCaller = runtimeRunOptionsWithCaller(options, principal);
	if (claim.task.kind === RUNTIME_RUN_TASK) {
		const payload = runtimeRunPayload(claim.task.payload);
		// A FIRST-SLICE task that is being claimed for the SECOND time is not a first slice. Its
		// payload carries only a prompt, so `generate` would seed the transcript from that prompt and
		// start at step 0 — re-running every step the earlier attempt already paid for, re-executing
		// its tool calls, and orphaning the checkpoint it wrote on the way down. That is why this task
		// kind is single-attempt today, and closing it is the prerequisite for it ever not being.
		//
		// Resolved by RUN id rather than from the run row's `resumeCheckpointId`: the column is written
		// by a later transaction than the checkpoint row, so a crash in between leaves the transcript
		// on disk with nothing pointing at it — exactly the case this is here to recover.
		const pending = await runtime.checkpoints?.latestPendingForRun(
			claim.task.runId,
		);
		if (pending) {
			const resumed = await runtime.resumeRun(
				pending.id,
				payload.ctx,
				withCaller,
			);
			// Lost the claim to a live attempt, or it was retired between the read and here. Either
			// way this task has nothing to do and must not fall through to `generate`, which would
			// restart the run.
			if (!resumed) {
				return {
					outcome: "skipped",
					reason: "run checkpoint is already claimed or spent",
				};
			}
			return {
				outcome: "ran",
				result: workerRuntimeResult(resumed),
				ctx: payload.ctx,
			};
		}
		// THE RECORDING IS APPLIED HERE AND NOWHERE ELSE — on the FIRST slice of a run, from the row.
		//
		// Not on the resume above, and not on the continue below, because those recover the recording
		// from their own durable record (`checkpoint.recording`, approval metadata) and both read
		// `options?.[RUNTIME_RECORDING_OPTION] ?? record.recording` — so an option supplied there wins
		// SILENTLY over the record. One writer per fact: the run row seeds the first slice, the
		// records own every resume. Threading it onto all three kinds re-opens an R-M10-shaped fork
		// with nothing testing it.
		const withRecording =
			recording === undefined
				? withCaller
				: runtimeRunOptionsWithRecording(withCaller, {
						clawId: recording.clawId,
						threadId: recording.threadId,
						runId: claim.task.runId,
						userMessageId: recording.originMessageId,
					});
		// STREAMING IS THE SAME SLICE, driven through a different door. Everything above — the
		// recording, the caller, the control port, the checkpoint recovery — is identical; only the
		// runtime method differs, which is the point: a streamed turn must be governed and persisted
		// exactly like a generated one, not by a parallel path that can drift.
		//
		// The stream MUST be consumed. Its channel is bounded (`STREAM_DELTA_BUFFER`), so a producer
		// whose deltas nobody reads blocks and the run parks — "ignore the stream" is not an option
		// available here, only "read it and drop it", which is what happens when the door's own reader
		// has already left.
		if (onDelta !== undefined) {
			const streamed = runtime.stream(
				payload.prompt,
				payload.ctx,
				withRecording,
			);
			for await (const delta of streamed.textStream) await onDelta(delta);
			return {
				outcome: "ran",
				result: runtimeResult(await streamed.result, "runtime.stream result"),
				ctx: payload.ctx,
			};
		}
		return {
			outcome: "ran",
			result: runtimeResult(
				await runtime.generate(payload.prompt, payload.ctx, withRecording),
				"runtime.generate result",
			),
			ctx: payload.ctx,
		};
	}

	if (claim.task.kind === RUNTIME_RESUME_RUN_TASK) {
		const payload = runtimeResumeRunPayload(claim.task.payload);
		const rawResumeResult = await runtime.resumeRun(
			payload.checkpointId,
			payload.ctx,
			withCaller,
		);
		// A null here means the checkpoint is held by a live attempt or already retired by one — the
		// expected outcome of a duplicate task, not a fault of this run. It used to throw, which routed
		// to failClaim and (with maxAttempts 1) marked a perfectly healthy run `failed`.
		if (!rawResumeResult) {
			return {
				outcome: "skipped",
				reason: "run checkpoint is already claimed or spent",
			};
		}
		return {
			outcome: "ran",
			result: workerRuntimeResult(rawResumeResult),
			ctx: payload.ctx,
		};
	}

	const payload = runtimeContinueRunPayload(claim.task.payload);
	const rawApprovalResult = await runtime.continueRun(
		payload.approvalId,
		payload.ctx,
		withCaller,
	);
	// Same reasoning as the resume above: a second continuation for one approval finds it spent.
	if (!rawApprovalResult) {
		return {
			outcome: "skipped",
			reason: "approval is already claimed or spent",
		};
	}
	return {
		outcome: "ran",
		result: workerRuntimeResult(rawApprovalResult),
		ctx: payload.ctx,
	};
}

async function failClaim(
	store: SqlEngineStore,
	claim: ClaimedTask,
	reason: string,
): Promise<WorkerTickResult> {
	return store.transaction(async (tx) => {
		const task = await tx.failTask({
			taskId: claim.task.id,
			leaseToken: claim.leaseToken,
			reason,
		});
		if (task) {
			await tx.appendEvent({
				runId: task.runId,
				type: "task.failed",
				payload: { taskId: task.id, reason },
			});
		}
		if (task?.status === "dead") {
			await tx.updateRun(task.runId, { status: "failed" });
			await tx.appendEvent({
				runId: task.runId,
				type: "run.failed",
				payload: { taskId: task.id, reason },
			});
		}
		return { status: "failed", task, reason };
	});
}

type WorkerAbortController = {
	signal: RuntimeAbortSignal;
	abort: () => void;
};

/** Warned once per process, not once per task — a host without AbortController would otherwise
 *  emit this on every claim, which is how a real warning becomes noise nobody reads. */
let warnedMissingAbortController = false;

function createWorkerAbortController(): WorkerAbortController {
	const Controller = (
		globalThis as { AbortController?: new () => WorkerAbortController }
	).AbortController;
	if (Controller) return new Controller();
	// LOUD, because `abort` silently means something weaker here. `combinedAbortSignal` only reaches
	// the provider's `fetch` when both halves are real platform signals, so on a host without one an
	// abort degrades to the cooperative check at the next loop or tool boundary — it stops the run,
	// but it does not tear down the request already in flight. A stop mode that quietly means
	// something else is the worst failure this design can have.
	if (!warnedMissingAbortController) {
		warnedMissingAbortController = true;
		console.warn(
			"busyclaw engine: globalThis.AbortController is absent — `abort` degrades to a cooperative stop and will NOT cancel an in-flight provider request",
		);
	}
	const signal = { aborted: false };
	return {
		signal,
		abort: () => {
			signal.aborted = true;
		},
	};
}

type HeartbeatHandle = {
	stop: () => void;
	abortSignal: RuntimeAbortSignal;
	lost: Promise<string>;
	isLost: () => boolean;
	lostReason: () => string | undefined;
	/** The abort was ASKED FOR, not a lease that lapsed. Decides whether the terminal status this
	 *  slice writes is `cancelled` or `failed`, which is the whole difference between "somebody
	 *  stopped it" and "it broke". */
	abortedByIntent: () => boolean;
	/** The current step's interrupt hook, replaced every step by the loop. */
	setInterrupt: (fire: () => void) => void;
};

function startHeartbeat(
	store: SqlEngineStore,
	claim: ClaimedTask,
	leaseTtlMs: number | undefined,
): HeartbeatHandle {
	const ttl = leaseTtlMs ?? 60_000;
	const intervalMs = Math.max(250, Math.floor(ttl / 2));
	const timers = globalThis as typeof globalThis & {
		setInterval: (fn: () => void, ms: number) => { unref?: () => void };
		clearInterval: (timer: unknown) => void;
	};
	const abortController = createWorkerAbortController();
	let lostReason: string | undefined;
	let resolveLost: (reason: string) => void = () => {};
	const lost = new Promise<string>((resolve) => {
		resolveLost = resolve;
	});
	const markLost = (reason: string): void => {
		if (lostReason !== undefined) return;
		lostReason = reason;
		abortController.abort();
		resolveLost(reason);
	};
	// ABORT rides this timer rather than getting one of its own. The heartbeat already round-trips
	// the database every `max(250, ttl/2)` ms and already owns the AbortController, so observing the
	// latch here costs one narrow read on a timer that exists — and it is the ONLY place that can
	// reach an in-flight provider call, because a step can be minutes long and the loop's control
	// point does not run again until that step returns.
	let interruptFire: (() => void) | undefined;
	let intentAborted = false;
	const markAborted = (): void => {
		if (intentAborted || lostReason !== undefined) return;
		intentAborted = true;
		// Deliberately NOT resolving `lost`: this is not a lease failure, and letting it travel as one
		// would report a deliberate cancellation as a vanished host.
		abortController.abort();
	};
	const timer = timers.setInterval(() => {
		void store
			.heartbeatLease({
				leaseId: claim.leaseId,
				leaseToken: claim.leaseToken,
				leaseTtlMs,
			})
			.then(async (lease) => {
				if (!lease) {
					markLost("task lease heartbeat failed");
					return;
				}
				const run = await store.getRun(claim.task.runId);
				if (run?.controlIntent === "abort") {
					markAborted();
					return;
				}
				// An `interrupt`-mode message cannot be noticed by the loop's control point, which does
				// not run again until the in-flight model call returns. This timer is the only thing
				// awake during that call, so it is the only thing that can cancel it.
				if (
					interruptFire &&
					(await store.hasPendingInterrupt(claim.task.runId))
				) {
					const fire = interruptFire;
					interruptFire = undefined;
					fire();
				}
			})
			.catch((err) => {
				markLost(errorMessage(err));
			});
	}, intervalMs) as { unref?: () => void };
	timer.unref?.();
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		timers.clearInterval(timer);
	};
	return {
		abortSignal: abortController.signal,
		isLost: () => lostReason !== undefined,
		lost,
		lostReason: () => lostReason,
		abortedByIntent: () => intentAborted,
		setInterrupt: (fire) => {
			interruptFire = fire;
		},
		stop,
	};
}

export function createSqlEngineWorker(config: SqlEngineWorkerConfig): {
	tick: (options?: WorkerTickOptions) => Promise<WorkerTickResult>;
} {
	const { store, runtime, workerId, leaseTtlMs, runStream } = config;
	const now = store.now;
	return {
		async tick(options?: WorkerTickOptions) {
			const deadlineAt = options?.deadlineAt;
			// Budget spent → claim nothing, end the drain cleanly. The pending task waits for the
			// next invocation instead of being killed mid-run by the platform.
			if (deadlineAt !== undefined && now() >= deadlineAt) {
				return { status: "idle", reason: "deadline" };
			}
			// SELECTION is the only thing a tick does that a caller-driven claim must not: it takes the
			// oldest due task, which for a caller would mean driving somebody else's run.
			const claim = await store.claimDueTask({ workerId, leaseTtlMs });
			if (!claim) return { status: "idle" };
			const result = await driveClaim({
				claim,
				runtime,
				store,
				workerId,
				...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
				...(deadlineAt !== undefined ? { deadlineAt } : {}),
				...(runStream !== undefined ? { runStream } : {}),
			});
			// HOW THIS SLICE ENDED, told to whoever is watching the conversation.
			//
			// Emitted HERE rather than inside `driveClaim` because that function has twenty exits and
			// one entry; a caller driving its own turn announces its own ending from the result it
			// hands back. One writer per SLICE either way — the door and the drain never drive the
			// same claim — which is the unit that matters, since a parked turn's second slice belongs
			// to whichever process resumed it.
			await emitSliceEnd({
				runStream,
				store,
				runId: claim.task.runId,
				attempt: claim.task.attempt,
				result,
			});
			return result;
		},
	};
}

/**
 * What a WATCHER is told when a slice ends, mapped from what the drain got back.
 *
 * `skipped` and `idle` emit NOTHING, deliberately: a duplicate task that found its resume state
 * already claimed did not end anything, and saying "completed" on its behalf would close a watcher's
 * view of a turn that is still going under somebody else's lease.
 */
async function emitSliceEnd(input: {
	runStream: RunStreamPort | undefined;
	store: SqlEngineStore;
	runId: string;
	attempt: number;
	result: WorkerTickResult;
}): Promise<void> {
	const { runStream, store, runId, attempt, result } = input;
	if (runStream === undefined) return;
	// EXHAUSTIVE, by a switch whose default is `never`. This was a conditional chain ending in
	// `undefined`, which is how `yielded` came to be reported as `parked` for months: the chain
	// grouped three statuses that mean three different things, and nothing failed when it did. A new
	// `WorkerTickResult` member now has to be classified here or this stops compiling.
	const told = ((): { event: RunStreamLifecycle; reason?: string } | null => {
		switch (result.status) {
			case "completed":
				return { event: "completed" };
			case "failed":
				return { event: "failed" };
			case "cancelled":
				return { event: "cancelled" };
			// COMES BACK ON ITS OWN. A continuation is already enqueued, so a reader told "paused"
			// would be watching a turn that is still going.
			case "yielded":
				return { event: "yielded" };
			// WAITS FOR A VERB, and `reason` says which one — "an operator suspended this" and
			// "somebody stopped this" want different things from the person reading.
			case "parked":
				return { event: "parked", reason: result.reason };
			// Also a park, and the one where the reason matters most: this is the state where the
			// reader is the person who can end it.
			case "waiting_approval":
				return { event: "parked", reason: "approval" };
			// NOTHING ENDED. A drain that found no work, or a duplicate task whose resume state was
			// already claimed — saying "completed" on either's behalf would close a watcher's view of
			// a turn that is still going under somebody else's lease.
			case "idle":
			case "skipped":
				return null;
			default: {
				const unreachable: never = result;
				throw stateError("unhandled worker result in slice-end emit", {
					status: (unreachable as { status?: unknown }).status,
				});
			}
		}
	})();
	if (told === null) return;
	try {
		const run = await store.getRun(runId);
		const key =
			run?.threadId !== undefined
				? threadStreamKey(run.threadId)
				: runStreamKey(runId);
		await runStream.append(key, {
			kind: "lifecycle",
			runId,
			attempt,
			event: told.event,
			...(told.reason !== undefined ? { reason: told.reason } : {}),
		});
	} catch {
		// Advisory, like every other write to this buffer.
	}
}

/**
 * Drive one ALREADY-CLAIMED task to a terminal transition.
 *
 * Everything after the claim, and nothing about acquiring one — so the two things that can hold a
 * lease (a cron drain, and a caller driving its own run in its own invocation) share one body. That
 * matters more than it looks: each branch of the terminal switch below carries a race argument that
 * took a bug to learn, and the `const unreachable: never` at the end is the only reason a new
 * `RuntimeResult` variant is a compile error instead of a silent fall-through to `completed`. A
 * second copy would make that guarantee local to whichever file you happened to be editing.
 *
 * The heartbeat and the control port are PER CLAIM. They used to be per WORKER, resting on "one tick
 * runs one task" — the moment two claims are driven in one process, a shared heartbeat would arm the
 * wrong run's AbortController.
 */
export async function driveClaim(input: {
	store: SqlEngineStore;
	runtime: Runtime;
	claim: ClaimedTask;
	workerId: string;
	leaseTtlMs?: number;
	/** A FUNCTION is a deadline that can move: a door hands one so a reader walking away brings the
	 *  yield forward to now. The cron drain hands a scalar — its budget is fixed at the firing. */
	deadlineAt?: string | (() => string | undefined);
	/** Live deltas for whoever is watching. Threaded from the worker config so the cron path — which
	 *  drives the second slice of a parked turn — writes the same log the door does. */
	runStream?: RunStreamPort;
	/** Present only when a DOOR is driving its own turn and streaming it. The cron drain never sets
	 *  it — nobody is waiting on the other end of a scheduled run. */
	onDelta?: (text: string) => void | Promise<void>;
	/**
	 * The runtime's OWN result, handed over the moment the slice produces one.
	 *
	 * `WorkerTickResult` answers "what happened to the task"; a caller waiting on its own turn needs
	 * "what did the model say", and those are different objects. A callback rather than a return
	 * field because the terminal switch has twenty exits and threading a value through every one of
	 * them is twenty chances to forget — this fires once, at the single point where the result
	 * exists, before any of them run.
	 */
	onResult?: (result: RuntimeResult) => void;
}): Promise<WorkerTickResult> {
	const {
		claim,
		deadlineAt,
		leaseTtlMs,
		onDelta,
		onResult,
		runStream,
		runtime,
		store,
		workerId,
	} = input;
	const heartbeat = startHeartbeat(store, claim, leaseTtlMs);
	// WHO THIS SLICE EXECUTES AS, and who it must hand over to. Recorded here rather than returned
	// through the loop because the loop is deliberately principal-blind: it is told to stop, not told
	// whose turn is next. Set by the drain when it meets a message from somebody else; read by the
	// yield branch, which enqueues the continuation under that person.
	let sliceAs: Principal | undefined;
	let handoverTo: Principal | undefined;
	// One read of the run row per step. `controlRequestedAt` present IS the intent — the loop is told
	// only the park reason, never the ladder, so raising `stop` later changes this file and nothing
	// upstream of it.
	const controlPort: RunControlPort = {
		armInterrupt: (_runId, fire) => {
			heartbeat.setInterrupt(fire);
		},
		poll: async (runId, seenSeq, deliveredThrough) => {
			// ONE primary-key read per step, and that is the steady-state cost of the whole control
			// plane. The message table is touched only when one of the two watermarks on this row says
			// there is something to see.
			const run = await store.getRun(runId);
			if (!run) return { seq: seenSeq };
			const seq = run.controlSeq ?? 0;
			// WHETHER THERE IS ANYTHING TO DRAIN, asked directly rather than inferred. The inbox has its
			// own counter now (C3), so a control write no longer numbers messages — and this used to
			// lean on the fact that it did: the skip below compared `controlSeq` alone, so once admits
			// stopped bumping it, every message was stored, acknowledged, and never read.
			//
			// `messageSeq` is the highest seq admitted; `deliveredThrough` is the highest the transcript
			// holds. That comparison IS the question, where the old one was a proxy for it.
			// Floored at 0 because the two counters start from different places: `messageSeq` is 0 on a
			// run nobody has written to, while `deliveredThrough` is -1 for "the transcript holds none".
			// Compared raw, `0 > -1` reads as "there is a message" on every step of every quiet run and
			// the one-read-per-step budget becomes two.
			const undrained = (run.messageSeq ?? 0) > Math.max(deliveredThrough, 0);
			// The LADDER collapses to what the loop can act on. `abort` is not a different park — it
			// tears down the in-flight call as well, which the heartbeat does; here it parks like a
			// stop rather than being silently ignored.
			const park =
				run.controlRequestedAt !== undefined
					? run.controlIntent === "suspend"
						? ("suspended" as const)
						: ("stopped" as const)
					: undefined;
			if (seq === seenSeq && !undrained) {
				return { seq, ...(park ? { park } : {}) };
			}
			const drained = await store.drainMessages({
				toRunId: runId,
				afterSeq: deliveredThrough,
				step: 0,
				runAs: sliceAs,
			});
			// A foreign sender ends the slice. Everything ahead of them still lands in THIS turn — the
			// run's own FIFO is preserved — and the message that stopped the drain stays pending, so
			// the continuation drains it as the person who sent it.
			if (drained.handoverTo !== undefined) {
				handoverTo = drained.handoverTo;
			}
			return {
				seq,
				...(park
					? { park }
					: drained.handoverTo !== undefined
						? { park: "handover" as const }
						: {}),
				...(drained.delivered.length ? { deliver: drained.delivered } : {}),
			};
		},
	};
	try {
		if (
			claim.task.kind !== RUNTIME_RUN_TASK &&
			claim.task.kind !== RUNTIME_CONTINUE_RUN_TASK &&
			claim.task.kind !== RUNTIME_RESUME_RUN_TASK
		) {
			heartbeat.stop();
			return failClaim(
				store,
				claim,
				unsupportedOperationError(`unsupported task kind: ${claim.task.kind}`, {
					kind: claim.task.kind,
				}).message,
			);
		}

		await store.appendEvent({
			runId: claim.task.runId,
			type: "run.started",
			payload: { taskId: claim.task.id, workerId },
		});

		// The identity this durable run belongs to, read from the run row rather than invented
		// by the worker. A run with none executes with none, and the floor refuses it — which is
		// the correct answer for a task nobody can be shown to have asked for.
		const run = await store.getRun(claim.task.runId);
		// WHO THIS SLICE RUNS AS. `run.principal` is who STARTED the run; a slice created by a handover
		// carries its own on the task, because the whole point is that it executes as somebody else.
		// One resolution, before anything can act, so the drain and the tool floor agree by
		// construction rather than by both reading the row and hoping.
		sliceAs = slicePrincipalOf(claim.task) ?? run?.principal;
		// WHERE THIS SLICE'S DELTAS GO — the thread when the run has one (a watcher subscribes to a
		// conversation), the run itself when it does not (cron, a subagent: nobody is watching a
		// conversation because there is not one). Resolved from the SAME row read that gave the
		// principal, so a slice cannot disagree with itself about which log it is writing to.
		const streamKey =
			run?.threadId !== undefined
				? threadStreamKey(run.threadId)
				: runStreamKey(claim.task.runId);
		const attempt = claim.task.attempt;
		const emit = async (chunk: RunStreamChunk): Promise<void> => {
			if (runStream === undefined) return;
			try {
				await runStream.append(streamKey, chunk);
			} catch {
				// ADVISORY. A run whose deltas nobody could persist still completes and still lands in
				// the transcript; only the live view degrades. Propagating here would let a broken
				// buffer fail work that was otherwise perfect.
			}
		};
		// A SECOND ATTEMPT MEANS THE ANSWER RESTARTED, and a watcher has to be told before the new
		// text arrives. The buffer sits outside the lease fence, so a driver whose lease lapsed may
		// still be appending its own generation; this is what lets a client drop everything below
		// this attempt for this run rather than splice two answers into one sentence.
		if (attempt > 1) {
			await emit({
				kind: "lifecycle",
				runId: claim.task.runId,
				attempt,
				event: "superseded",
			});
		}
		// The boundary this slice resolves, recorded once the slice ends. A run started by a
		// system principal on behalf of a tenant is otherwise owned by nobody a tenant admin
		// can name — the PEP isolates by the run's own principal, and that principal is the
		// system.
		let boundary: { scope: string; scopeId: string } | undefined;
		const runtimeTask = runTask(
			runtime,
			claim,
			controlPort,
			(resolved) => {
				boundary = resolved;
			},
			heartbeat.abortSignal,
			deadlineAt,
			sliceAs,
			// From the SAME row read that yielded the principal. The run row is the only record of
			// where a durable run's output belongs that survives the process, and reading it twice
			// would be two chances to disagree.
			run?.clawId !== undefined && run.threadId !== undefined
				? {
						clawId: run.clawId,
						threadId: run.threadId,
						originMessageId: run.originMessageId,
					}
				: undefined,
			run?.model,
			run?.runMode,
			// STREAMING IS THE CALLER'S REQUEST, NEVER IMPLIED BY HAVING A SINK — and that distinction
			// is load-bearing rather than stylistic. `onDelta` is what makes `runTask` drive through
			// `runtime.stream`, which needs a vendor that supports it and REFUSES a `noPiiRedaction`
			// model outright. Turning it on merely because a run stream is configured would make
			// enabling live watching change how every ordinary `sendMessage` executes, and break the
			// ones whose model cannot stream at all.
			//
			// So: when a caller asked for deltas, they also feed the log. When nobody did, the log
			// gets the answer in one piece after the fact (below) — a watcher sees it arrive whole,
			// which is honest, because the pieces genuinely never existed.
			onDelta === undefined
				? undefined
				: async (text: string) => {
						await emit({
							kind: "text",
							runId: claim.task.runId,
							attempt,
							text,
						});
						await onDelta(text);
					},
		);
		void runtimeTask.catch(() => undefined);
		const execution = await Promise.race([
			runtimeTask,
			heartbeat.lost.then((reason) => {
				throw stateError("task lease lost during runtime execution", {
					taskId: claim.task.id,
					reason,
				});
			}),
		]);
		if (heartbeat.isLost()) {
			return {
				status: "failed",
				task: null,
				reason: stateError("task lease lost before terminal transition", {
					taskId: claim.task.id,
					reason: heartbeat.lostReason(),
				}).message,
			};
		}

		// Written before any of the terminal branches below, so a run is attributable as soon as
		// its first slice ends however that slice ended — a parked or failed run is exactly the
		// one a tenant admin most needs to find.
		// A RESERVED scope is not written. `UNSCOPED` is the boundary core mints for the ABSENCE
		// of one, and recording it would turn "this run belongs to nothing" into a value that
		// looks exactly like a boundary every other unscoped run in the deployment also shares.
		// An absent column says the same thing and cannot be mistaken for a tenant.
		if (boundary && !isReservedScope(boundary.scope)) {
			await store.updateRun(claim.task.runId, {
				scope: boundary.scope,
				scopeId: boundary.scopeId,
			});
		}

		if (execution.outcome === "skipped") {
			// Retire the task, touch NOTHING on the run. Whoever holds the resume state owns the
			// run's status; a duplicate task must not narrate an outcome it did not produce.
			const reason = execution.reason;
			return store.transaction(async (tx) => {
				const task = await tx.completeTask({
					taskId: claim.task.id,
					leaseToken: claim.leaseToken,
					output: { skipped: reason },
				});
				if (!task)
					return {
						status: "failed",
						task: null,
						reason: stateError("lease lost before skip transition", {
							taskId: claim.task.id,
						}).message,
					};
				await tx.appendEvent({
					runId: task.runId,
					type: "task.skipped",
					payload: { taskId: task.id, reason },
				});
				return { status: "skipped", task, reason };
			});
		}

		const result = execution.result;
		// ONE point, before the terminal switch, where "what the model said" is known. Every branch
		// below narrates what happened to the TASK; a door waiting on its own turn needs this.
		onResult?.(result);
		// A SLICE NOBODY STREAMED still owes its watchers the answer — cron driving the second half
		// of a parked turn is the case that matters, since the person who saw the first half is
		// watching a conversation nothing else will write to. One chunk, after the fact, because the
		// deltas were never produced: pretending otherwise by splitting the text here would invent a
		// timeline the run did not have.
		if (onDelta === undefined && result.text !== "") {
			await emit({
				kind: "text",
				runId: claim.task.runId,
				attempt,
				text: result.text,
			});
		}

		if (result.status === "yielded") {
			// Self-continuation: park is already durable (the runtime persisted the checkpoint);
			// one transaction completes this slice and enqueues the next. The run returns to
			// "queued" — honest: a due task exists. Original ctx rides along on the continuation.
			const ctx = execution.ctx;
			const checkpointId = result.checkpointId;
			return store.transaction(async (tx) => {
				const task = await tx.completeTask({
					taskId: claim.task.id,
					leaseToken: claim.leaseToken,
					output: { result },
				});
				if (!task)
					return {
						status: "failed",
						task: null,
						reason: stateError("lease lost before yield transition", {
							taskId: claim.task.id,
						}).message,
					};
				// CONDITIONAL, like every sibling branch — this was the one that stayed unconditional.
				// A run that reached `cancelled` between this slice starting and this transaction
				// committing was walked back into flight, and worse, WITH A CONTINUATION BEHIND IT:
				// the enqueue below would then hand a stopped run its next slice. Losing here means
				// somebody else already decided how this run ends, so the resume is not enqueued and
				// the winner is reported rather than overwritten.
				// CONDITIONAL, like every sibling branch — this was the one that stayed unconditional.
				// A run that reached `cancelled` between this slice starting and this transaction
				// committing was walked back into flight, and worse, WITH A CONTINUATION BEHIND IT:
				// the enqueue below would then hand a stopped run its next slice. Losing here means
				// somebody else already decided how this run ends, so the resume is not enqueued and
				// the winner is reported rather than overwritten.
				const requeued = await tx.updateRunIfStatus(task.runId, {
					from: NON_TERMINAL_RUN_STATUSES,
					patch: { status: "queued" },
				});
				if (!requeued) {
					const current = await tx.getRun(task.runId);
					return {
						status: "skipped",
						task,
						reason: `run already ${current?.status ?? "terminal"}`,
					};
				}
				await tx.appendEvent({
					runId: task.runId,
					type: "run.yielded",
					payload: {
						taskId: task.id,
						checkpointId,
						steps: result.steps,
					},
				});
				await tx.enqueueTask({
					kind: RUNTIME_RESUME_RUN_TASK,
					runId: task.runId,
					payload: {
						checkpointId,
						...(ctx !== undefined ? { ctx } : {}),
						// PER-SLICE AUTHORITY, carried on the task because that is the only thing the
						// next claim reads before it acts. Present only on a handover; absent, the
						// continuation falls back to the run's own principal, which is every other
						// yield. Without it a handover would checkpoint correctly and then resume as
						// exactly the person it was handing away from.
						...(handoverTo !== undefined ? { principal: handoverTo } : {}),
					},
					// Retryable, unlike `runtime.run`. A resume task names its work by checkpoint id
					// and that work is now RE-CLAIMABLE after a crash, so a second attempt continues
					// the same transcript. (`runtime.run` carries only a prompt and would re-run the
					// whole run from step 0, which is why its single attempt stays.) Without this the
					// checkpoint's lease could lapse with no task left alive to take it.
					maxAttempts: RESUME_MAX_ATTEMPTS,
				});
				return { status: "yielded", task, checkpointId };
			});
		}

		if (result.status === "waiting_approval") {
			// `waiting_approval` returns from INSIDE the tool loop, before the `for` increment, so
			// it never reaches the loop-top control site — and the worker then enqueues nothing.
			// A latch raised during that window would otherwise be observed only when a human
			// happens to decide the approval, which is not a bound at all.
			//
			// A STOP is honoured here: waiting for someone to approve an action that will never
			// run is the worst of both. A SUSPEND is not — the run is already parked and not
			// consuming anything, so the latch simply persists and is honoured at the first
			// control point after it resumes.
			const latched = await store.getRun(claim.task.runId);
			if (
				latched?.controlIntent === "stop" ||
				latched?.controlIntent === "abort"
			) {
				const requestedBy = latched.controlRequestedBy;
				return store.transaction(async (tx) => {
					const task = await tx.completeTask({
						taskId: claim.task.id,
						leaseToken: claim.leaseToken,
						output: { result },
					});
					if (!task)
						return {
							status: "failed",
							task: null,
							reason: stateError("lease lost before approval stop", {
								taskId: claim.task.id,
							}).message,
						};
					const settled = await tx.updateRunIfStatus(task.runId, {
						from: NON_TERMINAL_RUN_STATUSES,
						patch: {
							status: "cancelled",
							waitReason: null,
							controlRequestedAt: null,
							controlIntent: null,
							controlRequestedBy: null,
							controlReason: null,
						},
					});
					if (!settled) {
						const current = await tx.getRun(task.runId);
						return {
							status: "skipped",
							task,
							reason: `run already ${current?.status ?? "terminal"}`,
						};
					}
					await tx.appendEvent({
						runId: task.runId,
						type: "run.cancelled",
						payload: {
							taskId: task.id,
							reason: "stopped-while-awaiting-approval",
							...(requestedBy ? { requestedBy } : {}),
						},
					});
					return { status: "cancelled", task };
				});
			}
			return store.transaction(async (tx) => {
				const task = await tx.completeTask({
					taskId: claim.task.id,
					leaseToken: claim.leaseToken,
					output: { result },
				});
				if (!task)
					return {
						status: "failed",
						task: null,
						reason: stateError("lease lost before approval wait", {
							taskId: claim.task.id,
						}).message,
					};
				// Same reasoning: a run a stop already cancelled must not be walked back to `waiting`
				// by a slice that was mid-flight when the stop landed.
				const parked = await tx.updateRunIfStatus(task.runId, {
					from: NON_TERMINAL_RUN_STATUSES,
					patch: { status: "waiting", waitReason: "approval" },
				});
				if (!parked) {
					const current = await tx.getRun(task.runId);
					return {
						status: "skipped",
						task,
						reason: `run already ${current?.status ?? "terminal"}`,
					};
				}
				await tx.appendEvent({
					runId: task.runId,
					type: "run.waiting_approval",
					payload: {
						taskId: task.id,
						approvalIds: result.approvalIds ?? [],
					},
				});
				return {
					status: "waiting_approval",
					task,
					approvalIds: result.approvalIds ?? [],
				};
			});
		}

		if (result.status === "parked") {
			// A PARK, not a yield: the runtime already persisted the checkpoint, and this branch
			// deliberately enqueues NOTHING. That single omission is the whole difference — a
			// yielded run leaves a due task behind and comes back on its own, a parked one waits
			// for somebody to ask. The latch is cleared here, in the same transaction that honours
			// it, so a crash before this point leaves the intent live for the re-run.
			const checkpointId = result.checkpointId;
			const parkReason = result.reason;
			// Read BEFORE the latch is cleared below — "who stopped this run" is the one fact the
			// cancellation event exists to carry, and the transaction that records it is the same
			// one that erases its source.
			const current_requester = (await store.getRun(claim.task.runId))
				?.controlRequestedBy;
			return store.transaction(async (tx) => {
				const task = await tx.completeTask({
					taskId: claim.task.id,
					leaseToken: claim.leaseToken,
					output: { result },
				});
				if (!task)
					return {
						status: "failed",
						task: null,
						reason: stateError("lease lost before park transition", {
							taskId: claim.task.id,
						}).message,
					};
				// A STOP is terminal; a suspend is not. Both leave the checkpoint `pending` on purpose:
				// it is the forensic record of what the run actually did, and the one way back if an
				// operator decides the stop was wrong. Consuming it here would destroy the
				// transcript to save a row.
				const stopped = parkReason === "stopped";
				const settled = await tx.updateRunIfStatus(task.runId, {
					from: NON_TERMINAL_RUN_STATUSES,
					patch: {
						status: stopped ? "cancelled" : "waiting",
						waitReason: stopped ? null : parkReason,
						resumeCheckpointId: checkpointId,
						controlRequestedAt: null,
						controlIntent: null,
						controlRequestedBy: null,
						controlReason: null,
					},
				});
				// Lost to a terminal status somebody else wrote first. Report the winner rather
				// than relabelling it — a run_event stream that contradicts `run.status` is worse
				// than either answer alone.
				if (!settled) {
					const current = await tx.getRun(task.runId);
					return {
						status: "skipped",
						task,
						reason: `run already ${current?.status ?? "terminal"}`,
					};
				}
				await tx.appendEvent({
					runId: task.runId,
					type: stopped ? "run.cancelled" : "run.parked",
					payload: {
						taskId: task.id,
						checkpointId,
						reason: parkReason,
						steps: result.steps,
						...(stopped && current_requester
							? { requestedBy: current_requester }
							: {}),
					},
				});
				return { status: "parked", task, checkpointId, reason: result.reason };
			});
		}

		if (result.status === "completed" || result.status === "denied") {
			const terminal = result;
			return store.transaction(async (tx) => {
				const task = await tx.completeTask({
					taskId: claim.task.id,
					leaseToken: claim.leaseToken,
					output: { result: terminal },
				});
				if (!task)
					return {
						status: "failed",
						task: null,
						reason: stateError("lease lost before completion", {
							taskId: claim.task.id,
						}).message,
					};

				// CONDITIONAL, because a stop can land while the last step is still running. Exactly
				// one terminal status survives, and the loser reports the winner instead of
				// relabelling it — otherwise whichever wrote last decides the story, and the
				// run_event stream ends up contradicting `run.status`.
				const settled = await tx.updateRunIfStatus(task.runId, {
					from: NON_TERMINAL_RUN_STATUSES,
					patch: { status: "completed" },
				});
				if (!settled) {
					const current = await tx.getRun(task.runId);
					return {
						status: "skipped",
						task,
						reason: `run already ${current?.status ?? "terminal"}`,
					};
				}
				await tx.appendEvent({
					runId: task.runId,
					type: "run.completed",
					payload: { taskId: task.id, result: terminal },
				});
				return { status: "completed", task };
			});
		}

		// EXHAUSTIVE. This was a fall-through, which meant any result the branches above did not
		// name was silently written `completed` — a parked run would have been reported as having
		// finished, with its checkpoint left dangling. A new variant fails to compile here now.
		{
			const unreachable: never = result;
			throw stateError("unhandled runtime result in worker", {
				status: (unreachable as { status?: unknown }).status,
			});
		}
	} catch (err) {
		// AN ABORT IS NOT A FAILURE, and this is the only place that can tell the difference.
		// Firing the heartbeat's controller fires `state.abortSignal`, so the loop unwinds
		// through the ordinary abort path and arrives here as an exception — indistinguishable
		// from a real one unless the latch that caused it is read back. Without this branch a
		// deliberate cancellation is recorded as `failed`, with the operator who asked for it
		// nowhere in the record.
		if (heartbeat.abortedByIntent()) {
			heartbeat.stop();
			const requestedBy = (await store.getRun(claim.task.runId))
				?.controlRequestedBy;
			return store.transaction(async (tx) => {
				const task = await tx.completeTask({
					taskId: claim.task.id,
					leaseToken: claim.leaseToken,
					output: { aborted: true },
				});
				if (!task)
					return {
						status: "failed",
						task: null,
						reason: stateError("lease lost before abort transition", {
							taskId: claim.task.id,
						}).message,
					};
				const settled = await tx.updateRunIfStatus(task.runId, {
					from: NON_TERMINAL_RUN_STATUSES,
					patch: {
						status: "cancelled",
						controlRequestedAt: null,
						controlIntent: null,
						controlRequestedBy: null,
						controlReason: null,
					},
				});
				if (!settled) {
					const current = await tx.getRun(task.runId);
					return {
						status: "skipped",
						task,
						reason: `run already ${current?.status ?? "terminal"}`,
					};
				}
				await tx.appendEvent({
					runId: task.runId,
					type: "run.cancelled",
					payload: {
						taskId: task.id,
						reason: "aborted",
						...(requestedBy ? { requestedBy } : {}),
					},
				});
				// NO checkpoint: an abort tears down mid-step, so there is no resumable point to
				// record. That is the cost the caller accepted by escalating past `stop`, which
				// parks cleanly and keeps its transcript.
				return { status: "cancelled", task };
			});
		}
		// M-08. This reason is PERSISTED — onto the task row and into a `task.failed` event
		// someone else will read — so an unauthored exception must not travel in it. The raw
		// failure goes to the operator's console instead, joined by the id the row carries.
		const reason = safeFailureMessage(err, (id, raw) =>
			console.error(
				`busyclaw engine task ${claim.task.id} failed [${id}]`,
				raw,
			),
		);
		if (heartbeat.isLost()) {
			return { status: "failed", task: null, reason };
		}
		heartbeat.stop();
		return failClaim(store, claim, reason);
	} finally {
		heartbeat.stop();
	}
}
