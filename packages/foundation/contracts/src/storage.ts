/**
 * The storage protocol — what an adapter IS: generic CRUD over named models, the Where shape, and
 * the declarative table-schema format plugins register through their `schema` slot. Pure types;
 * the implementations (schemaAdapter, memoryAdapter, the ORM adapters) live in @busyclaw/storage-*.
 *
 * The `Adapter` CRUD shape (including the atomic `consumeOne` single-use primitive), the `Where`
 * shape, and the declarative table-schema format are based on Better Auth's database adapter:
 *   https://github.com/better-auth/better-auth — `packages/core/src/db` (`DBAdapter`) and its
 *   plugin schema files (`packages/better-auth/src/plugins/<name>/schema.ts`).
 * busyclaw's port is a leaner subset (no field-mapping / multi-id machinery). MIT, © 2024-present
 * Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

export type WhereOperator =
	| "eq"
	| "ne"
	| "lt"
	| "lte"
	| "gt"
	| "gte"
	| "in"
	| "not_in"
	| "contains"
	| "starts_with"
	| "ends_with";

/**
 * One predicate against a column. Empty-list semantics are fixed across adapters:
 * `in []` matches nothing, `not_in []` matches everything.
 *
 * NULL COMPARISON IS SQL'S, and it is fixed here rather than left to each adapter, because it was
 * left to each adapter and they answered differently: `ne` against a null column excluded the row on
 * kysely/drizzle/prisma and INCLUDED it on mongo and the memory adapter. Code written against one
 * pair silently did the other thing on the other. The rules:
 *
 *   - `value: null` is the NULL TEST, not a comparison. `eq null` matches a column that is null, and
 *     a column that was never written is the same state (the memory adapter's absent key, mongo's
 *     missing field). `ne null` matches a column that has any value. No other operator accepts
 *     `null` — an adapter throws rather than inventing a meaning for `lt null`.
 *   - EVERY OTHER OPERATOR EXCLUDES A NULL ROW. A null is not equal to `x`, and it is not unequal to
 *     `x` either; both comparisons are unknown, and a row is returned only when its predicate is
 *     TRUE. So `ne "x"`, `not_in ["x"]`, `contains "x"` and the ordering operators all skip a row
 *     whose column is null. This is the one that surprises people: filtering for "not x" does not
 *     return the rows that have no value at all. Ask for those explicitly with an `or` group and an
 *     `eq null`.
 *   - `not_in []` still matches EVERYTHING, null rows included. It is a constant, not a comparison —
 *     the empty-list rule above wins, and an adapter emits `1 = 1` rather than a real `NOT IN`.
 *
 * SQL's reading is the one adopted because three of the five backends are SQL and cannot be talked
 * out of it: making them match mongo would mean rewriting every `ne` as `(col <> v OR col IS NULL)`,
 * which changes which index the planner picks and reads as a lie to anyone who opens the query log.
 * The two backends that CAN be moved were moved.
 */
export type WhereClause = {
	field: string;
	// `boolean[]` belongs here for the same reason `boolean` does: a declared boolean column is
	// filterable with `in`, and leaving the list form out made the scalar case expressible and the
	// list case a type error — which is a distinction the storage layer does not actually have.
	value:
		| string
		| number
		| boolean
		| string[]
		| number[]
		| boolean[]
		| Date
		| null;
	/** Default "eq". */
	operator?: WhereOperator;
	/** How this node joins the previous SIBLING (left-fold). Default "AND". */
	connector?: "AND" | "OR";
	/**
	 * Case sensitivity for string comparisons — applies to `eq`/`ne` and the pattern operators
	 * (`contains`/`starts_with`/`ends_with`) when the value is a string.
	 *
	 * WHAT IS GUARANTEED: `mode: "insensitive"` matches regardless of case FOR ASCII, on every
	 * backend. An adapter that cannot express it on its connector REFUSES — it never quietly answers
	 * the case-sensitive question instead.
	 *
	 * WHAT IS NOT, and cannot be:
	 *   - THE DEFAULT. `"sensitive"` is the default in the sense that nothing is added to the query,
	 *     and on a SQL backend what you then get is the COLUMN'S COLLATION. SQLite's LIKE is
	 *     ASCII-case-insensitive unless the host sets `PRAGMA case_sensitive_like`; MySQL's default
	 *     `utf8mb4_0900_ai_ci` is case- and accent-insensitive; Postgres is sensitive. A comparison
	 *     that must be sensitive has to say so with a collation on the column — an adapter that forced
	 *     it per-query would fold both sides of every default `contains` and throw away the index the
	 *     query exists to use.
	 *   - NON-ASCII FOLDING under `"insensitive"`. SQL backends fold with `lower()`, which is
	 *     ASCII-only on SQLite and ICU-aware on Postgres; the memory adapter uses JS `toLowerCase()`
	 *     (full Unicode) and mongo a Unicode-aware regex. So `Ä` and `ä` compare equal on some
	 *     deployments and not others, and no adapter-side rewrite fixes that without the same
	 *     index-destroying cost.
	 *
	 * The practical reading: `mode` is for ASCII case-folding, which is what nearly every caller means.
	 * Anything stricter belongs in the schema, as a collation.
	 */
	mode?: "sensitive" | "insensitive";
};

/**
 * A parenthesized subgroup — the members combine by the group's own combinator, and the group
 * joins its previous sibling by `connector` like any clause. Groups nest, so shapes the flat
 * left-fold cannot express become writable — the shareable-resource union
 * `(scope = 'personal' AND scopeId = me) OR (scope = 'organization' AND scopeId = org)`,
 * or keyset pagination `(createdAt > c) OR (createdAt = c AND id > i)` (with a matching
 * multi-column `sortBy`). An EMPTY group is a caller bug and fails loud at the adapter.
 */
export type WhereGroup =
	| { and: Where[]; or?: never; connector?: "AND" | "OR" }
	| { or: Where[]; and?: never; connector?: "AND" | "OR" };

/** One node of a where tree. A `Where[]` combines left-to-right by each node's `connector`. */
export type Where = WhereClause | WhereGroup;

/** Discriminate a where node — a group has `and`/`or` members instead of a `field`. */
export function isWhereGroup(node: Where): node is WhereGroup {
	return !("field" in node);
}

export type SortBy = { field: string; direction: "asc" | "desc" };

/** Normalize the `sortBy` input (one column or several) to a list. */
export function sortByList(
	sortBy: SortBy | readonly SortBy[] | undefined,
): SortBy[] {
	if (sortBy === undefined) return [];
	return Array.isArray(sortBy) ? [...sortBy] : [sortBy as SortBy];
}

/**
 * The storage substrate: generic CRUD over named models. An ORM adapter implements this; the
 * memory adapter in @busyclaw/storage-core is the zero-dep default. `consumeOne` is the race-safe
 * single-use primitive.
 *
 * Reads return `unknown` — honestly: an adapter hands back whatever the database holds, and the
 * port does not pretend otherwise. Row typing + validation live one layer up, in the entity layer
 * (`entityDb`/`entityView` in @busyclaw/storage-core), where the model name drives the type and
 * every row is PARSED against its record schema — the caller-asserted `findOne<T>` generic this
 * port used to carry (better-auth's `DBAdapter` shape) let the type parameter and the model string
 * drift apart, unchecked. The declarative `SchemaDeclaration` below is for migrations (the
 * `generate` CLI), not for typing these methods.
 */
export type Adapter = {
	/** Adapter id, e.g. "memory" / "drizzle" — for diagnostics. */
	id: string;
	/**
	 * Check that the database can actually enforce what the declaration requires, and REFUSE if it
	 * cannot. Optional: an adapter whose backend enforces constraints as part of migrating has nothing
	 * to verify, and omitting this is the same as passing.
	 *
	 * It exists for the backend where "the schema was applied" is an assumption rather than a fact.
	 * Mongo has no DDL and no migrator — the index script is a document someone is trusted to have
	 * run, and a collection missing a unique index does not fail, it accepts the duplicate. Every
	 * lookup-then-create upsert in busyclaw treats the database's rejection as its retry signal, so a
	 * silently unconstrained collection does not error, it accumulates duplicates.
	 *
	 * The ASSEMBLY calls this, not the caller who built the adapter, and that is the point: the
	 * assembly holds the merged declaration — core models plus every plugin and host extension — while
	 * whoever constructed the adapter knows only the base. A check run against the wrong schema is a
	 * check that passes for the wrong reason.
	 */
	verifySchema?: (schema: SchemaDeclaration) => Promise<void>;
	create: (data: {
		model: string;
		data: Record<string, unknown>;
		select?: string[];
	}) => Promise<unknown>;
	findOne: (data: {
		model: string;
		where: Where[];
		select?: string[];
	}) => Promise<unknown>;
	findMany: (data: {
		model: string;
		where?: Where[];
		limit?: number;
		offset?: number;
		sortBy?: SortBy | readonly SortBy[];
		select?: string[];
	}) => Promise<unknown[]>;
	count: (data: { model: string; where?: Where[] }) => Promise<number>;
	/**
	 * Update ONE matching row and return it — or `null` when the `where` matched nothing.
	 *
	 * THAT RETURN IS A CONTRACT, not an implementation detail, and it is what makes this the
	 * compare-and-swap primitive. Put the expected state in the `where` (`{id}` AND
	 * `{status: "waiting"}`) and exactly one concurrent caller gets a row back; every other one gets
	 * `null` and knows it lost. Several mechanisms are built on precisely that — a task claim, a
	 * conditional run transition, a subagent barrier electing the single waker that resumes a parked
	 * parent. Without it they would all have to read-then-write, which is the race they exist to avoid.
	 *
	 * Written down HERE because it used to live only in adapter behaviour and one atomicity test
	 * (`packages/storage/drizzle/tests/mysql-atomicity.test.ts` — eight concurrent claims, one winner).
	 * A new adapter passing the shape tests could satisfy the types and quietly break every CAS in the
	 * repo.
	 *
	 * `updateMany`'s COUNT is not a substitute: Mongo returns `modifiedCount`, so a patch that writes
	 * an unchanged value returns 0 there and N on SQL — the same call answering "did I win" differently
	 * per backend.
	 */
	update: (data: {
		model: string;
		where: Where[];
		update: Record<string, unknown>;
	}) => Promise<unknown>;
	updateMany: (data: {
		model: string;
		where: Where[];
		update: Record<string, unknown>;
	}) => Promise<number>;
	delete: (data: { model: string; where: Where[] }) => Promise<void>;
	deleteMany: (data: { model: string; where: Where[] }) => Promise<number>;
	/**
	 * Atomically delete and return one matching row (or `null`). The race-safe primitive for
	 * consuming single-use credentials — confirmation tokens, one-time approvals. Under concurrent
	 * calls against the same row, exactly one caller gets it; the rest get `null`.
	 */
	consumeOne: (data: { model: string; where: Where[] }) => Promise<unknown>;
	/**
	 * Does the BACKEND arbitrate declared uniqueness — primary keys and `unique` columns?
	 *
	 * Absent or `true` for every real database: the engine rejects the second insert, which is what
	 * makes "try to create, treat a conflict as somebody-got-there-first" a safe way to claim something
	 * without a read two writers can both pass.
	 *
	 * `false` says the adapter needs help, and `entityAdapter` then checks before it writes. Only the
	 * in-memory adapter says this, and only there is a pre-check actually sufficient: one process, one
	 * thread, so nothing can slip between the check and the insert. On a real database the same
	 * pre-check would be false comfort — two processes would both pass it.
	 *
	 * It matters because the claim pattern is everywhere: the registry's replace-by-tuple upserts, the
	 * PII mint race, the channel delivery inbox. Against an adapter that silently accepts duplicates,
	 * every one of them degrades to "always succeeds" — and since tests run on memory, the branch that
	 * handles losing is the branch nothing exercises.
	 */
	enforcesUnique?: boolean;
	/**
	 * How this adapter's driver wants a boolean: as one, or as 0/1.
	 *
	 * Declared by the ADAPTER because only it knows. better-sqlite3 refuses to bind a JS boolean at
	 * all — "SQLite3 can only bind numbers, strings, bigints, buffers, and null" — so before this
	 * existed a `field.boolean()` column could be neither written nor filtered through kysely on
	 * SQLite, and the error came from the driver rather than from anything that knew a boolean column
	 * was involved. MySQL has the same shape (tinyint(1)); Postgres and Mongo have real booleans.
	 *
	 * Absent means `native`, so an adapter that says nothing behaves exactly as it did before. The
	 * READ side normalizes 0/1 back to a boolean whatever this says — see `schemaAdapter` for why the
	 * two directions are deliberately asymmetric.
	 */
	booleans?: "native" | "integer";
	/** Run a set of adapter operations atomically when the backing store supports transactions. */
	transaction?: <R>(fn: (tx: Adapter) => Promise<R>) => Promise<R>;
};

// ── Declarative schema (what a plugin's table looks like) — fed to the `generate` CLI ────────────

export type FieldType = "string" | "number" | "boolean" | "date" | "json";

export type FieldAttribute = {
	type: FieldType;
	required?: boolean;
	/**
	 * This column is part of the table's PRIMARY KEY. MIGRATION-ONLY metadata, like `pii` and
	 * `retention` — adapters neither read nor enforce it; the database does.
	 *
	 * Marking SEVERAL fields in one table is how a COMPOSITE key is declared, and the key's column
	 * order is their declaration order. That is deliberate rather than a one-per-table rule: not
	 * every busyclaw table is keyed by a synthetic `id`, and a key that can only be single-column
	 * would have to be expressed somewhere other than the field it belongs to.
	 *
	 * A primary key already implies uniqueness and an index, so `unique`/`index` beside it are
	 * redundant — the emitter drops them rather than writing a second constraint over the same
	 * columns. Every primary-key column is NOT NULL by definition, so a nullable field cannot carry
	 * this flag (SQL forbids it, and the emitter refuses it rather than emitting invalid DDL).
	 */
	primaryKey?: boolean;
	/** This column alone is unique. For a constraint over SEVERAL columns see {@link TableSchema.uniques}
	 *  — composition is a property of the table, not something a column flag can carry. */
	unique?: boolean;
	index?: boolean;
	references?: { model: string; field: string };
	fieldName?: string;
	input?: boolean;
	returned?: boolean;
	/** Set once at create, never changed by an update — the update path rejects writes to it. */
	immutable?: boolean;
	pii?: "none" | "possible" | "contains" | "redacted";
	retention?: "default" | "ephemeral" | "audit" | "until-erasure";
	defaultValue?: unknown | (() => unknown);
	onUpdate?: () => unknown;
};

export type TableSchema = {
	modelName?: string;
	fields: Record<string, FieldAttribute>;
	/**
	 * Composite unique constraints, each a list of FIELD KEYS in constraint order.
	 *
	 * Declared on the table because that is what they belong to. A column flag cannot express one
	 * without lying about scope — and `unique: true` already means "this column alone", which every
	 * existing declaration depends on, so overloading it would silently merge unrelated constraints.
	 * Drizzle draws the same line: single-column uniqueness rides the column, composites sit beside
	 * the table.
	 *
	 * ```ts
	 * entity("invite", inviteFields, { uniques: [["orgId", "email"]] })
	 * ```
	 *
	 * Pick the columns that identify the THING, not the ones that identify the row. A constraint over
	 * columns already covered by the primary key restates it and enforces nothing new — and if the
	 * race you are closing is two writers minting a row for the same underlying value, the generated
	 * ids differ by construction, so a constraint naming them can never see the collision. The
	 * value's own identity is what has to be in the tuple.
	 *
	 * MIGRATION metadata, like {@link FieldAttribute.primaryKey}: the database enforces it, adapters
	 * do not. Nothing here turns a violation into a typed conflict — each driver still spells that
	 * error its own way (Postgres 23505, SQLite SQLITE_CONSTRAINT_UNIQUE, Prisma P2002, Drizzle
	 * passing the driver's through). Declaring the constraint is the easy half.
	 */
	uniques?: readonly (readonly string[])[];
};

/** A plugin declares the tables it needs: `{ audit: { fields: { … } } } satisfies SchemaDeclaration`. */
export type SchemaDeclaration = Record<string, TableSchema>;

/** One composite unique constraint, resolved to physical column names and a stable name. */
export type UniqueConstraint = { name: string; columns: string[] };

/**
 * A table's composite unique constraints, resolved for an emitter: field keys mapped through
 * `fieldName`, plus a derived constraint name. Single-column `unique: true` is NOT here — that one
 * is a per-column concern each emitter handles inline.
 *
 * Shared for the same reason {@link tableOrder} is: three emitters must agree on which columns form
 * which constraint, and deriving it separately is how they stop agreeing. A field key that does not
 * exist throws — a constraint over a column that was renamed or removed is a schema bug, and it
 * would otherwise surface as DDL the database rejects.
 */
export function uniqueConstraints(
	model: string,
	table: TableSchema,
): UniqueConstraint[] {
	const physical = table.modelName ?? model;
	return (table.uniques ?? []).map((keys) => {
		if (keys.length === 0) {
			throw new Error(`${model}: a unique constraint names no columns`);
		}
		const columns = keys.map((key) => {
			const field = table.fields[key];
			if (field === undefined) {
				throw new Error(
					`${model}: unique constraint names "${key}", which is not a field on this table`,
				);
			}
			return field.fieldName ?? key;
		});
		return { name: `${physical}_${columns.join("_")}_uq`, columns };
	});
}

/**
 * Tables ordered so a referenced table always precedes the table referencing it.
 *
 * Here, beside {@link isWhereGroup} and {@link sortByList}, for the same reason those are: a pure
 * function over a type this module owns, needed by EVERY storage adapter that emits a schema. SQL
 * must create a table before one that references it; a Drizzle schema names an earlier `const`; a
 * Prisma relation needs its target declared. Deriving the order from the declared `references`
 * keeps it from drifting the way a hand-maintained ordering number would.
 *
 * A reference cycle throws rather than deadlocking — it is a schema bug, and a silent partial order
 * would surface later as an unresolvable foreign key.
 */
export function tableOrder(schema: SchemaDeclaration): string[] {
	const models = Object.keys(schema);
	const known = new Set(models);
	const ordered: string[] = [];
	const state = new Map<string, "visiting" | "done">();

	const visit = (model: string, trail: readonly string[]): void => {
		const current = state.get(model);
		if (current === "done") return;
		if (current === "visiting") {
			throw new Error(
				`circular table references: ${[...trail, model].join(" → ")}`,
			);
		}
		state.set(model, "visiting");
		const table = schema[model];
		for (const field of Object.values(table?.fields ?? {})) {
			const target = field.references?.model;
			// A reference to a table outside this declaration (a host's own) is left to the host —
			// we cannot order what we were not given.
			if (target !== undefined && target !== model && known.has(target)) {
				visit(target, [...trail, model]);
			}
		}
		state.set(model, "done");
		ordered.push(model);
	};

	for (const model of models) visit(model, []);
	return ordered;
}
