/**
 * @euroclaw/storage-core — the storage Adapter port, the declarative schema format, and a zero-dep
 * in-memory adapter. euroclaw's durable state is narrow — the audit log and pending approvals
 * (better-auth keeps users/orgs/roles) — but the port is the proven generic CRUD one, so any ORM
 * adapter (`@euroclaw/storage-drizzle`, `-prisma`, `-kysely`, `-mongodb`) plugs in.
 *
 * The `Adapter` CRUD shape (including the atomic `consumeOne` single-use primitive), the `Where`
 * shape, and the declarative table-schema format are based on Better Auth's database adapter:
 *   https://github.com/better-auth/better-auth — `packages/core/src/db` (`DBAdapter`) and its
 *   plugin schema files (`packages/better-auth/src/plugins/<name>/schema.ts`).
 * euroclaw's port is a leaner subset (no field-mapping / multi-id machinery). MIT, © 2024-present
 * Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import type { Adapter, SortBy, Where, WhereClause } from "@euroclaw/contracts";
import {
	configurationError,
	isWhereGroup,
	sortByList,
} from "@euroclaw/contracts";

// The storage PROTOCOL (Adapter, Where, the declarative schema format) lives in
// @euroclaw/contracts/storage — plugins type against it without depending on this package. This
// package keeps the implementations: schemaAdapter, the memory adapter, and matchWhere.
export type {
	Adapter,
	FieldAttribute,
	FieldType,
	SchemaDeclaration,
	SortBy,
	TableSchema,
	Where,
	WhereClause,
	WhereGroup,
	WhereOperator,
} from "@euroclaw/contracts";
export { isWhereGroup, sortByList } from "@euroclaw/contracts";
export {
	type EntityDb,
	type EntityModelMap,
	type EntityPatch,
	type EntityReadRecord,
	type EntitySortBy,
	type EntityValidatedAdapter,
	type EntityWhere,
	type EntityWhereClause,
	entityAdapter,
	entityDb,
	entityView,
} from "./entity-adapter";
export { type SchemaAdapterOptions, schemaAdapter } from "./schema-adapter";

// ── The memory adapter ───────────────────────────────────────────────────────────────────────

/** Fold a string comparison through the clause's case mode. */
function stringsOf(
	v: unknown,
	clause: WhereClause,
): { row: string; value: string } | undefined {
	if (typeof v !== "string" || typeof clause.value !== "string")
		return undefined;
	return clause.mode === "insensitive"
		? { row: v.toLowerCase(), value: clause.value.toLowerCase() }
		: { row: v, value: clause.value };
}

function matchOne(row: Record<string, unknown>, w: WhereClause): boolean {
	const v = row[w.field];
	const s = stringsOf(v, w);
	switch (w.operator ?? "eq") {
		case "eq":
			return s ? s.row === s.value : v === w.value;
		case "ne":
			return s ? s.row !== s.value : v !== w.value;
		case "lt":
			return (v as number) < (w.value as number);
		case "lte":
			return (v as number) <= (w.value as number);
		case "gt":
			return (v as number) > (w.value as number);
		case "gte":
			return (v as number) >= (w.value as number);
		case "in":
			return Array.isArray(w.value) && (w.value as unknown[]).includes(v);
		case "not_in":
			return Array.isArray(w.value) && !(w.value as unknown[]).includes(v);
		case "contains":
			return s !== undefined && s.row.includes(s.value);
		case "starts_with":
			return s !== undefined && s.row.startsWith(s.value);
		case "ends_with":
			return s !== undefined && s.row.endsWith(s.value);
		default:
			return false;
	}
}

/**
 * Apply a where tree to a row: left-fold by each node's connector; a group recurses with its own
 * combinator (its members left-fold as all-AND or all-OR). Empty `where` matches all rows; an
 * empty GROUP is a caller bug and fails loud (never a silent match-all/match-none).
 */
export function matchWhere(
	row: Record<string, unknown>,
	where: Where[],
): boolean {
	let result = true;
	let seen = false;
	for (const w of where) {
		let m: boolean;
		if (isWhereGroup(w)) {
			const members = "and" in w && w.and !== undefined ? w.and : w.or;
			if (!members || members.length === 0) {
				throw configurationError("storage where group is empty", {});
			}
			m =
				"and" in w && w.and !== undefined
					? members.every((member) => matchWhere(row, [member]))
					: members.some((member) => matchWhere(row, [member]));
		} else {
			m = matchOne(row, w);
		}
		result = !seen ? m : w.connector === "OR" ? result || m : result && m;
		seen = true;
	}
	return result;
}

/** A zero-dependency in-memory Adapter — the dev/test default. Rows are stored per model. */
export function memoryAdapter(): Adapter {
	const db = new Map<string, Record<string, unknown>[]>();
	let transactionQueue = Promise.resolve();
	const make = (state: Map<string, Record<string, unknown>[]>): Adapter => {
		const table = (model: string): Record<string, unknown>[] => {
			let t = state.get(model);
			if (!t) {
				t = [];
				state.set(model, t);
			}
			return t;
		};
		const out = (row: Record<string, unknown>): Record<string, unknown> => ({
			...row,
		});

		return {
			id: "memory",
			async create({ model, data }) {
				const row = { ...data } as Record<string, unknown>;
				table(model).push(row);
				return out(row);
			},
			async findOne({ model, where }) {
				const row = table(model).find((r) => matchWhere(r, where));
				return row ? out(row) : null;
			},
			async findMany({ model, where, limit, offset, sortBy }) {
				let rows = table(model).filter((r) => matchWhere(r, where ?? []));
				const sorts: SortBy[] = sortByList(sortBy);
				if (sorts.length > 0) {
					// Multi-column: compare by each sort in order, first non-tie wins.
					rows = [...rows].sort((a, b) => {
						for (const { field, direction } of sorts) {
							const av = a[field] as number;
							const bv = b[field] as number;
							const cmp = av < bv ? -1 : av > bv ? 1 : 0;
							if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
						}
						return 0;
					});
				}
				if (offset) rows = rows.slice(offset);
				if (limit !== undefined) rows = rows.slice(0, limit);
				return rows.map((r) => out(r));
			},
			async count({ model, where }) {
				return table(model).filter((r) => matchWhere(r, where ?? [])).length;
			},
			async update({ model, where, update }) {
				const row = table(model).find((r) => matchWhere(r, where));
				if (!row) return null;
				Object.assign(row, update);
				return out(row);
			},
			async updateMany({ model, where, update }) {
				const rows = table(model).filter((r) => matchWhere(r, where));
				for (const r of rows) Object.assign(r, update);
				return rows.length;
			},
			async delete({ model, where }) {
				const t = table(model);
				const i = t.findIndex((r) => matchWhere(r, where));
				if (i !== -1) t.splice(i, 1);
			},
			async deleteMany({ model, where }) {
				const t = table(model);
				let n = 0;
				for (let i = t.length - 1; i >= 0; i--) {
					const r = t[i];
					if (r && matchWhere(r, where)) {
						t.splice(i, 1);
						n++;
					}
				}
				return n;
			},
			async consumeOne({ model, where }) {
				// Single-threaded JS → the find+splice is atomic; concurrent callers can't double-consume.
				const t = table(model);
				const i = t.findIndex((r) => matchWhere(r, where));
				if (i === -1) return null;
				const removed = t.splice(i, 1)[0];
				return removed ? out(removed) : null;
			},
			async transaction(fn) {
				const previous = transactionQueue;
				let release = () => {};
				transactionQueue = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
				const snapshot = new Map<string, Record<string, unknown>[]>(
					[...state.entries()].map(([model, rows]) => [
						model,
						rows.map((row) => ({ ...row })),
					]),
				);
				try {
					const result = await fn(make(snapshot));
					state.clear();
					for (const [model, rows] of snapshot) state.set(model, rows);
					return result;
				} finally {
					release();
				}
			},
		};
	};

	return make(db);
}
