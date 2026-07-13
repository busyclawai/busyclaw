// createApprovalStore — the ApprovalStore port, backed by any @euroclaw/storage-core Adapter
// (memory / kysely / drizzle / prisma / mongo). The single-use guarantee rides on an atomic
// approved→consumed transition, so a granted approval resumes exactly once even under concurrent
// retries. Persistence goes through `entityDb` — the model name drives the row types, and every
// row crossing the adapter boundary is parsed against the approval record schema (reads are
// untrusted boundary data), so the store never casts and never hand-rolls read validation.

import type { Adapter } from "@euroclaw/contracts";
import {
	type ApprovalRecord,
	type ApprovalStore,
	approvalFields,
	type NewApproval,
	newApproval as newApprovalSchema,
	validationError,
} from "@euroclaw/contracts";
import { type EntityWhere, entityDb } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type ApprovalStoreOptions = {
	/** Time source — for deterministic expiry in tests. */
	now?: () => string;
};

const MODEL = "approval";
const newId = (): string => bytesToHex(randomBytes(16));

type ApprovalWhere = EntityWhere<typeof approvalFields>;

function validateNewApproval(input: unknown): NewApproval {
	const valid = newApprovalSchema(input);
	if (valid instanceof type.errors) {
		throw validationError("new approval invalid", valid.summary);
	}
	return valid;
}

/** Back the ApprovalStore port with a storage Adapter. */
export function createApprovalStore(
	adapter: Adapter,
	options: ApprovalStoreOptions = {},
): ApprovalStore {
	const now = options.now ?? (() => new Date().toISOString());
	const db = entityDb(adapter, { approval: { fields: approvalFields } });

	// Only a still-pending row can be granted/denied — guards against deciding a consumed approval.
	const wherePending = (id: string): ApprovalWhere[] => [
		{ field: "id", value: id },
		{ field: "status", value: "pending", connector: "AND" },
	];
	const whereApproved = (id: string): ApprovalWhere[] => [
		{ field: "id", value: id },
		{ field: "status", value: "approved", connector: "AND" },
	];

	return {
		async create(input) {
			const valid = validateNewApproval(input);
			const record: ApprovalRecord = {
				id: newId(),
				status: "pending",
				...valid,
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

		async grant(id, by) {
			return db.update({
				model: MODEL,
				where: wherePending(id),
				update: { status: "approved", decidedBy: by },
			});
		},

		async deny(id, by, reason) {
			const update: Partial<ApprovalRecord> = {
				status: "denied",
				decidedBy: by,
			};
			if (reason !== undefined) update.reason = reason;
			return db.update({
				model: MODEL,
				where: wherePending(id),
				update,
			});
		},

		async consume(id) {
			const existing = await db.findOne({
				model: MODEL,
				where: whereApproved(id),
			});
			if (!existing) return null;
			if (existing.expiresAt != null && existing.expiresAt < now()) return null;

			// Atomic transition of the approved row by id — race-safe single use while preserving
			// checkpoint metadata for crash recovery.
			return db.update({
				model: MODEL,
				where: whereApproved(id),
				update: { status: "consumed" },
			});
		},

		async list(filter) {
			const where: ApprovalWhere[] = [];
			if (filter?.status !== undefined)
				where.push({ field: "status", value: filter.status });
			if (filter?.principal !== undefined)
				where.push({
					field: "principal",
					value: filter.principal,
					connector: "AND",
				});
			return db.findMany({ model: MODEL, where });
		},
	};
}
