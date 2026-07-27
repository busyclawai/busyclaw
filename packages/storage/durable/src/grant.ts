// createAccessGrantStore — the AccessGrantStore port, backed by any @busyclaw/storage-core Adapter
// (memory / kysely / drizzle / prisma / mongo). The generic shareable-resource ACL
// (docs/plans/app-authz.md §6): ONE table for EVERY shareable kind, org-blind — resourceKind,
// resourceId, and principalRef are all OPAQUE strings the store never interprets. Rows are IMMUTABLE: a
// share is a `create`, an unshare a `delete` (grants are DATA, never compiled policy). `listForResource`
// is the hot path the product-api PEP reads per governed call; it projects each validated row to the
// PEP's `{ principalRef, level }` shape — the same type @busyclaw/authz renders, so there is no
// translation seam. Persistence goes through `entityDb`, so every row crossing the adapter is parsed
// against the access_grant record schema (reads are untrusted boundary data).

import type {
	AccessGrant,
	AccessGrantRecord,
	AccessGrantStore,
	Adapter,
	NewAccessGrant,
} from "@busyclaw/contracts";
import {
	accessGrantCreateInput,
	accessGrantFields,
	validationError,
} from "@busyclaw/contracts";
import { type EntityWhere, entityDb } from "@busyclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type AccessGrantStoreOptions = {
	/** Time source — for deterministic createdAt in tests. */
	now?: () => string;
};

const MODEL = "access_grant";
const newId = (): string => bytesToHex(randomBytes(16));

function validateNewGrant(input: unknown): NewAccessGrant {
	const valid = accessGrantCreateInput(input);
	if (valid instanceof type.errors) {
		throw validationError("new access grant invalid", valid.summary);
	}
	return valid;
}

/** Back the AccessGrantStore port with a storage Adapter. */
export function createAccessGrantStore(
	adapter: Adapter,
	options: AccessGrantStoreOptions = {},
): AccessGrantStore {
	const now = options.now ?? (() => new Date().toISOString());
	const db = entityDb(adapter, { access_grant: { fields: accessGrantFields } });

	return {
		async listForResources(keys) {
			if (keys.length === 0) return new Map();
			// Group the ids by kind so the query is one OR-branch per DISTINCT KIND with an `in` over its
			// ids — usually one or two branches, however long the page is. The alternative (one AND-group
			// per key) is correct too and grows a branch per row, which is the shape indexes like least.
			const idsByKind = new Map<string, Set<string>>();
			for (const key of keys) {
				const ids = idsByKind.get(key.resourceKind);
				if (ids) ids.add(key.resourceId);
				else idsByKind.set(key.resourceKind, new Set([key.resourceId]));
			}
			type GrantWhere = EntityWhere<typeof accessGrantFields>;
			const branches: GrantWhere[] = [...idsByKind].map(([kind, ids]) => ({
				and: [
					{ field: "resourceKind", value: kind },
					{ field: "resourceId", value: [...ids], operator: "in" },
				],
			}));
			const rows = await db.findMany({
				model: MODEL,
				// A single branch does not need the wrapper — an OR of one is just the branch.
				where: branches.length === 1 ? branches : [{ or: branches }],
			});
			// Project the validated rows to the opaque PEP shape (permission → level). The audit columns
			// (id/grantedBy/createdAt) never reach the decision — access is (principalRef, level) only.
			const byKind = new Map<string, Map<string, AccessGrant[]>>();
			for (const row of rows) {
				let byId = byKind.get(row.resourceKind);
				if (!byId) {
					byId = new Map();
					byKind.set(row.resourceKind, byId);
				}
				const grants = byId.get(row.resourceId);
				const grant: AccessGrant = {
					principalRef: row.principalRef,
					level: row.permission,
				};
				if (grants) grants.push(grant);
				else byId.set(row.resourceId, [grant]);
			}
			return byKind;
		},

		async create(input) {
			const valid = validateNewGrant(input);
			const record: AccessGrantRecord = {
				id: newId(),
				createdAt: now(),
				...valid,
			};
			await db.create({ model: MODEL, data: record });
			return record;
		},

		// Unshare by the natural key — revokes every level the grantee held on the resource (a principal
		// may carry more than one row). Returns how many rows went.
		delete({ resourceKind, resourceId, principalRef }) {
			return db.deleteMany({
				model: MODEL,
				where: [
					{ field: "resourceKind", value: resourceKind },
					{ field: "resourceId", value: resourceId, connector: "AND" },
					{ field: "principalRef", value: principalRef, connector: "AND" },
				],
			});
		},
	};
}
