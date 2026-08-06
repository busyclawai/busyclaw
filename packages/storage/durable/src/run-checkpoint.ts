// createRunCheckpointStore — the RunCheckpointStore port, backed by any @busyclaw/storage-core
// Adapter. Single use rides on two atomic transitions — pending→claimed (leased, so a crashed
// attempt's hold expires rather than stranding the row) and claimed→consumed (pinned to the
// claim) — so a yielded run resumes exactly once under concurrent continuations AND survives the
// process that was resuming it dying. Persistence goes through `entityDb` — the metadata JSON
// column is (de)serialized by the schema layer, and every row crossing the adapter boundary is
// parsed against the record schema.

import type { Adapter } from "@busyclaw/contracts";
import {
	type NewRunCheckpoint,
	newRunCheckpoint as newRunCheckpointSchema,
	type RunCheckpointRecord,
	type RunCheckpointStore,
	runCheckpointFields,
	validationError,
} from "@busyclaw/contracts";
import { type EntityWhere, entityDb } from "@busyclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type RunCheckpointStoreOptions = {
	/** Time source — for deterministic consumedAt in tests. */
	now?: () => string;
	/**
	 * How long one resume attempt holds a claimed checkpoint before it becomes re-claimable.
	 *
	 * Deliberately SHORT — matched to the engine's task lease, not to the approval lease. Mutual
	 * exclusion between two live resume attempts is already owned by the task lease, which is
	 * heartbeated: a worker that loses it aborts mid-slice. This lease exists only so a CRASHED
	 * attempt's claim expires. Making it longer than the task lease would convert a crash into a
	 * permanent stall — the task requeues in seconds, finds the checkpoint still claimed, retires
	 * itself, and the run sits `queued` with no task and no way back.
	 */
	claimLeaseMs?: number;
};

const MODEL = "run_checkpoint";
/** Mirrors `DEFAULT_LEASE_TTL_MS` in @busyclaw/engine-sql — see `claimLeaseMs`. */
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const newId = (): string => bytesToHex(randomBytes(16));

function addMs(iso: string, ms: number): string {
	return new Date(new Date(iso).getTime() + ms).toISOString();
}

type CheckpointWhere = EntityWhere<typeof runCheckpointFields>;

function validateNewCheckpoint(input: unknown): NewRunCheckpoint {
	const valid = newRunCheckpointSchema(input);
	if (valid instanceof type.errors) {
		throw validationError("new run checkpoint invalid", valid.summary);
	}
	return valid;
}

/** Back the RunCheckpointStore port with a storage Adapter. */
export function createRunCheckpointStore(
	adapter: Adapter,
	options: RunCheckpointStoreOptions = {},
): RunCheckpointStore {
	const now = options.now ?? (() => new Date().toISOString());
	const defaultLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
	const db = entityDb(adapter, {
		run_checkpoint: { fields: runCheckpointFields },
	});

	const wherePending = (id: string): CheckpointWhere[] => [
		{ field: "id", value: id },
		{ field: "status", value: "pending", connector: "AND" },
	];

	// A `claimed` row whose lease has already lapsed. Kept as its own predicate rather than OR-ing it
	// into `wherePending`: the Where tree is a left-fold, so mixing the two would need grouping the
	// port does not make obvious, and the reclaim path is rare enough that a second round trip on it
	// is the cheaper kind of cost.
	const whereLapsed = (id: string, ts: string): CheckpointWhere[] => [
		{ field: "id", value: id },
		{ field: "status", value: "claimed", connector: "AND" },
		{
			field: "leaseExpiresAt",
			value: ts,
			operator: "lte",
			connector: "AND",
		},
	];

	/**
	 * Drop the checkpoints this run has moved past — hazard P3(a).
	 *
	 * Every reader departure used to mint a permanent full-transcript checkpoint, plus a resume task
	 * and an event, and nothing collected any of it. A chat turn suspended and resumed twenty times
	 * left twenty copies of a growing transcript, nineteen of which no code path can ever reach:
	 * `latestPendingForRun` takes the NEWEST pending row, so an older one is not a fallback, it is
	 * dead weight carrying a full conversation.
	 *
	 * OLDER, not "every other row", and that distinction is the whole correctness of this. A slice
	 * that parks writes its successor BEFORE this runs — `persistYieldCheckpoint` fires inside the
	 * loop, `complete` fires after it returns — so "delete the others" would delete the run's only
	 * way forward. Bounded by `createdAt lte` and excluding the row just consumed, which leaves that
	 * successor and nothing else.
	 *
	 * BEST EFFORT. The resume has already succeeded by the time this runs; a sweep that failed must
	 * not turn a completed slice into a thrown one. What it costs is rows that stay, which is exactly
	 * the situation before this existed.
	 */
	const deleteSuperseded = async (
		runId: string,
		consumedId: string,
		createdAt: string,
	): Promise<void> => {
		try {
			await db.deleteMany({
				model: MODEL,
				where: [
					{ field: "runId", value: runId },
					{ field: "createdAt", value: createdAt, operator: "lte" },
					// `lte` rather than `lt` because two parks can share a millisecond; the id exclusion
					// is what keeps the consumed row itself, which is the run's record of where it got to.
					{ field: "id", value: consumedId, operator: "ne" },
				],
			});
		} catch {
			// Nothing downstream depends on the sweep having run.
		}
	};

	return {
		async create(input) {
			const valid = validateNewCheckpoint(input);
			const record: RunCheckpointRecord = {
				id: valid.id ?? newId(),
				status: "pending",
				...(valid.runId !== undefined ? { runId: valid.runId } : {}),
				metadata: valid.metadata,
				createdAt: valid.createdAt,
			};
			await db.create({ model: MODEL, data: record });
			return record;
		},

		async get(id) {
			return db.findOne({
				model: MODEL,
				where: [{ field: "id", value: id }],
			});
		},

		async latestPendingForRun(runId) {
			// `pending` only: a `claimed` row belongs to a live attempt (or one whose lease has not
			// lapsed yet), and handing it out here would be a second slice resuming the same transcript
			// behind the first one's back. Newest first, because a run that parked more than once is
			// continued from where it actually got to.
			const rows = await db.findMany({
				model: MODEL,
				where: [
					{ field: "runId", value: runId },
					{ field: "status", value: "pending", connector: "AND" },
				],
				sortBy: { field: "createdAt", direction: "desc" },
				limit: 1,
			});
			return rows[0] ?? null;
		},

		async claim(id, claimOptions = {}) {
			// Two ordered CASes, never a read-then-write. Each `update` returns the row it changed or
			// null when its predicate matched nothing, so exactly one concurrent caller can win either
			// arm — the same primitive the engine's task claim rides on.
			const ts = now();
			const leaseId = newId();
			const leaseExpiresAt = addMs(ts, claimOptions.leaseMs ?? defaultLeaseMs);
			const patch = { status: "claimed", leaseId, leaseExpiresAt } as const;

			const fresh = await db.update({
				model: MODEL,
				where: wherePending(id),
				update: patch,
			});
			if (fresh) return { record: fresh, leaseId };

			// The previous attempt died holding it. Taking it back is the whole point of leasing the
			// claim: without this arm the row stays unreachable and the run it belongs to is lost.
			const reclaimed = await db.update({
				model: MODEL,
				where: whereLapsed(id, ts),
				update: patch,
			});
			return reclaimed ? { record: reclaimed, leaseId } : null;
		},

		async deleteForRuns(runIds) {
			// RETENTION, and the caller owns the precondition that these runs are terminal — a pending
			// checkpoint is a live run's only way forward, and this port cannot see run status to check.
			if (runIds.length === 0) return 0;
			const rows = await db.findMany({
				model: MODEL,
				where: [{ field: "runId", value: [...runIds], operator: "in" }],
			});
			if (rows.length === 0) return 0;
			await adapter.deleteMany?.({
				model: MODEL,
				where: [{ field: "runId", value: [...runIds], operator: "in" }],
			});
			return rows.length;
		},

		async complete(id, leaseId) {
			// Pinned on the leaseId: an attempt that overran its lease and was re-claimed by another
			// worker must not retire the row out from under the attempt that now owns it.
			const consumed = await db.update({
				model: MODEL,
				where: [
					{ field: "id", value: id },
					{ field: "status", value: "claimed", connector: "AND" },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
				update: { status: "consumed", consumedAt: now(), leaseExpiresAt: null },
			});
			if (consumed?.runId !== undefined) {
				await deleteSuperseded(consumed.runId, id, consumed.createdAt);
			}
			return consumed;
		},
	};
}
