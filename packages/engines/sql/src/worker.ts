/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (patterns/architecture, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * - The claim/heartbeat/complete/fail loop is adapted from NullTickets' external worker protocol.
 * - The explicit runtime-task dispatch boundary is informed by NullBoiler's orchestrator/executor split.
 *
 * The worker drives operational runtime state only. Governance decisions and compliance audit remain
 * inside @euroclaw/core via @euroclaw/runtime.
 */

import {
	errorMessage,
	stateError,
	unsupportedOperationError,
	validationError,
} from "@euroclaw/contracts";
import {
	type Runtime,
	type RuntimeAbortSignal,
	type RuntimeResult,
	RuntimeResult as RuntimeResultSchema,
} from "@euroclaw/runtime";
import { type } from "arktype";
import type { ClaimedTask, RuntimeTask, SqlEngineStore } from "./store";

export const RUNTIME_RUN_TASK = "runtime.run";
export const RUNTIME_CONTINUE_RUN_TASK = "runtime.continueRun";
export const RUNTIME_RESUME_RUN_TASK = "runtime.resumeRun";

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
	| { status: "completed"; task: RuntimeTask }
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

type TaskExecution = {
	result: WorkerRuntimeResult;
	/** The task's parsed ctx — carried forward onto any continuation this slice enqueues. */
	ctx: Record<string, unknown> | undefined;
};

async function runTask(
	runtime: Runtime,
	claim: ClaimedTask,
	abortSignal?: RuntimeAbortSignal,
	deadlineAt?: string,
): Promise<TaskExecution> {
	// runId scopes effect ids and runtime events to the durable run, across attempts and slices;
	// deadlineAt lets the runtime park a yield checkpoint before the invocation's budget runs out.
	const options = {
		abortSignal,
		runId: claim.task.runId,
		...(deadlineAt !== undefined ? { deadlineAt } : {}),
	};
	if (claim.task.kind === RUNTIME_RUN_TASK) {
		const payload = runtimeRunPayload(claim.task.payload);
		return {
			result: runtimeResult(
				await runtime.generate(payload.prompt, payload.ctx, options),
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
			options,
		);
		if (!rawResumeResult) throw stateError("run checkpoint is not consumable");
		return { result: workerRuntimeResult(rawResumeResult), ctx: payload.ctx };
	}

	const payload = runtimeContinueRunPayload(claim.task.payload);
	const rawApprovalResult = await runtime.continueRun(
		payload.approvalId,
		payload.ctx,
		options,
	);
	if (!rawApprovalResult) throw stateError("approval is not consumable");
	return { result: workerRuntimeResult(rawApprovalResult), ctx: payload.ctx };
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

				const runtimeTask = runTask(
					runtime,
					claim,
					heartbeat.abortSignal,
					deadlineAt,
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
				const result = execution.result;
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
							reason: stateError("lease lost before completion", {
								taskId: claim.task.id,
							}).message,
						};

					await tx.updateRun(task.runId, { status: "completed" });
					await tx.appendEvent({
						runId: task.runId,
						type: "run.completed",
						payload: { taskId: task.id, result },
					});
					return { status: "completed", task };
				});
			} catch (err) {
				if (heartbeat.isLost()) {
					return {
						status: "failed",
						task: null,
						reason: errorMessage(err),
					};
				}
				heartbeat.stop();
				return failClaim(store, claim, errorMessage(err));
			} finally {
				heartbeat.stop();
			}
		},
	};
}
