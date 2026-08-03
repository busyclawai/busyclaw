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

import {
	errorMessage,
	type Principal,
	safeFailureMessage,
	stateError,
	unsupportedOperationError,
	validationError,
} from "@busyclaw/contracts";
import {
	type RunControlPort,
	type Runtime,
	type RuntimeAbortSignal,
	type RuntimeResult,
	RuntimeResult as RuntimeResultSchema,
	runtimeRunOptionsWithCaller,
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
});
export type RuntimeResumeRunTaskPayload =
	typeof RuntimeResumeRunTaskPayload.infer;

export type SqlEngineWorkerConfig = {
	store: SqlEngineStore;
	runtime: Runtime;
	workerId: string;
	leaseTtlMs?: number;
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
	 *  waits until somebody asks it to proceed. */
	| { status: "parked"; task: RuntimeTask; checkpointId: string }
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
	abortSignal?: RuntimeAbortSignal,
	deadlineAt?: string,
	principal?: Principal,
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
	const options = {
		abortSignal,
		runId: claim.task.runId,
		...(deadlineAt !== undefined ? { deadlineAt } : {}),
		// The engine, not the ingress, binds this — the intent outlives whichever process received it,
		// so every slice including a resumed one has to be able to see it.
		control,
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
		return {
			outcome: "ran",
			result: runtimeResult(
				await runtime.generate(payload.prompt, payload.ctx, withCaller),
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
				if (run?.controlIntent === "abort") markAborted();
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
		stop,
	};
}

export function createSqlEngineWorker(config: SqlEngineWorkerConfig): {
	tick: (options?: WorkerTickOptions) => Promise<WorkerTickResult>;
} {
	const { store, runtime, workerId, leaseTtlMs } = config;
	const now = store.now;
	// One read of the run row per step. `controlRequestedAt` present IS the intent — the loop is told
	// only the park reason, never the ladder, so raising `stop` later changes this file and nothing
	// upstream of it.
	const controlPort: RunControlPort = {
		poll: async (runId) => {
			const run = await store.getRun(runId);
			if (run?.controlRequestedAt === undefined) return undefined;
			// The LADDER collapses to what the loop can act on. `abort` is not a different park — it is
			// a stop that additionally tears down the in-flight provider call, which is a separate
			// mechanism and a later slice; until it exists an abort still parks like a stop rather than
			// being silently ignored.
			return run.controlIntent === "suspend" ? "suspended" : "stopped";
		},
	};
	return {
		async tick(options?: WorkerTickOptions) {
			const deadlineAt = options?.deadlineAt;
			// Budget spent → claim nothing, end the drain cleanly. The pending task waits for the
			// next invocation instead of being killed mid-run by the platform.
			if (deadlineAt !== undefined && now() >= deadlineAt) {
				return { status: "idle", reason: "deadline" };
			}
			const claim = await store.claimDueTask({ workerId, leaseTtlMs });
			if (!claim) return { status: "idle" };
			const heartbeat = startHeartbeat(store, claim, leaseTtlMs);

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
						unsupportedOperationError(
							`unsupported task kind: ${claim.task.kind}`,
							{ kind: claim.task.kind },
						).message,
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
				const runtimeTask = runTask(
					runtime,
					claim,
					controlPort,
					heartbeat.abortSignal,
					deadlineAt,
					run?.principal,
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
						await tx.updateRun(task.runId, { status: "queued" });
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
						return { status: "parked", task, checkpointId };
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
		},
	};
}
