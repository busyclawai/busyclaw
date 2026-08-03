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

function createWorkerAbortController(): WorkerAbortController {
	const Controller = (
		globalThis as { AbortController?: new () => WorkerAbortController }
	).AbortController;
	if (Controller) return new Controller();
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
	const timer = timers.setInterval(() => {
		void store
			.heartbeatLease({
				leaseId: claim.leaseId,
				leaseToken: claim.leaseToken,
				leaseTtlMs,
			})
			.then((lease) => {
				if (!lease) markLost("task lease heartbeat failed");
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
			return run?.controlRequestedAt !== undefined ? "suspended" : undefined;
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
						await tx.updateRun(task.runId, { status: "waiting" });
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
						await tx.updateRun(task.runId, {
							status: "waiting",
							waitReason: parkReason,
							resumeCheckpointId: checkpointId,
							controlRequestedAt: null,
							controlIntent: null,
							controlRequestedBy: null,
							controlReason: null,
						});
						await tx.appendEvent({
							runId: task.runId,
							type: "run.parked",
							payload: {
								taskId: task.id,
								checkpointId,
								reason: parkReason,
								steps: result.steps,
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

						await tx.updateRun(task.runId, { status: "completed" });
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
