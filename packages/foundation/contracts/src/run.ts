// The RUN and its execution history — the governance record, not scheduling state.
//
// WHAT A RUN IS, because the name does not teach it on its own:
//
//   claw     the agent.
//   thread     the conversation.                       many runs
//   RUN          ONE THING SOMEBODY ASKED FOR,         many slices
//                carried to completion.
//   slice          one claimed execution of it.        many steps
//   step             one model call + at most one governed tool call.
//
// In a conversation a run IS a turn — and that is the projection, not the definition. A run started
// by cron answers nobody's message; a subagent spawn is a run; a scheduled job is a run. None of
// those is a turn, which is why this is not called one. A run becomes a turn exactly when it carries
// a `recording`: a claw, a thread, and a human at the other end.
//
// Durability is what lets ONE run span several slices — it checkpoints, a later replica claims it,
// and the transcript continues. That never makes a run the conversation; the thread is.
//
// These two live in contracts, and their siblings `runtime_task` / `lease` / `idempotency_key` do
// not, because the line is "does a second engine need this?". `run` carries `clawId` (the authz
// parent), `scope`/`scopeId` (the tenancy anchor), the control latch, and the id that
// `message.runId` / `tool_call.runId` / `checkpoint.runId` all point at. A Temporal or
// Durable-Objects engine still needs every one of those: euroclaw's authz, redaction and erasure
// cannot reach into a foreign workflow store to ask who owns a run. Scheduling is engine business;
// governance is not.
//
// Adapted from the shape engine-sql shipped, which is where they were declared until the tables
// split. Physical table names are unchanged.

import { runControlIntentValues, runWaitReasonValues } from "./engine";
import { entity, field } from "./entity";

const runStatusValues = [
	"queued",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
] as const;

export const runFields = {
	// A run's identity + input are fixed at create; only status advances. updatedAt is store-written.
	//
	// PRIMARY KEY, declared. It was `unique` alone while this lived in engine-sql, which the generators
	// treat very differently: a model with no declared primary key emits `@@ignore` under Prisma — an
	// unusable table — and every migration run warned about it. Joining CORE_MODELS put that warning in
	// front of the CLI's own gate, which is how it surfaced.
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
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

	// ── THE CLAW this run belongs to, and the THREAD its answers land in.
	//
	// `clawId` does two jobs no other column can. It is the authz PARENT — the run loader climbs to
	// the claw for `grantParents`, exactly as the approval and effect loaders already do, which is
	// what lets a claw's owner reach a run started by somebody she granted `use` to. And it is the
	// redaction CONTAINER a delivered message must tokenize into, which the door has to know before
	// any task is claimed, so a payload could never have carried it.
	//
	// STAMPED BY THE DOOR from the recording it derived server-side. Never from a request body: a
	// caller who could set this would be choosing their own authz parent and their own PII namespace.
	//
	// NO `references`. The migration emitter resolves a reference target through the schema it is
	// given and falls back to the raw model name when absent — and an engine-only deployment
	// materializes these tables without `claw`/`thread`, so an FK here would point at a table that
	// does not exist. Plain indexed strings, following `scope`/`scopeId`'s proven shape.
	clawId: field.string({ index: true, input: false, immutable: true }),
	threadId: field.string({ index: true, input: false, immutable: true }),
	// The user message this run answers, when it has one. Optional forever — a run started by cron
	// answers nobody's message.
	originMessageId: field.string({ input: false, immutable: true }),

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

// EXECUTION STATE, not telemetry: run_event rows are the engine's transactional lifecycle record,
// written alongside status flips with engine payloads (taskId, workerId, output). Kind names
// deliberately mirror the runtime's operational stream (`run.started`, …), but the planes never
// unify — operational observability is the runtime `EventSink` (best-effort, redacted at ingress);
// this table is load-bearing history.
export const runEventFields = {
	id: field.string({ required: true, primaryKey: true, unique: true }),
	runId: field.string({ required: true, index: true }),
	type: field.string({ required: true, index: true }),
	payload: field.jsonObject({ required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const runEntity = entity("run", runFields);
export const runEventEntity = entity("run_event", runEventFields);

/** The two run tables every engine needs, whatever it uses to schedule work. */
export const runSchema = {
	...runEntity.storage,
	...runEventEntity.storage,
};
