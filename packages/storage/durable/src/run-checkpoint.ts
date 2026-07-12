// createRunCheckpointStore — the RunCheckpointStore port, backed by any @euroclaw/storage-core
// Adapter. The single-use guarantee rides on an atomic pending→consumed transition, so a yielded
// run resumes exactly once even under concurrent continuation claims. Persistence goes through
// `entityDb` — the metadata JSON column is (de)serialized by the schema layer, and every row
// crossing the adapter boundary is parsed against the record schema.

import type { Adapter } from "@euroclaw/contracts";
import {
	type NewRunCheckpoint,
	newRunCheckpoint as newRunCheckpointSchema,
	type RunCheckpointRecord,
	type RunCheckpointStore,
	runCheckpointFields,
	validationError,
} from "@euroclaw/contracts";
import { type EntityWhere, entityDb } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type RunCheckpointStoreOptions = {
	/** Time source — for deterministic consumedAt in tests. */
	now?: () => string;
};

const MODEL = "run_checkpoint";
const newId = (): string => bytesToHex(randomBytes(16));

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
	const db = entityDb(adapter, {
		run_checkpoint: { fields: runCheckpointFields },
	});

	const wherePending = (id: string): CheckpointWhere[] => [
		{ field: "id", value: id },
		{ field: "status", value: "pending", connector: "AND" },
	];

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

		async consume(id) {
			// Atomic transition of the pending row by id — race-safe single use while preserving the
			// resume metadata for the winning continuation.
			return db.update({
				model: MODEL,
				where: wherePending(id),
				update: { status: "consumed", consumedAt: now() },
			});
		},
	};
}
