// createApprovalStore — the ApprovalStore port, backed by any @busyclaw/storage-core Adapter
// (memory / kysely / drizzle / prisma / mongo). The single-use guarantee rides on an atomic
// approved→consumed transition, so a granted approval resumes exactly once even under concurrent
// retries. Persistence goes through `entityDb` — the model name drives the row types, and every
// row crossing the adapter boundary is parsed against the approval record schema (reads are
// untrusted boundary data), so the store never casts and never hand-rolls read validation.

import type { Adapter } from "@busyclaw/contracts";
import {
	type ApprovalRecord,
	type ApprovalStore,
	approvalFields,
	type NewApproval,
	newApproval as newApprovalSchema,
	validationError,
} from "@busyclaw/contracts";
import { type EntityWhere, entityDb } from "@busyclaw/storage-core";
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

		async claim(id, leaseMs) {
			const existing = await db.findOne({
				model: MODEL,
				where: [{ field: "id", value: id }],
			});
			if (!existing) return null;
			// A finished approval is answered from its stored result, never re-run — the caller reads
			// `status`/`result` and does not come here.
			if (existing.status === "completed") return null;
			if (existing.status === "executing") {
				// Somebody is running it. Only a LAPSED lease may be re-taken, and that is the whole
				// recovery story: a resume that died between taking and finishing left a lease nobody
				// will clear. Bounded by the clock rather than open to whoever asks twice.
				if (
					existing.leaseExpiresAt == null ||
					existing.leaseExpiresAt >= now()
				) {
					return null;
				}
			} else if (existing.status !== "approved") {
				return null;
			}
			if (existing.expiresAt != null && existing.expiresAt < now()) return null;

			const leaseId = newId();
			// The WHERE pins the status the read saw, so two concurrent takers cannot both transition:
			// the loser's update matches no row and it gets null, the same answer it would get from a
			// live lease. Recovery races are decided here rather than by who wrote last.
			const taken = await db.update({
				model: MODEL,
				where: [
					{ field: "id", value: id },
					{ field: "status", value: existing.status, connector: "AND" },
					...(existing.status === "executing" && existing.leaseId != null
						? [
								{
									field: "leaseId" as const,
									value: existing.leaseId,
									connector: "AND" as const,
								},
							]
						: []),
				],
				update: {
					status: "executing",
					leaseId,
					leaseExpiresAt: new Date(Date.parse(now()) + leaseMs).toISOString(),
				},
			});
			return taken ? { record: taken, leaseId } : null;
		},

		async complete(id, leaseId, result) {
			// Only the CURRENT lease may finish. A runner whose lease lapsed and was re-taken has lost
			// the right to write a terminal result — otherwise it would overwrite the answer its
			// replacement already returned to a caller.
			return db.update({
				model: MODEL,
				where: [
					{ field: "id", value: id },
					{ field: "status", value: "executing", connector: "AND" },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
				update: { status: "completed", result },
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
