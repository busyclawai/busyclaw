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
 * This is an independent TypeScript implementation over euroclaw's storage Adapter. Runtime history
 * produced here is operational state, not compliance audit; compliance evidence stays in @euroclaw/core.
 */

import type { Adapter, JsonObject } from "@euroclaw/contracts";
import {
	configurationError,
	type EntityUpdateInput,
	errorMessage,
	jsonObject as jsonObjectSchema,
	stateError,
	validationError,
} from "@euroclaw/contracts";
import { type EntityWhere, entityDb } from "@euroclaw/storage-core";
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

export const RunRecord = ark({
	id: "string",
	status: RunStatus,
	input: JsonRecord,
	"actor?": OptionalString,
	"team?": OptionalString,
	createdAt: "string",
	updatedAt: "string",
});
export type RunRecord = typeof RunRecord.infer;

export const RuntimeTask = ark({
	id: "string",
	runId: "string",
	kind: "string",
	status: TaskStatus,
	payload: JsonRecord,
	dueAt: "string",
	attempt: "number",
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
	"organizationId?": OptionalString,
	"actor?": OptionalString,
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
	actor?: string;
	team?: string;
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
	organizationId?: string;
	actor?: string;
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
		patch: EntityUpdateInput<typeof runFields>,
	) => Promise<RunRecord | null>;
	enqueueTask: (input: EnqueueTaskInput) => Promise<RuntimeTask>;
	getTask: (id: string) => Promise<RuntimeTask | null>;
	claimDueTask: (input: ClaimTaskInput) => Promise<ClaimedTask | null>;
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
	reapExpiredLeases: () => Promise<number>;
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
		if (err instanceof Error && err.name === "EuroclawError") throw err;
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
			organizationId: input.organizationId ?? null,
			actor: input.actor ?? null,
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
			"@euroclaw/engine-sql requires a transactional storage adapter",
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
	});

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
					input: asJsonRecord(input.input ?? {}, "run input"),
					actor: input.actor,
					team: input.team,
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
					maxAttempts: input.maxAttempts ?? 1,
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
				if (candidate.attempt >= candidate.maxAttempts) {
					await db.update({
						model: "runtime_task",
						where: [
							{ field: "id", value: candidate.id },
							{ field: "status", value: "pending", connector: "AND" },
						],
						update: {
							status: "dead",
							lastError: "max attempts exhausted before claim",
							updatedAt: ts,
						},
					});
					await store.updateRun(candidate.runId, { status: "failed" });
					continue;
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
					continue;
				}
				await store.updateRun(updated.runId, { status: "running" });
				return { task: updated, leaseId, leaseToken, expiresAt };
			}
			return null;
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
			const status: TaskStatus =
				task.attempt >= task.maxAttempts ? "dead" : "pending";
			const row = await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: {
					status,
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

		async reapExpiredLeases() {
			const ts = now();
			const leaseRows = await db.findMany({
				model: "lease",
				where: [{ field: "expiresAt", value: ts, operator: "lte" }],
			});
			let count = 0;
			for (const candidate of leaseRows) {
				const lease = await db.consumeOne({
					model: "lease",
					where: [
						{ field: "id", value: candidate.id },
						{
							field: "expiresAt",
							value: ts,
							operator: "lte",
							connector: "AND",
						},
					],
				});
				if (!lease) continue;
				const task = await db.findOne({
					model: "runtime_task",
					where: [{ field: "id", value: lease.taskId }],
				});
				if (!task) continue;
				const status: TaskStatus =
					task.attempt >= task.maxAttempts ? "dead" : "pending";
				const updated = await db.update({
					model: "runtime_task",
					where: [
						{ field: "id", value: lease.taskId },
						{ field: "status", value: "leased", connector: "AND" },
						{ field: "leaseId", value: lease.id, connector: "AND" },
					],
					update: {
						status,
						lastError: "lease expired",
						dueAt:
							status === "pending" ? addMs(ts, task.retryDelayMs) : task.dueAt,
						leaseId: null,
						workerId: null,
						leasedUntil: null,
						updatedAt: ts,
					},
				});
				if (updated && status === "dead") {
					await store.updateRun(task.runId, { status: "failed" });
				}
				count++;
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
			// The id IS the hash of the scope tuple (key/method/path/organizationId/actor), so a primary-key
			// lookup is exactly the scoped match — and it sidesteps `WHERE col = NULL` (never true in SQL,
			// and undefined !== null in the memory adapter) for absent organization/actor.
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
						organizationId: input.organizationId,
						actor: input.actor,
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
