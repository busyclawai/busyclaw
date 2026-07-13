/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (schema shape/patterns, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 */

import type { SchemaDeclaration } from "@euroclaw/contracts";
import { entity, field } from "@euroclaw/contracts";

const runStatusValues = [
	"queued",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
] as const;

const taskStatusValues = [
	"pending",
	"leased",
	"completed",
	"failed",
	"dead",
] as const;

export const runFields = {
	// A run's identity + input are fixed at create; only status advances. updatedAt is store-written.
	id: field.string({ required: true, unique: true, immutable: true }),
	status: field.enum(runStatusValues, { required: true, index: true }),
	input: field.jsonObject({ required: true, immutable: true }),
	principal: field.string({ index: true, immutable: true }),
	team: field.string({ index: true, immutable: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true, input: false }),
} as const;

export const runtimeTaskFields = {
	id: field.string({ required: true, unique: true }),
	runId: field.string({ required: true, index: true }),
	kind: field.string({ required: true, index: true }),
	status: field.enum(taskStatusValues, { required: true, index: true }),
	payload: field.jsonObject({ required: true }),
	dueAt: field.string({ required: true, index: true }),
	attempt: field.number({ required: true }),
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

export const runEventFields = {
	id: field.string({ required: true, unique: true }),
	runId: field.string({ required: true, index: true }),
	type: field.string({ required: true, index: true }),
	payload: field.jsonObject({ required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const leaseFields = {
	id: field.string({ required: true, unique: true }),
	taskId: field.string({ required: true, index: true }),
	workerId: field.string({ required: true, index: true }),
	tokenHash: field.string({ required: true }),
	expiresAt: field.string({ required: true, index: true }),
	lastHeartbeatAt: field.string({ required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const idempotencyFields = {
	id: field.string({ required: true, unique: true }),
	key: field.string({ required: true, index: true }),
	method: field.string({ required: true }),
	path: field.string({ required: true }),
	organizationId: field.string({ index: true }),
	actor: field.string({ index: true }),
	requestHash: field.string({ required: true }),
	responseStatus: field.number({ required: true }),
	responseBody: field.jsonObject({ required: true }),
	createdAt: field.string({ required: true }),
} as const;

const runEntity = entity("run", runFields);
const runtimeTaskEntity = entity("runtime_task", runtimeTaskFields);
const runEventEntity = entity("run_event", runEventFields);
const leaseEntity = entity("lease", leaseFields);
const idempotencyEntity = entity("idempotency_key", idempotencyFields);

/** Tables required by the SQL host kernel. Hosts materialize these through the app's DB adapter. */
export const sqlEngineSchema = {
	...runEntity.storage,
	...runtimeTaskEntity.storage,
	...runEventEntity.storage,
	...leaseEntity.storage,
	...idempotencyEntity.storage,
} satisfies SchemaDeclaration;
