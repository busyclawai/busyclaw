/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (schema shape/patterns, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 */

import type { SchemaDeclaration } from "@busyclaw/contracts";
import {
	entity,
	field,
	runControlIntentValues,
	runWaitReasonValues,
} from "@busyclaw/contracts";

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
	principal: field.principal({ index: true, immutable: true }),

	// ── THE TENANCY ANCHOR. Written by the WORKER from the authority the runtime actually resolved,
	//    never by the api at `startRun` — at that point the host's configScope resolver has not run,
	//    so any value would be the api's GUESS at a tenant. A guessed anchor is worse than none: it
	//    manufactures false agreements and false disagreements with equal confidence. Absent until a
	//    run has executed at least one slice, and absent forever on a single-tenant deployment that
	//    resolves no scope at all.
	scope: field.string({ index: true, input: false }),
	scopeId: field.string({ index: true, input: false }),

	// ── THE CONTROL LATCH. The PRESENCE of controlRequestedAt is the intent; `status === "running"
	//    && controlRequestedAt !== undefined` IS the "stopping" state, derived, so runStatusValues
	//    needs no new member. controlIntent may only be RAISED (suspend < stop < abort); the other
	//    three are write-once, so an escalation never overwrites the first requester's identity.
	//    Cleared ONLY by the transition that honours it and by the terminal transitions — never by
	//    the api, never on a timer: a crash between the checkpoint write and the engine transaction
	//    must leave the intent live so the re-run honours it.
	controlRequestedAt: field.string({ index: true, input: false }),
	controlIntent: field.enum(runControlIntentValues, { input: false }),
	controlRequestedBy: field.principal({ index: true, input: false }),
	// `possible`, not `redacted`: an operator explanation a human reads back, which can still carry
	// a name or a ticket subject.
	controlReason: field.string({ pii: "possible", input: false }),

	// ── THE WATERMARK every control write bumps, so the loop can read ONE row by primary key per
	//    step and touch nothing else unless it moved. NOT `required`: planMigrations only ever ADDs
	//    columns and emits no UPDATE, so rows that already exist have no value here — code reads
	//    `row.controlSeq ?? 0`. Bumped as a CAS-retry, never `col = col + 1`; the Adapter port takes
	//    literal values only.
	controlSeq: field.number({ input: false }),

	// ── WHY this run is waiting, which decides what un-waits it. A YIELDED run is NOT here: it is
	//    `queued` with a due task, so the yield/park distinction already lives in `status`.
	waitReason: field.enum(runWaitReasonValues, { index: true, input: false }),
	// The checkpoint an external resume must name. Set iff waitReason === "suspended" AND the run had
	// already started; absent for a run suspended before its first claim, whose withheld task IS the
	// resume state. A fast path only — the authoritative lookup is by runId, because a crash between
	// the checkpoint write and the terminal transaction eats this column and not the row.
	resumeCheckpointId: field.string({ input: false }),

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

// EXECUTION STATE, not telemetry: run_event rows are the engine's transactional lifecycle record,
// written alongside status flips with engine payloads (taskId, workerId, output). Kind names
// deliberately mirror the runtime's operational stream (`run.started`, …), but the planes never
// unify — operational observability is the runtime `EventSink` (best-effort, redacted at ingress);
// this table is load-bearing history.
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
	scope: field.string({ index: true }),
	scopeId: field.string({ index: true }),
	principal: field.principal({ index: true }),
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
