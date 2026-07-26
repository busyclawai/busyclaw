// Run checkpoints — the durable resume substrate for yielded runs. A yield is the engine-flipped
// sibling of an approval wait: the run parks its resume state here and a continuation loads it
// exactly once via `consume`. Operational runtime state, not compliance evidence — human approvals
// keep their own record (see governance/approval.ts and docs/plans/yield-continuation-plan.md).

import { type } from "arktype";
import type { EntityInput, EntityRecord } from "./entity";
import { entity, field } from "./entity";

const runCheckpointStatusValues = ["pending", "consumed"] as const;

export const runCheckpointStatus = type("'pending' | 'consumed'");
export type RunCheckpointStatus = (typeof runCheckpointStatusValues)[number];

export const runCheckpointFields = {
	// Identity + resume state are fixed at create; the single-use consumption is the only transition.
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	status: field.enum(runCheckpointStatusValues, {
		required: true,
		index: true,
	}),
	runId: field.string({ index: true, immutable: true }),
	metadata: field.jsonObject({
		required: true,
		pii: "redacted",
		immutable: true,
	}),
	createdAt: field.string({ required: true, immutable: true }),
	// Stamped by the store's consume transition, never caller-provided.
	consumedAt: field.string({ input: false }),
} as const;

export const runCheckpointEntity = entity(
	"run_checkpoint",
	runCheckpointFields,
);
export const runCheckpointRecord = runCheckpointEntity.record;
export type RunCheckpointRecord = EntityRecord<typeof runCheckpointFields>;

export const newRunCheckpoint = runCheckpointEntity.schema({
	omit: ["status", "consumedAt"],
	optional: ["id"],
});
export type NewRunCheckpoint = EntityInput<
	typeof runCheckpointFields,
	"status" | "consumedAt",
	"id"
>;

/** The storage schema backing the RunCheckpointStore. */
export const runCheckpointSchema = runCheckpointEntity.storage;

/**
 * Durable home for yield checkpoints. The single-use guarantee is `consume`: under concurrent
 * continuations of the same checkpoint, exactly one caller gets the record, the rest get null.
 */
export type RunCheckpointStore = {
	/** Persist a pending checkpoint. Returns the stored record (with its assigned `id`). */
	create: (input: NewRunCheckpoint) => Promise<RunCheckpointRecord>;
	/** Read a checkpoint without consuming it. */
	get: (id: string) => Promise<RunCheckpointRecord | null>;
	/**
	 * Atomically take the single-use PENDING record by id (race-safe). Returns null if it's absent
	 * or already consumed. This is what makes a continuation run exactly once.
	 */
	consume: (id: string) => Promise<RunCheckpointRecord | null>;
};
