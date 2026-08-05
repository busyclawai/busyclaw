/**
 * @busyclaw/storage-core — the storage Adapter port, the declarative schema format, and a zero-dep
 * in-memory adapter. busyclaw's durable state is narrow — the audit log and pending approvals
 * (better-auth keeps users/orgs/roles) — but the port is the proven generic CRUD one, so any ORM
 * adapter (`@busyclaw/storage-drizzle`, `-prisma`, `-kysely`, `-mongodb`) plugs in.
 *
 * The `Adapter` CRUD shape (including the atomic `consumeOne` single-use primitive), the `Where`
 * shape, and the declarative table-schema format are based on Better Auth's database adapter:
 *   https://github.com/better-auth/better-auth — `packages/core/src/db` (`DBAdapter`) and its
 *   plugin schema files (`packages/better-auth/src/plugins/<name>/schema.ts`).
 * busyclaw's port is a leaner subset (no field-mapping / multi-id machinery). MIT, © 2024-present
 * Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import type { Adapter, SortBy, Where, WhereClause } from "@busyclaw/contracts";
import {
	configurationError,
	isWhereGroup,
	sortByList,
} from "@busyclaw/contracts";

// The storage PROTOCOL (Adapter, Where, the declarative schema format) lives in
// @busyclaw/contracts/storage — plugins type against it without depending on this package. This
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
} from "@busyclaw/contracts";
export { isWhereGroup, sortByList } from "@busyclaw/contracts";
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

/**
 * ONE LAYER of storage — the live map, or a transaction's uncommitted overlay on top of one.
 *
 * The adapter is built over this rather than over a `Map` directly, so a transaction is a layer that
 * records what it did instead of a snapshot that replaces everything at the end. That distinction is
 * the whole point: the snapshot version committed with `state.clear()` + refill, which annihilated
 * every concurrent write that landed while the body ran — including another run's heartbeat renewal,
 * which then read as a lost lease and aborted healthy work.
 */
type StorageLayer = {
	/** The effective rows for a model. A fresh array; the ROW objects are stable, so identity is a
	 *  usable handle for update/delete. */
	rows: (model: string) => Record<string, unknown>[];
	insert: (model: string, row: Record<string, unknown>) => void;
	patch: (
		model: string,
		row: Record<string, unknown>,
		update: Record<string, unknown>,
	) => void;
	remove: (model: string, row: Record<string, unknown>) => void;
};

/** A zero-dependency in-memory Adapter — the dev/test default. Rows are stored per model. */
export function memoryAdapter(): Adapter {
	const db = new Map<string, Record<string, unknown>[]>();
	const liveTable = (model: string): Record<string, unknown>[] => {
		let t = db.get(model);
		if (!t) {
			t = [];
			db.set(model, t);
		}
		return t;
	};
	const base: StorageLayer = {
		rows: (model) => liveTable(model),
		insert: (model, row) => void liveTable(model).push(row),
		patch: (_model, row, update) => void Object.assign(row, update),
		remove: (model, row) => {
			const t = liveTable(model);
			const i = t.indexOf(row);
			if (i !== -1) t.splice(i, 1);
		},
	};

	/**
	 * COPY-ON-WRITE. Reads see the parent plus this layer's own writes; writes are recorded here and
	 * applied to the parent only on commit, and only the FIELDS this layer actually touched.
	 *
	 * Field-level merge rather than whole-row, because whole-row would reintroduce the bug one scope
	 * smaller: a concurrent write to a different column of the same row would be clobbered by a
	 * transaction that never looked at that column. Two writers to the SAME field is genuinely
	 * last-write-wins, which is the honest answer for an adapter with no engine to arbitrate — and it
	 * is what `enforcesUnique: false` already says about this adapter's limits.
	 */
	const overlay = (
		parent: StorageLayer,
	): { layer: StorageLayer; commit: () => void } => {
		const added = new Map<string, Record<string, unknown>[]>();
		// parent row → the model it lives in, so commit can remove it from the right table.
		const removed = new Map<Record<string, unknown>, string>();
		// parent row → the stable working copy this layer reads and mutates.
		const working = new Map<Record<string, unknown>, Record<string, unknown>>();
		// working copy → where it came from, and which fields this layer wrote.
		const origin = new Map<
			Record<string, unknown>,
			{ model: string; row: Record<string, unknown>; touched: Set<string> }
		>();

		const addedRows = (model: string): Record<string, unknown>[] => {
			let t = added.get(model);
			if (!t) {
				t = [];
				added.set(model, t);
			}
			return t;
		};
		const workingOf = (
			model: string,
			row: Record<string, unknown>,
		): Record<string, unknown> => {
			let w = working.get(row);
			if (w === undefined) {
				w = { ...row };
				working.set(row, w);
				origin.set(w, { model, row, touched: new Set() });
			}
			return w;
		};

		const layer: StorageLayer = {
			rows: (model) => [
				...parent
					.rows(model)
					.filter((r) => !removed.has(r))
					.map((r) => workingOf(model, r)),
				...addedRows(model),
			],
			insert: (model, row) => void addedRows(model).push(row),
			patch: (_model, row, update) => {
				Object.assign(row, update);
				const from = origin.get(row);
				// No origin ⇒ this layer created the row, so there is nothing to merge later.
				if (from) for (const key of Object.keys(update)) from.touched.add(key);
			},
			remove: (model, row) => {
				const from = origin.get(row);
				if (from) {
					removed.set(from.row, from.model);
					working.delete(from.row);
					origin.delete(row);
					return;
				}
				const t = addedRows(model);
				const i = t.indexOf(row);
				if (i !== -1) t.splice(i, 1);
			},
		};

		// PATCH, then REMOVE, then INSERT. Patches first because a row this layer both edited and
		// deleted must end up deleted, and `removed` has already dropped it from `origin`. Inserts last
		// so a row created and then deleted inside the transaction never reaches the parent at all.
		const commit = (): void => {
			for (const [w, from] of origin) {
				if (from.touched.size === 0) continue;
				const update: Record<string, unknown> = {};
				for (const key of from.touched) update[key] = w[key];
				parent.patch(from.model, from.row, update);
			}
			for (const [row, model] of removed) parent.remove(model, row);
			for (const [model, rows] of added) {
				for (const row of rows) parent.insert(model, row);
			}
		};
		return { layer, commit };
	};

	const make = (state: StorageLayer): Adapter => {
		const table = (model: string): Record<string, unknown>[] =>
			state.rows(model);
		const out = (row: Record<string, unknown>): Record<string, unknown> => ({
			...row,
		});

		return {
			id: "memory",
			// This adapter is a Map of arrays: it has no engine to reject a duplicate, so it says so and
			// `entityAdapter` checks before writing. Single-process and single-threaded, which is the
			// only setting where a pre-check is genuinely sufficient rather than a race with a nicer name.
			enforcesUnique: false,

			async create({ model, data }) {
				const row = { ...data } as Record<string, unknown>;
				state.insert(model, row);
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
				state.patch(model, row, update as Record<string, unknown>);
				return out(row);
			},
			async updateMany({ model, where, update }) {
				const rows = table(model).filter((r) => matchWhere(r, where));
				for (const r of rows)
					state.patch(model, r, update as Record<string, unknown>);
				return rows.length;
			},
			async delete({ model, where }) {
				const row = table(model).find((r) => matchWhere(r, where));
				if (row) state.remove(model, row);
			},
			async deleteMany({ model, where }) {
				const rows = table(model).filter((r) => matchWhere(r, where));
				for (const r of rows) state.remove(model, r);
				return rows.length;
			},
			async consumeOne({ model, where }) {
				// Single-threaded JS → the find+remove is atomic; concurrent callers can't
				// double-consume.
				const row = table(model).find((r) => matchWhere(r, where));
				if (!row) return null;
				state.remove(model, row);
				return out(row);
			},
			/**
			 * A copy-on-write layer, committed on success and discarded on throw.
			 *
			 * NO GLOBAL MUTEX any more, and that removes a second defect with the first. Serialization
			 * was load-bearing for the snapshot version — two snapshot-and-replace transactions would
			 * each obliterate the other — but it also made a NESTED transaction deadlock: the inner call
			 * awaited a promise only its own caller could resolve, which is why `reapExpiredLeases`
			 * could not be called from inside `claimDueTask`'s transaction. An overlay over an overlay
			 * is just a savepoint, so nesting composes.
			 *
			 * What this still is NOT is isolation. Two overlays over the same base both see the base as
			 * it was when they read it, and the later commit wins per field. This adapter says so
			 * already (`enforcesUnique: false`): it is the dev/test default, and anything that turns on
			 * a real race belongs on a real database.
			 */
			async transaction(fn) {
				const { layer, commit } = overlay(state);
				const result = await fn(make(layer));
				commit();
				return result;
			},
		};
	};

	return make(base);
}

// Uniqueness-violation normalization — one typed conflict, whichever driver raised it. What makes
// try-create → on-conflict-re-read writable without knowing the backend.
export { asConflict, isUniqueViolation } from "./conflict";

export { verifiedAdapter } from "./verified-adapter";
