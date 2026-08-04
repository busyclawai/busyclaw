/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (schema shape/patterns, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 */

import type { SchemaDeclaration } from "@busyclaw/contracts";
import { entity, field, runSchema } from "@busyclaw/contracts";

// `run` and `run_event` are CORE now — they are the governance record (authz parent, tenancy anchor,
// control latch, the id every transcript row points at), which a Temporal or Durable-Objects engine
// needs exactly as much as this one does. Re-exported here so a host that wired `sqlEngineSchema` by
// hand keeps working, and so this file still reads as the engine's full table set.
export { runEventFields, runFields } from "@busyclaw/contracts";

const taskStatusValues = [
	"pending",
	"leased",
	"completed",
	"failed",
	"dead",
] as const;

export const runtimeTaskFields = {
	id: field.string({ required: true, primaryKey: true, unique: true }),
	runId: field.string({ required: true, index: true }),
	kind: field.string({ required: true, index: true }),
	status: field.enum(taskStatusValues, { required: true, index: true }),
	payload: field.jsonObject({ required: true }),
	dueAt: field.string({ required: true, index: true }),
	// CLAIMS, not failures. A lease lapse costs one of these — the host vanished, which says nothing
	// about whether the work is bad.
	attempt: field.number({ required: true }),
	// FAILURES. Incremented only by `failTask`, never by the reaper, and the only counter
	// `maxAttempts` bounds. Not `required`: planMigrations only ADDs columns and emits no UPDATE, so
	// rows that predate it have no value — code reads `?? 0`.
	errorAttempt: field.number(),
	maxAttempts: field.number({ required: true }),
	retryDelayMs: field.number({ required: true }),
	leaseId: field.string({ index: true }),
	workerId: field.string({ index: true }),
	leasedUntil: field.string({ index: true }),
	lastError: field.string(),
	output: field.jsonObject(),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
	completedAt: field.string({ index: true }),
} as const;

export const leaseFields = {
	id: field.string({ required: true, primaryKey: true, unique: true }),
	taskId: field.string({ required: true, index: true }),
	workerId: field.string({ required: true, index: true }),
	tokenHash: field.string({ required: true }),
	expiresAt: field.string({ required: true, index: true }),
	lastHeartbeatAt: field.string({ required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const idempotencyFields = {
	id: field.string({ required: true, primaryKey: true, unique: true }),
	key: field.string({ required: true, index: true }),
	method: field.string({ required: true }),
	path: field.string({ required: true }),
	scope: field.string({ index: true }),
	scopeId: field.string({ index: true }),
	principal: field.principal({ index: true }),
	requestHash: field.string({ required: true }),
	responseStatus: field.number({ required: true }),
	responseBody: field.jsonObject({ required: true }),
	createdAt: field.string({ required: true }),
} as const;

const runtimeTaskEntity = entity("runtime_task", runtimeTaskFields);
const leaseEntity = entity("lease", leaseFields);
const idempotencyEntity = entity("idempotency_key", idempotencyFields);

/**
 * THIS ENGINE'S OWN tables — how it schedules work, and nothing about what a run IS.
 *
 * Declared on the factory (`sqlEngine(...).models`) so `getBusyclawTables` can read them WITHOUT
 * constructing the engine: the schema collectors run before `create()` is ever called, which is why a
 * plugin-shaped contribution was structurally too late and a factory-shaped one is exactly on time.
 * An engine whose backend owns its own durability declares none of this and migrates nothing.
 */
export const sqlEngineModels = {
	runtime_task: { fields: runtimeTaskFields },
	lease: { fields: leaseFields },
	idempotency_key: { fields: idempotencyFields },
} as const;

/**
 * All five tables a SQL-engine deployment ends up with — the two core ones plus this engine's three.
 *
 * Kept as a re-export so a host that materialized this by hand does not break. It is NO LONGER the
 * declaration site for `run`/`run_event`: those are core (`@busyclaw/contracts`), reach `claw.$tables`
 * on their own, and are migrated for every database-backed claw whether or not an engine is
 * configured.
 */
export const sqlEngineSchema = {
	...runSchema,
	...runtimeTaskEntity.storage,
	...leaseEntity.storage,
	...idempotencyEntity.storage,
} satisfies SchemaDeclaration;
