/**
 * The storage protocol — what an adapter IS: generic CRUD over named models, the Where shape, and
 * the declarative table-schema format plugins register through their `schema` slot. Pure types;
 * the implementations (schemaAdapter, memoryAdapter, the ORM adapters) live in @euroclaw/storage-*.
 *
 * The `Adapter` CRUD shape (including the atomic `consumeOne` single-use primitive), the `Where`
 * shape, and the declarative table-schema format are based on Better Auth's database adapter:
 *   https://github.com/better-auth/better-auth — `packages/core/src/db` (`DBAdapter`) and its
 *   plugin schema files (`packages/better-auth/src/plugins/<name>/schema.ts`).
 * euroclaw's port is a leaner subset (no field-mapping / multi-id machinery). MIT, © 2024-present
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

/** One predicate against a column. Empty-list semantics are fixed across adapters:
 *  `in []` matches nothing, `not_in []` matches everything. */
export type WhereClause = {
	field: string;
	value: string | number | boolean | string[] | number[] | Date | null;
	/** Default "eq". */
	operator?: WhereOperator;
	/** How this node joins the previous SIBLING (left-fold). Default "AND". */
	connector?: "AND" | "OR";
	/**
	 * Case sensitivity for string comparisons — applies to `eq`/`ne` and the pattern operators
	 * (`contains`/`starts_with`/`ends_with`) when the value is a string. Default "sensitive".
	 * Portability notes: SQL backends implement "insensitive" via `lower()`, so non-ASCII semantics
	 * follow the database's collation; prisma forwards its native `mode` (connector-dependent); and
	 * the pattern operators' DEFAULT sensitivity follows the database — sqlite's LIKE is
	 * ASCII-case-insensitive unless the host sets `PRAGMA case_sensitive_like`.
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
 * memory adapter in @euroclaw/storage-core is the zero-dep default. `consumeOne` is the race-safe
 * single-use primitive.
 *
 * Reads return `unknown` — honestly: an adapter hands back whatever the database holds, and the
 * port does not pretend otherwise. Row typing + validation live one layer up, in the entity layer
 * (`entityDb`/`entityView` in @euroclaw/storage-core), where the model name drives the type and
 * every row is PARSED against its record schema — the caller-asserted `findOne<T>` generic this
 * port used to carry (better-auth's `DBAdapter` shape) let the type parameter and the model string
 * drift apart, unchecked. The declarative `SchemaDeclaration` below is for migrations (the
 * `generate` CLI), not for typing these methods.
 */
export type Adapter = {
	/** Adapter id, e.g. "memory" / "drizzle" — for diagnostics. */
	id: string;
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
	 * every euroclaw table is keyed by a synthetic `id`, and a key that can only be single-column
	 * would have to be expressed somewhere other than the field it belongs to.
	 *
	 * A primary key already implies uniqueness and an index, so `unique`/`index` beside it are
	 * redundant — the emitter drops them rather than writing a second constraint over the same
	 * columns. Every primary-key column is NOT NULL by definition, so a nullable field cannot carry
	 * this flag (SQL forbids it, and the emitter refuses it rather than emitting invalid DDL).
	 */
	primaryKey?: boolean;
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
};

/** A plugin declares the tables it needs: `{ audit: { fields: { … } } } satisfies SchemaDeclaration`. */
export type SchemaDeclaration = Record<string, TableSchema>;

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
