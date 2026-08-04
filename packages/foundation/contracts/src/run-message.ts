// The run inbox — durable messages addressed to a run in flight.
//
// Addressed by RUN, never by thread. "Deliver into this run" is the control plane's job; "which run
// owns this conversation" is a product question two consumers answer differently — channels wants
// one live run per thread, a subagent fan-out wants many children under one parent, by design.
// Putting thread arbitration here would bake the channels rule into the substrate and be wrong for
// subagents on the same day.

import { type } from "arktype";
import type { EntityInput, EntityRecord } from "./entity";
import { entity, field } from "./entity";

/**
 * WHEN a message enters the receiving run's context.
 *
 * The mode is an explicit field the runtime enforces, not something emergent from where the message
 * entered. Codex's three behaviours fall out of lane × trigger_turn × delivery phase and none of
 * them is nameable in its API — a caller cannot *ask* for "the next safe pause".
 */
const runMessageModeValues = ["at_turn_end", "next_step", "interrupt"] as const;
export const runMessageMode = type.enumerated(...runMessageModeValues);
export type RunMessageMode = (typeof runMessageModeValues)[number];

const runMessageStatusValues = ["pending", "delivered", "dead"] as const;
export const runMessageStatus = type.enumerated(...runMessageStatusValues);
export type RunMessageStatus = (typeof runMessageStatusValues)[number];

export const runMessageFields = {
	// Derived from (toRunId, sender, idempotencyKey) so the INSERT is the admission: a duplicate
	// loses at the database rather than becoming a second copy in somebody's context window.
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	toRunId: field.string({ required: true, index: true, immutable: true }),
	mode: field.enum(runMessageModeValues, {
		required: true,
		index: true,
		immutable: true,
	}),
	// Tokenized at admit into the RECEIVING run's container — the drain never re-redacts, because the
	// loop's one-redaction rule is what keeps a transcript's placeholders stable across a park.
	body: field.jsonObject({ required: true, pii: "redacted", immutable: true }),
	// WHICH CONTAINER holds those tokens, so erasure can find them without guessing. Named for the
	// dimension it actually is: a PII container is an entity reference (`claw`, `run`, a plugin id),
	// never a tenancy scope — see contracts/src/pii-container.ts.
	containerKind: field.string({ immutable: true }),
	containerId: field.string({ immutable: true }),
	sender: field.principal({ required: true, index: true, immutable: true }),
	// Per-run FIFO. Minted under the receiving run's `controlSeq` in the admit transaction — one
	// counter doing two jobs (order, and the watermark the loop reads) because both are read together
	// on the hot path. Across runs there is no order and none is needed.
	seq: field.number({ required: true, index: true, immutable: true }),
	status: field.enum(runMessageStatusValues, { required: true, index: true }),
	// Forensic only. NOT the redelivery fence: a message delivered and parked in the same verdict is
	// snapshotted into the checkpoint that follows it, so a step-based predicate re-pushes it every
	// resume, deterministically. The fence is `deliveredThrough` in the checkpoint envelope, because
	// only the snapshot knows what the model will actually see.
	deliveredAtStep: field.number({ index: true }),
	lastError: field.string({ pii: "redacted" }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true, input: false }),
} as const;

export const runMessageEntity = entity("run_message", runMessageFields);
export const runMessageRecord = runMessageEntity.record;
export type RunMessageRecord = EntityRecord<typeof runMessageFields>;

export const newRunMessage = runMessageEntity.schema({
	omit: ["status", "deliveredAtStep", "lastError", "updatedAt"],
});
export type NewRunMessage = EntityInput<
	typeof runMessageFields,
	"status" | "deliveredAtStep" | "lastError" | "updatedAt"
>;

/** The storage schema backing the run inbox. */
export const runMessageSchema = runMessageEntity.storage;
