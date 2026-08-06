// Run checkpoints — the durable resume substrate for yielded runs. A yield is the engine-flipped
// sibling of an approval wait: the run parks its resume state here and a continuation takes it
// exactly once, via `claim` for the duration of an attempt and `complete` once that attempt has
// returned. Operational runtime state, not compliance evidence — human approvals keep their own
// record (see governance/approval.ts and docs/plans/yield-continuation-plan.md).

import { type } from "arktype";
import type { EntityInput, EntityRecord } from "./entity";
import { entity, field } from "./entity";

const runCheckpointStatusValues = ["pending", "claimed", "consumed"] as const;

// DERIVED, never hand-written. A second literal union here drifts from the values array the moment
// one of them gains a member — the array feeds `field.enum` (so the column accepts the new value)
// while the exported validator keeps rejecting it, and the two disagree silently at a boundary.
export const runCheckpointStatus = type.enumerated(
	...runCheckpointStatusValues,
);
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
	// Stamped by the store's claim/complete transitions, never caller-provided.
	consumedAt: field.string({ input: false }),
	// The claim's proof and its expiry. A checkpoint is `claimed` for the duration of one resume
	// attempt; if that attempt dies, the lease lapses and the row becomes re-claimable instead of
	// being stranded `consumed` with nobody running it.
	leaseId: field.string({ input: false }),
	leaseExpiresAt: field.string({ index: true, input: false }),
} as const;

export const runCheckpointEntity = entity(
	"run_checkpoint",
	runCheckpointFields,
);
export const runCheckpointRecord = runCheckpointEntity.record;
export type RunCheckpointRecord = EntityRecord<typeof runCheckpointFields>;

export const newRunCheckpoint = runCheckpointEntity.schema({
	omit: ["status", "consumedAt", "leaseId", "leaseExpiresAt"],
	optional: ["id"],
});
export type NewRunCheckpoint = EntityInput<
	typeof runCheckpointFields,
	"status" | "consumedAt" | "leaseId" | "leaseExpiresAt",
	"id"
>;

/** The storage schema backing the RunCheckpointStore. */
export const runCheckpointSchema = runCheckpointEntity.storage;

/** The proof that one resume attempt holds a checkpoint, carried into `complete`. */
export type RunCheckpointClaim = {
	record: RunCheckpointRecord;
	leaseId: string;
};

/**
 * Durable home for yield checkpoints. Single-use is enforced across TWO transitions, not one:
 * `claim` takes the row for the duration of an attempt, `complete` retires it once the resumed
 * slice has actually returned.
 *
 * The single-transition version (`consume`: pending → consumed, before running anything) was a
 * live kill. A process that died after the flip left every retry unable to take the row, so the
 * task dead-lettered and the RUN was marked `failed` — while its complete, resumable transcript sat
 * on disk in a row nothing outside a test ever reads. Leasing the claim makes a crashed attempt
 * recoverable and keeps exactly-once: two live callers cannot both hold the row.
 */
export type RunCheckpointStore = {
	/** Persist a pending checkpoint. Returns the stored record (with its assigned `id`). */
	create: (input: NewRunCheckpoint) => Promise<RunCheckpointRecord>;
	/** Read a checkpoint without claiming it. */
	get: (id: string) => Promise<RunCheckpointRecord | null>;
	/**
	 * The run's newest still-unconsumed checkpoint, or null.
	 *
	 * The AUTHORITATIVE way to find a run's resume state. A run row may also carry a
	 * `resumeCheckpointId`, but that is a fast path a crash can eat: the checkpoint row is written
	 * first and the column by a later transaction, so the window between them leaves a run whose
	 * transcript is on disk and whose pointer to it is not. Resolving by run id closes that window,
	 * and is also what lets a retried first-slice task discover it has work to continue rather than
	 * starting the run over.
	 */
	latestPendingForRun: (runId: string) => Promise<RunCheckpointRecord | null>;
	/**
	 * Atomically take the row for one attempt (race-safe): `pending` → `claimed`, or a `claimed`
	 * row whose lease has EXPIRED → re-claimed by the new attempt. Returns null when the row is
	 * absent, already `consumed`, or held by a live lease — none of which is this caller's failure.
	 */
	claim: (
		id: string,
		options?: { leaseMs?: number },
	) => Promise<RunCheckpointClaim | null>;
	/**
	 * Retire a claimed row: `claimed` → `consumed`, pinned on the claim's `leaseId` so an attempt
	 * whose lease lapsed and was re-claimed by someone else cannot retire the winner's work.
	 * Returns null when this claim no longer owns the row.
	 */
	complete: (
		id: string,
		leaseId: string,
	) => Promise<RunCheckpointRecord | null>;
	/**
	 * Delete every checkpoint of these runs, and report how many went — retention, not correctness.
	 *
	 * Only ever called for runs that have REACHED A TERMINAL STATUS, which is what makes it safe: a
	 * pending checkpoint is a run's only way forward, and deleting one belonging to a live run would
	 * strand it. The caller owns that precondition because only the caller can see run status; this
	 * port knows about checkpoints.
	 *
	 * OPTIONAL, like every retention hook: a store that manages its own lifetime (a TTL'd KV, a
	 * partitioned table) has nothing to do here, and a host that never prunes never calls it.
	 */
	deleteForRuns?: (runIds: readonly string[]) => Promise<number>;
};
