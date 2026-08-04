/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (patterns/architecture, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * - The lease/claim/heartbeat/idempotency shape is adapted from NullTickets' SQLite tracker:
 *   `/Users/konstantinponomarev/Downloads/nulltickets-main/src/store.zig` and `src/api.zig`.
 * - The run/event/checkpoint/orchestrator shape is informed by NullBoiler:
 *   `/Users/konstantinponomarev/Downloads/nullboiler-main/src/store.zig` and `src/engine.zig`.
 *
 * This is an independent TypeScript implementation over busyclaw's storage Adapter. Runtime history
 * produced here is operational state, not compliance audit; compliance evidence stays in @busyclaw/core.
 */

import type { Adapter, JsonObject, RunMessageMode } from "@busyclaw/contracts";
import {
	asPrincipal,
	configurationError,
	errorMessage,
	isConflict,
	jsonObject as jsonObjectSchema,
	type Principal,
	runMessageFields,
	stateError,
	validationError,
} from "@busyclaw/contracts";
import {
	type EntityPatch,
	type EntityWhere,
	entityDb,
} from "@busyclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type as ark } from "arktype";
import {
	idempotencyFields,
	leaseFields,
	runEventFields,
	runFields,
	runtimeTaskFields,
} from "./schema";

export const RunStatus = ark(
	"'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'",
);
export type RunStatus = typeof RunStatus.infer;

export const TaskStatus = ark(
	"'pending' | 'leased' | 'completed' | 'failed' | 'dead'",
);
export type TaskStatus = typeof TaskStatus.infer;

const JsonRecord = jsonObjectSchema;
const OptionalString = ark("string | undefined");

export const RunControlIntentValue = ark("'suspend' | 'stop' | 'abort'");
export const RunWaitReasonValue = ark("'approval' | 'suspended'");

export const RunRecord = ark({
	id: "string",
	status: RunStatus,
	input: JsonRecord,
	"principal?": OptionalString,
	// The tenancy anchor, absent until a slice has resolved one.
	"scope?": OptionalString,
	"scopeId?": OptionalString,
	// The control latch. Absent on every row written before it existed, and on every run nobody has
	// asked anything of — which is almost all of them.
	"controlRequestedAt?": OptionalString,
	"controlIntent?": RunControlIntentValue.or("undefined"),
	"controlRequestedBy?": OptionalString,
	"controlReason?": OptionalString,
	"controlSeq?": "number | undefined",
	"waitReason?": RunWaitReasonValue.or("undefined"),
	"resumeCheckpointId?": OptionalString,
	createdAt: "string",
	updatedAt: "string",
});
// `principal` is the branded Principal (the `run.principal` stamp column, validated by the entityDb
// read schema); the local arktype checks the string shape, the type carries the brand.
export type RunRecord = Omit<
	typeof RunRecord.infer,
	"principal" | "controlRequestedBy"
> & {
	principal?: Principal;
	controlRequestedBy?: Principal;
};

export const RuntimeTask = ark({
	id: "string",
	runId: "string",
	kind: "string",
	status: TaskStatus,
	payload: JsonRecord,
	dueAt: "string",
	attempt: "number",
	"errorAttempt?": "number | undefined",
	maxAttempts: "number",
	retryDelayMs: "number",
	"leaseId?": OptionalString,
	"workerId?": OptionalString,
	"leasedUntil?": OptionalString,
	"lastError?": OptionalString,
	"output?": JsonRecord.or("undefined"),
	createdAt: "string",
	updatedAt: "string",
	"completedAt?": OptionalString,
});
export type RuntimeTask = typeof RuntimeTask.infer;

export const RunEvent = ark({
	id: "string",
	runId: "string",
	type: "string",
	payload: JsonRecord,
	createdAt: "string",
});
export type RunEvent = typeof RunEvent.infer;

export const LeaseRecord = ark({
	id: "string",
	taskId: "string",
	workerId: "string",
	tokenHash: "string",
	expiresAt: "string",
	lastHeartbeatAt: "string",
	createdAt: "string",
});
export type LeaseRecord = typeof LeaseRecord.infer;

export type ClaimedTask = {
	task: RuntimeTask;
	leaseId: string;
	leaseToken: string;
	expiresAt: string;
};

export const IdempotencyRecord = ark({
	id: "string",
	key: "string",
	method: "string",
	path: "string",
	"scope?": OptionalString,
	"scopeId?": OptionalString,
	"principal?": OptionalString,
	requestHash: "string",
	responseStatus: "number",
	responseBody: JsonRecord,
	createdAt: "string",
});
export type IdempotencyRecord = typeof IdempotencyRecord.infer;

export type SqlEngineStoreOptions = {
	now?: () => string;
	runModel?: string;
	taskModel?: string;
	eventModel?: string;
	leaseModel?: string;
	idempotencyModel?: string;
};

export type CreateRunInput = {
	id?: string;
	input?: Record<string, unknown>;
	principal?: Principal;
};

export type EnqueueTaskInput = {
	id?: string;
	runId: string;
	kind: string;
	payload?: Record<string, unknown>;
	dueAt?: string;
	maxAttempts?: number;
	retryDelayMs?: number;
};

export type ClaimTaskInput = {
	workerId: string;
	leaseTtlMs?: number;
	limit?: number;
};

export type IdempotencyLookup = {
	key: string;
	method: string;
	path: string;
	scope?: string;
	scopeId?: string;
	// The request's principal — a component of the idempotency key tuple. The (future) request handler
	// passes ctx's already-branded Principal; it is a plain string at runtime, so it hashes into the
	// key exactly as before.
	principal?: Principal;
	requestHash: string;
};

export type SaveIdempotencyInput = IdempotencyLookup & {
	responseStatus: number;
	responseBody: Record<string, unknown>;
};

export type SqlEngineStore = {
	/** The store's time source — the engine's single clock (worker deadline checks, cron budgets). */
	now: () => string;
	transaction: <R>(fn: (tx: SqlEngineStore) => Promise<R>) => Promise<R>;
	createRun: (input?: CreateRunInput) => Promise<RunRecord>;
	getRun: (id: string) => Promise<RunRecord | null>;
	updateRun: (
		id: string,
		patch: EntityPatch<typeof runFields>,
	) => Promise<RunRecord | null>;
	/**
	 * `updateRun`, but only when the run is currently in one of `from` — a compare-and-swap, so it
	 * returns the row it changed or `null` when the run had moved on. Every write that could land on
	 * a run somebody else already finished belongs here rather than on `updateRun`: an unconditional
	 * status write is how a terminal run gets resurrected by a claim that was already too late.
	 */
	updateRunIfStatus: (
		id: string,
		input: {
			from: readonly RunStatus[];
			patch: EntityPatch<typeof runFields>;
		},
	) => Promise<RunRecord | null>;
	enqueueTask: (input: EnqueueTaskInput) => Promise<RuntimeTask>;
	getTask: (id: string) => Promise<RuntimeTask | null>;
	claimDueTask: (input: ClaimTaskInput) => Promise<ClaimedTask | null>;
	/**
	 * Claim ONE task by primary key — the same acquisition `claimDueTask` performs, without its
	 * candidate scan.
	 *
	 * Deliberately NOT on `ClawEngineHandle` and never reachable from `clawApiRoutes`, because a
	 * leased task is a strictly bigger privilege loan than any api verb hands out: whoever holds the
	 * lease can also `completeTask` it with arbitrary `output`. The taskId is never caller-supplied.
	 *
	 * The scan is what it must not share. A caller that ran `claimDueTask` after enqueuing its own
	 * task would take the OLDEST due task, drive somebody else's run under that run's principal, and
	 * hand back that other tenant's result — a cross-tenant disclosure, not a latency question.
	 */
	claimTask: (
		taskId: string,
		input: ClaimTaskInput,
	) => Promise<ClaimedTask | null>;
	heartbeatLease: (input: {
		leaseId: string;
		leaseToken: string;
		leaseTtlMs?: number;
	}) => Promise<LeaseRecord | null>;
	completeTask: (input: {
		taskId: string;
		leaseToken: string;
		output?: Record<string, unknown>;
	}) => Promise<RuntimeTask | null>;
	failTask: (input: {
		taskId: string;
		leaseToken: string;
		reason: string;
	}) => Promise<RuntimeTask | null>;
	/** CAS every still-pending task of a run to `dead`. What makes a synchronous suspend terminal:
	 *  a withheld task cannot be picked up later by a host that never saw the intent. Returns how
	 *  many were withheld. */
	deadLetterPendingTasks: (runId: string, reason: string) => Promise<number>;
	/** Take every undelivered message for a run past `afterSeq`, in the run's own order, and mark it
	 *  delivered at `step`. Exactly one reader — the run itself, already fenced by the engine lease on
	 *  its own task — so there is no claim and no lease on the row. */
	drainMessages: (input: {
		toRunId: string;
		afterSeq: number;
		step: number;
	}) => Promise<readonly { seq: number; body: JsonObject }[]>;
	/** Is there an undelivered `interrupt`-mode message for this run? The one question the heartbeat
	 *  asks on behalf of a model call already in flight. */
	hasPendingInterrupt: (runId: string) => Promise<boolean>;
	/** Admit a message to a run's inbox. Mints `seq` and decides the bounce in ONE conditional write
	 *  against the run row — see the implementation for why those cannot be two. */
	admitMessage: (input: {
		id: string;
		toRunId: string;
		body: JsonObject;
		mode: RunMessageMode;
		sender: Principal;
		containerScope?: string;
		containerScopeId?: string;
	}) => Promise<
		| { admitted: true; id: string; seq: number }
		| { admitted: false; id: string; seq: number; bounced?: string }
	>;
	reapExpiredLeases: () => Promise<number>;
	/** Append a `run_event` EXECUTION-STATE row (every worker emit lands here) — not the
	 *  operational stream; observability is the runtime `EventSink`. See schema.ts. */
	appendEvent: (input: {
		runId: string;
		type: string;
		payload?: Record<string, unknown>;
	}) => Promise<RunEvent>;
	events: (runId: string) => Promise<RunEvent[]>;
	requestHash: (body: unknown) => string;
	getIdempotency: (
		input: IdempotencyLookup,
	) => Promise<IdempotencyRecord | null>;
	saveIdempotency: (input: SaveIdempotencyInput) => Promise<IdempotencyRecord>;
};

/** A run in one of these still has work ahead of it; anything else is finished and must not be
 *  written back into flight by a claim that lost its race. */
export const NON_TERMINAL_RUN_STATUSES = [
	"queued",
	"running",
	"waiting",
] as const;

/** How many times a task may be CLAIMED before it is abandoned, however it lost each claim. The
 *  backstop against a flapping host, deliberately not a config knob: it bounds crash loops, and a
 *  deployment that wants more retries wants a higher `maxAttempts`, which is a different question. */
const MAX_CLAIMS = 8;

/** CAS-retry bound for minting a message `seq`. Contention here is two admits racing on one run,
 *  which is rare and short-lived; a bound that is hit means something else is wrong. */
const MAX_SEQ_ATTEMPTS = 8;

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function newId(): string {
	return bytesToHex(randomBytes(16));
}

function newToken(): string {
	return bytesToHex(randomBytes(32));
}

function hashText(text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text)));
}

export function addMs(iso: string, ms: number): string {
	return new Date(Date.parse(iso) + ms).toISOString();
}

/** Narrow a caller-supplied `Record<string, unknown>` json payload to JsonObject at the write seam —
 *  a parse, never a cast (the entity layer re-validates the whole record on create). */
function asJsonRecord(value: unknown, label: string): JsonObject {
	const valid = jsonObjectSchema(value);
	if (valid instanceof ark.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	return valid;
}

function stringifyJson(value: unknown, label: string): string {
	const valid = jsonObjectSchema(value);
	if (valid instanceof ark.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	try {
		const json = JSON.stringify(valid);
		if (typeof json !== "string") {
			throw validationError(`${label} invalid`, "must be JSON-serializable");
		}
		return json;
	} catch (err) {
		if (err instanceof Error && err.name === "BusyclawError") throw err;
		throw validationError(`${label} invalid`, errorMessage(err));
	}
}

function pendingWhere(now: string): EntityWhere<typeof runtimeTaskFields>[] {
	return [
		{ field: "status", value: "pending" },
		{ field: "dueAt", value: now, operator: "lte", connector: "AND" },
	];
}

function idempotencyId(input: IdempotencyLookup): string {
	return hashText(
		JSON.stringify({
			key: input.key,
			method: input.method,
			path: input.path,
			scope: input.scope ?? null,
			scopeId: input.scopeId ?? null,
			principal: input.principal ?? null,
		}),
	);
}

export function createSqlEngineStore(
	adapter: Adapter,
	options: SqlEngineStoreOptions = {},
): SqlEngineStore {
	const runTransaction = adapter.transaction;
	if (!runTransaction) {
		throw configurationError(
			"@busyclaw/engine-sql requires a transactional storage adapter",
			{ adapter: adapter.id },
		);
	}
	const now = options.now ?? (() => new Date().toISOString());
	const runModel = options.runModel ?? "run";
	const taskModel = options.taskModel ?? "runtime_task";
	const eventModel = options.eventModel ?? "run_event";
	const leaseModel = options.leaseModel ?? "lease";
	const idempotencyModel = options.idempotencyModel ?? "idempotency_key";
	// Every engine table persists through the entity layer (logical↔physical names, JSON
	// encode/decode, undefined-dropping, immutable enforcement) — and every row crossing the adapter
	// boundary is parsed against its record schema, so the ops speak validated native records. Each
	// table's *Model option pins its physical name via modelName.
	const db = entityDb(adapter, {
		run: { fields: runFields, modelName: runModel },
		runtime_task: { fields: runtimeTaskFields, modelName: taskModel },
		run_event: { fields: runEventFields, modelName: eventModel },
		lease: { fields: leaseFields, modelName: leaseModel },
		idempotency_key: { fields: idempotencyFields, modelName: idempotencyModel },
		// CORE-owned (it joins CORE_MODELS, not sqlEngineSchema), but read and written from here: the
		// admit transaction has to touch the `run` row and the message in one place, and this is the
		// only store that holds both.
		run_message: { fields: runMessageFields },
	});

	/**
	 * ACQUISITION — everything a claim does once a candidate has been chosen, and nothing about
	 * choosing one. Extracted verbatim from `claimDueTask` so the two claim paths cannot drift: the
	 * MAX_CLAIMS retirement, the control-latch fence, the lease mint, the task CAS, its unwind, the
	 * non-terminal run guard and ITS unwind are one body carrying one set of race arguments.
	 *
	 * `null` means "not claimable", for every reason it can mean that — retired, withheld, CAS lost,
	 * run already finished. `claimDueTask` reads that as "try the next candidate"; a targeted claim
	 * reads it as "somebody else owns this". Both are correct without either branching on which.
	 */
	async function attemptClaim(
		candidate: RuntimeTask,
		input: ClaimTaskInput,
		ts: string,
	): Promise<ClaimedTask | null> {
		if (candidate.attempt >= MAX_CLAIMS) {
			await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: candidate.id },
					{ field: "status", value: "pending", connector: "AND" },
				],
				update: {
					status: "dead",
					lastError: `abandoned after ${MAX_CLAIMS} claims without completing`,
					updatedAt: ts,
				},
			});
			await store.updateRun(candidate.runId, { status: "failed" });
			return null;
		}
		// THE FENCE. A run somebody has asked to stop must not receive another slice on any
		// host — and a queued run has no holder to observe the latch for it, so the claim path
		// is where that intent gets honoured. One PK read per candidate, on the path that is
		// already doing several writes.
		const candidateRun = await store.getRun(candidate.runId);
		if (candidateRun?.controlRequestedAt !== undefined) {
			const withheld = await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: candidate.id },
					{ field: "status", value: "pending", connector: "AND" },
				],
				update: {
					status: "dead",
					lastError: "run suspended before this task was claimed",
					updatedAt: ts,
				},
			});
			if (withheld) {
				await store.updateRunIfStatus(candidate.runId, {
					from: ["queued", "running", "waiting"],
					patch: {
						status: "waiting",
						waitReason: "suspended",
						controlRequestedAt: null,
						controlIntent: null,
						controlRequestedBy: null,
						controlReason: null,
					},
				});
			}
			return null;
		}

		const leaseToken = newToken();
		const leaseId = newId();
		const expiresAt = addMs(ts, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
		const lease: LeaseRecord = {
			id: leaseId,
			taskId: candidate.id,
			workerId: input.workerId,
			tokenHash: hashText(leaseToken),
			expiresAt,
			lastHeartbeatAt: ts,
			createdAt: ts,
		};
		await db.create({ model: "lease", data: lease });
		const updated = await db.update({
			model: "runtime_task",
			where: [
				{ field: "id", value: candidate.id },
				{ field: "status", value: "pending", connector: "AND" },
				// A NO-OP for `claimDueTask`, whose candidates were already filtered by `pendingWhere`,
				// and load-bearing for a targeted claim: `failTask` pushes `dueAt` out to schedule a
				// retry backoff, and a claim by primary key would otherwise walk straight past it and
				// re-run failing work with no delay at all.
				{ field: "dueAt", value: ts, operator: "lte", connector: "AND" },
			],
			update: {
				status: "leased",
				leaseId,
				workerId: input.workerId,
				leasedUntil: expiresAt,
				attempt: candidate.attempt + 1,
				updatedAt: ts,
			},
		});
		if (!updated) {
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: leaseId }],
			});
			return null;
		}
		// CONDITIONAL. A claim can arrive after the run it belongs to has already reached a
		// terminal status — a duplicate task, a late deadline arm, a stop that landed between
		// this claim's task CAS and here. Writing `running` unconditionally resurrected it:
		// `completed` became `running` and stayed there, contradicting the run's own event
		// stream, and a cancelled run silently went back to work.
		const started = await store.updateRunIfStatus(updated.runId, {
			from: NON_TERMINAL_RUN_STATUSES,
			patch: { status: "running" },
		});
		if (!started) {
			// The run is finished and this task has nothing to do. Retire it and release the
			// lease rather than handing a worker a slice against a corpse.
			await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: updated.id },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
				update: {
					status: "dead",
					lastError:
						"run reached a terminal status before this task was claimed",
					leaseId: null,
					workerId: null,
					leasedUntil: null,
					updatedAt: ts,
				},
			});
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: leaseId }],
			});
			return null;
		}
		return { task: updated, leaseId, leaseToken, expiresAt };
	}

	async function validateLease(
		task: RuntimeTask,
		token: string,
	): Promise<LeaseRecord | null> {
		if (task.leaseId === undefined) return null;
		const lease = await db.findOne({
			model: "lease",
			where: [{ field: "id", value: task.leaseId }],
		});
		if (!lease) return null;
		if (lease.taskId !== task.id) return null;
		if (lease.expiresAt <= now()) return null;
		if (lease.tokenHash !== hashText(token)) return null;
		return lease;
	}

	const store: SqlEngineStore = {
		now,

		transaction(fn) {
			return runTransaction((tx) => fn(createSqlEngineStore(tx, options)));
		},

		async createRun(input = {}) {
			const ts = now();
			return db.create({
				model: "run",
				data: {
					id: input.id ?? newId(),
					status: "queued",
					// Present from birth, so the inbox's compare-and-swap has something to pin. An ABSENT
					// column is not zero: `eq null` does not match `undefined`, so a CAS on `0` would
					// match nothing and spin.
					controlSeq: 0,
					input: asJsonRecord(input.input ?? {}, "run input"),
					principal:
						input.principal === undefined
							? undefined
							: asPrincipal(input.principal),
					createdAt: ts,
					updatedAt: ts,
				},
			});
		},

		async getRun(id) {
			return db.findOne({
				model: "run",
				where: [{ field: "id", value: id }],
			});
		},

		async updateRun(id, patch) {
			// The entity layer drops undefined + encodes JSON; the store owns updatedAt (input:false).
			return db.update({
				model: "run",
				where: [{ field: "id", value: id }],
				update: { ...patch, updatedAt: now() },
			});
		},

		async updateRunIfStatus(id, input) {
			// `in` over the allowed statuses, so the whole guard is one predicate and one round trip.
			// The adapter contract is that `update` returns the row or null when nothing matched, which
			// is what makes this a CAS rather than a read-then-write.
			return db.update({
				model: "run",
				where: [
					{ field: "id", value: id },
					{
						field: "status",
						value: [...input.from],
						operator: "in",
						connector: "AND",
					},
				],
				update: { ...input.patch, updatedAt: now() },
			});
		},

		async enqueueTask(input) {
			const ts = now();
			return db.create({
				model: "runtime_task",
				data: {
					id: input.id ?? newId(),
					runId: input.runId,
					kind: input.kind,
					status: "pending",
					payload: asJsonRecord(input.payload ?? {}, "task payload"),
					dueAt: input.dueAt ?? ts,
					attempt: 0,
					errorAttempt: 0,
					// 3, not 1. The single attempt was never a policy about retries — it was the only
					// thing standing between a lease lapse and a `runtime.run` task restarting its run
					// from the prompt. That is fixed; a genuine failure may now be retried.
					maxAttempts: input.maxAttempts ?? 3,
					retryDelayMs: input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
					createdAt: ts,
					updatedAt: ts,
				},
			});
		},

		async getTask(id) {
			return db.findOne({
				model: "runtime_task",
				where: [{ field: "id", value: id }],
			});
		},

		async claimDueTask(input) {
			await store.reapExpiredLeases();
			const ts = now();
			const candidates = await db.findMany({
				model: "runtime_task",
				where: pendingWhere(ts),
				sortBy: { field: "dueAt", direction: "asc" },
				limit: input.limit ?? 10,
			});
			for (const candidate of candidates) {
				const claimed = await attemptClaim(candidate, input, ts);
				if (claimed) return claimed;
			}
			return null;
		},

		async claimTask(taskId, input) {
			// A primary-key read, and that is the point: a scan can be widened or re-sorted by accident
			// into the cross-tenant bug above, a `findOne` by id cannot. `attemptClaim`'s CAS re-checks
			// `status = "pending"` and `dueAt <= now`, so a task that is leased, dead, or still inside a
			// `failTask` backoff yields null here exactly as it would to the drain.
			const candidate = await db.findOne({
				model: "runtime_task",
				where: [{ field: "id", value: taskId }],
			});
			if (!candidate) return null;
			return attemptClaim(candidate, input, now());
		},

		async heartbeatLease(input) {
			const lease = await db.findOne({
				model: "lease",
				where: [{ field: "id", value: input.leaseId }],
			});
			if (!lease) return null;
			if (lease.expiresAt <= now()) return null;
			if (lease.tokenHash !== hashText(input.leaseToken)) return null;
			const ts = now();
			const expiresAt = addMs(ts, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
			const tokenHash = hashText(input.leaseToken);
			const updated = await db.update({
				model: "lease",
				where: [
					{ field: "id", value: input.leaseId },
					{ field: "tokenHash", value: tokenHash, connector: "AND" },
					{ field: "expiresAt", value: ts, operator: "gt", connector: "AND" },
				],
				update: { expiresAt, lastHeartbeatAt: ts },
			});
			if (!updated) return null;
			await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: lease.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: input.leaseId, connector: "AND" },
					{ field: "workerId", value: lease.workerId, connector: "AND" },
				],
				update: { leasedUntil: expiresAt, updatedAt: ts },
			});
			return updated;
		},

		async completeTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			const row = await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: {
					status: "completed",
					...(input.output !== undefined
						? { output: asJsonRecord(input.output, "task output") }
						: {}),
					completedAt: ts,
					updatedAt: ts,
				},
			});
			if (!row) return null;
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: lease.id }],
			});
			return row;
		},

		async failTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			// This is a REAL failure, so it is the error counter that moves — and the error counter is
			// what `maxAttempts` bounds. A task that keeps being claimed and losing its lease is a
			// different story with a different limit (MAX_CLAIMS), told by the reaper.
			const errorAttempt = (task.errorAttempt ?? 0) + 1;
			const status: TaskStatus =
				errorAttempt >= task.maxAttempts ? "dead" : "pending";
			const row = await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: {
					status,
					errorAttempt,
					lastError: input.reason,
					dueAt:
						status === "pending" ? addMs(ts, task.retryDelayMs) : task.dueAt,
					leaseId: null,
					workerId: null,
					leasedUntil: null,
					updatedAt: ts,
				},
			});
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: lease.id }],
			});
			return row;
		},

		async drainMessages({ toRunId, afterSeq, step }) {
			const rows = await db.findMany({
				model: "run_message",
				where: [
					{ field: "toRunId", value: toRunId },
					// NOT filtered on `pending`. A row is marked delivered BEFORE it reaches the in-memory
					// transcript, so a crash in that window leaves a message that is neither pending nor in
					// any transcript — invisible forever. `seq > afterSeq` where afterSeq is what the
					// transcript actually contains re-delivers exactly those and nothing else; `status`
					// stays as forensics.
					{ field: "seq", value: afterSeq, operator: "gt", connector: "AND" },
					// `at_turn_end` is wake fuel for the NEXT run on this conversation and never enters
					// this one. `interrupt` drains here too until it has teeth of its own — degrading to
					// "arrives at the next step" is honest; silently never arriving is not.
					{
						field: "mode",
						value: ["next_step", "interrupt"],
						operator: "in",
						connector: "AND",
					},
				],
				sortBy: { field: "seq", direction: "asc" },
			});
			const ts = now();
			const drained: { seq: number; body: JsonObject }[] = [];
			for (const row of rows) {
				// Pinned on `pending`: a second reader cannot exist by construction, but a retry of THIS
				// slice can, and marking an already-delivered row again would move its step.
				await db.update({
					model: "run_message",
					where: [{ field: "id", value: row.id }],
					update: { status: "delivered", deliveredAtStep: step, updatedAt: ts },
				});
				drained.push({ seq: row.seq, body: row.body });
			}
			return drained;
		},

		async hasPendingInterrupt(runId) {
			const rows = await db.findMany({
				model: "run_message",
				where: [
					{ field: "toRunId", value: runId },
					{ field: "status", value: "pending", connector: "AND" },
					{ field: "mode", value: "interrupt", connector: "AND" },
				],
				limit: 1,
			});
			return rows.length > 0;
		},

		async admitMessage(input) {
			// THE BOUNCE AND THE SEQ ARE THE SAME WRITE. The obvious shape — read the run, check it is
			// not terminal, then insert — loses the race against a terminal transition committing in
			// another process, and both SQL adapters run the driver's default isolation, so nothing
			// prevents that interleave. The admit already has to touch the run row to mint `seq` under
			// `controlSeq`, so that conditional write IS the guard: a null return means the run went
			// terminal, and there is nothing to queue against a corpse.
			//
			// CAS-retry, not `col = col + 1`: the Adapter port takes literal values only, so a
			// read-modify-write would lose bumps whenever two messages are admitted at once.
			for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
				const run = await store.getRun(input.toRunId);
				if (!run) {
					throw stateError("no such run to deliver to", {
						toRunId: input.toRunId,
					});
				}
				// ABSENT IS NOT ZERO, and no predicate can say "absent": `eq null` compares against
				// `undefined` and is false, so a CAS pinned on `0` matches a legacy row not at all and
				// the retry loop spins to exhaustion. `createRun` writes 0 from birth; a row that
				// predates the column is normalized to 0 first and re-read, which two concurrent
				// admits can both do harmlessly because setting 0 twice is the same as setting it once.
				const stored = run.controlSeq;
				if (stored === undefined) {
					await db.update({
						model: "run",
						where: [{ field: "id", value: input.toRunId }],
						update: { controlSeq: 0 },
					});
					continue;
				}
				const current = stored;
				const seq = current + 1;
				const moved = await db.update({
					model: "run",
					where: [
						{ field: "id", value: input.toRunId },
						{ field: "controlSeq", value: stored, connector: "AND" },
						{
							field: "status",
							value: [...NON_TERMINAL_RUN_STATUSES],
							operator: "in",
							connector: "AND",
						},
					],
					update: { controlSeq: seq, updatedAt: now() },
				});
				if (!moved) {
					// Either the counter moved under us (retry) or the run finished (bounce). Only a
					// re-read can tell the two apart, and only the second is terminal.
					const after = await store.getRun(input.toRunId);
					const stillLive = (
						NON_TERMINAL_RUN_STATUSES as readonly string[]
					).includes(after?.status ?? "");
					if (after && !stillLive) {
						return {
							admitted: false,
							id: input.id,
							seq: 0,
							bounced: after.status,
						};
					}
					continue;
				}
				const ts = now();
				try {
					await db.create({
						model: "run_message",
						data: {
							id: input.id,
							toRunId: input.toRunId,
							mode: input.mode,
							body: input.body,
							...(input.containerScope !== undefined
								? { containerScope: input.containerScope }
								: {}),
							...(input.containerScopeId !== undefined
								? { containerScopeId: input.containerScopeId }
								: {}),
							sender: input.sender,
							seq,
							status: "pending",
							createdAt: ts,
							updatedAt: ts,
						},
					});
				} catch (error) {
					// A REDELIVERY. The row is already there, which is the whole point of deriving the id
					// — rows are retained after delivery precisely so a repeat still looks known.
					if (!isConflict(error)) throw error;
					return { admitted: false, id: input.id, seq };
				}
				return { admitted: true, id: input.id, seq };
			}
			throw stateError("could not mint a message sequence under contention", {
				toRunId: input.toRunId,
			});
		},

		async deadLetterPendingTasks(runId, reason) {
			const ts = now();
			const pending = await db.findMany({
				model: "runtime_task",
				where: [
					{ field: "runId", value: runId },
					{ field: "status", value: "pending", connector: "AND" },
				],
			});
			let count = 0;
			for (const task of pending) {
				// Pinned on `pending`: a task a worker claimed between the read and here belongs to that
				// worker, and its own control point is what stops it.
				const updated = await db.update({
					model: "runtime_task",
					where: [
						{ field: "id", value: task.id },
						{ field: "status", value: "pending", connector: "AND" },
					],
					update: { status: "dead", lastError: reason, updatedAt: ts },
				});
				if (updated) count++;
			}
			return count;
		},

		async reapExpiredLeases() {
			const ts = now();
			const leaseRows = await db.findMany({
				model: "lease",
				where: [{ field: "expiresAt", value: ts, operator: "lte" }],
			});
			let count = 0;
			for (const candidate of leaseRows) {
				// R-M10. The lease used to be CONSUMED first — deleted — and the task transitioned after.
				// A process dying between those two left the task `leased` with a `leaseId` pointing at a
				// row that no longer existed: no lease left to expire, and the claim query only looks at
				// `pending`, so the task was stranded forever. Recovery state destroyed before the
				// successor state was durable, which is the whole shape of the finding.
				//
				// Reversed: the task transition goes first, under a compare-and-set on the lease it
				// names, and the lease row is dropped after. Dying in the middle now leaves a task that
				// is `pending` (claimable again) beside a stale lease row the next sweep collects —
				// recoverable litter instead of a permanent orphan.
				//
				// The CAS is what makes two concurrent reapers safe without consuming first: whichever
				// updates the task sets `leaseId: null`, so the other's `leaseId = <id>` predicate matches
				// nothing and it does no work. Deleting an already-deleted lease is a no-op either way.
				const reap = async (
					tx: typeof db,
				): Promise<false | { status: TaskStatus; runId: string }> => {
					const task = await tx.findOne({
						model: "runtime_task",
						where: [{ field: "id", value: candidate.taskId }],
					});
					if (!task) {
						// The task is gone; the lease is litter. Drop it so the sweep does not re-read it.
						await tx.delete({
							model: "lease",
							where: [{ field: "id", value: candidate.id }],
						});
						return false;
					}
					// A LAPSE, not a failure: the host vanished mid-claim and nothing was learned about
					// the work. So this bounds CLAIMS, and `errorAttempt` is left untouched — otherwise a
					// flapping worker spends a run's whole error budget without the run ever failing.
					const status: TaskStatus =
						task.attempt >= MAX_CLAIMS ? "dead" : "pending";
					const updated = await tx.update({
						model: "runtime_task",
						where: [
							{ field: "id", value: candidate.taskId },
							{ field: "status", value: "leased", connector: "AND" },
							{ field: "leaseId", value: candidate.id, connector: "AND" },
						],
						update: {
							status,
							lastError:
								status === "dead"
									? `abandoned after ${MAX_CLAIMS} claims without completing`
									: "lease expired",
							dueAt:
								status === "pending"
									? addMs(ts, task.retryDelayMs)
									: task.dueAt,
							leaseId: null,
							workerId: null,
							leasedUntil: null,
							updatedAt: ts,
						},
					});
					// Lost to another reaper, or the lease was renewed between the read and here. Either
					// way this one is not ours to retire, and the lease row is left for its real owner.
					if (!updated) return false;
					await tx.delete({
						model: "lease",
						where: [{ field: "id", value: candidate.id }],
					});
					// The RUN write is deliberately NOT done here. `store.updateRun` goes through the
					// outer, non-transactional db, and issuing it from inside `db.transaction(reap)`
					// means an adapter with real isolation can lose or reorder it — which left a run
					// `running` forever after its task had been abandoned. Report the outcome instead
					// and let the caller write it once the transaction has actually committed.
					return { status, runId: task.runId };
				};
				// Atomic where the adapter can be; ordered-and-recoverable where it cannot.
				const reaped = db.transaction
					? await db.transaction(reap)
					: await reap(db);
				if (!reaped) continue;
				count++;
				// Claims exhausted, and only that: a requeue leaves the run alone, because "the host
				// vanished" is not a verdict on the work.
				if (reaped.status === "dead") {
					await store.updateRunIfStatus(reaped.runId, {
						from: ["queued", "running", "waiting"],
						patch: { status: "failed" },
					});
				}
			}
			return count;
		},

		async appendEvent(input) {
			return db.create({
				model: "run_event",
				data: {
					id: newId(),
					runId: input.runId,
					type: input.type,
					payload: asJsonRecord(input.payload ?? {}, "event payload"),
					createdAt: now(),
				},
			});
		},

		async events(runId) {
			return db.findMany({
				model: "run_event",
				where: [{ field: "runId", value: runId }],
				sortBy: { field: "createdAt", direction: "asc" },
			});
		},

		requestHash(body) {
			return hashText(stringifyJson(body, "request body"));
		},

		async getIdempotency(input) {
			// The id IS the hash of the scope tuple (key/method/path/scope/scopeId/principal), so a
			// primary-key lookup is exactly the scoped match — and it sidesteps `WHERE col = NULL` (never
			// true in SQL, and undefined !== null in the memory adapter) for absent organization/principal.
			const record = await db.findOne({
				model: "idempotency_key",
				where: [{ field: "id", value: idempotencyId(input) }],
			});
			if (!record) return null;
			if (record.requestHash !== input.requestHash) {
				throw stateError(
					"idempotency key reused with a different request body",
					{
						key: input.key,
						method: input.method,
						path: input.path,
					},
				);
			}
			return record;
		},

		async saveIdempotency(input) {
			const existing = await store.getIdempotency(input);
			if (existing) return existing;
			try {
				return await db.create({
					model: "idempotency_key",
					data: {
						id: idempotencyId(input),
						key: input.key,
						method: input.method,
						path: input.path,
						scope: input.scope,
						scopeId: input.scopeId,
						principal: input.principal,
						requestHash: input.requestHash,
						responseStatus: input.responseStatus,
						responseBody: asJsonRecord(input.responseBody, "response body"),
						createdAt: now(),
					},
				});
			} catch (err) {
				const raced = await store.getIdempotency(input);
				if (raced) return raced;
				throw err;
			}
		},
	};

	return store;
}
