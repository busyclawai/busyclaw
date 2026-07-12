/**
 * @euroclaw/storage-kysely — the @euroclaw/storage-core Adapter port over a Kysely query builder.
 *
 * `kyselyAdapter` takes either a ready Kysely instance OR a raw driver/pool you already have
 * (a better-sqlite3 `Database`, a `pg` `Pool`, a Kysely `Dialect`, or `{ dialect|db, type }`). Raw
 * inputs are duck-typed and wrapped in Kysely — the same convenience as Better Auth's pool path
 * (`packages/kysely-adapter/src/dialect.ts`: `createKyselyAdapter` / `getKyselyDatabaseType`), so
 * a single Kysely-backed adapter covers every SQL driver. SQLite + Postgres today; a MySQL/MSSQL
 * input is rejected up front (create/update rely on RETURNING, which those lack).
 *
 * Modeled on Better Auth's Kysely adapter: https://github.com/better-auth/better-auth —
 * `packages/kysely-adapter`. The CRUD/where translation here is euroclaw's own, written against
 * Kysely's public API. MIT, © 2024-present Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import type {
	Adapter,
	Where,
	WhereClause,
	WhereOperator,
} from "@euroclaw/contracts";
import {
	configurationError,
	isWhereGroup,
	sortByList,
	unsupportedOperationError,
} from "@euroclaw/contracts";
import {
	type Dialect,
	type Expression,
	Kysely,
	PostgresDialect,
	type PostgresPool,
	type SqliteDatabase,
	SqliteDialect,
	sql,
} from "kysely";

const SQL_OP: Record<
	Exclude<
		WhereOperator,
		"in" | "not_in" | "contains" | "starts_with" | "ends_with"
	>,
	string
> = {
	eq: "=",
	ne: "!=",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
};

/** Escape LIKE wildcards in a user value; every LIKE below declares ESCAPE '\\' (sqlite has no
 *  default escape character, so it must be explicit to be portable). */
const escapeLike = (value: string): string =>
	value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** One clause → a raw SQL boolean expression. `mode: "insensitive"` folds both sides through
 *  lower() (portable across sqlite/postgres; non-ASCII semantics follow the database collation). */
function clauseExpr(w: WhereClause): Expression<boolean> {
	const col = sql.ref(w.field);
	const op = w.operator ?? "eq";
	const insensitive = w.mode === "insensitive" && typeof w.value === "string";
	if (w.value === null) {
		if (op === "eq") return sql<boolean>`${col} is null`;
		if (op === "ne") return sql<boolean>`${col} is not null`;
		throw configurationError(
			`@euroclaw/storage-kysely: where operator "${op}" cannot compare null`,
			{ field: w.field, operator: op },
		);
	}
	if (op === "in" || op === "not_in") {
		const values = w.value as unknown[];
		// Fixed empty-list semantics: `in []` matches nothing, `not_in []` matches everything —
		// SQL's `IN ()` is a syntax error, so emit the constant.
		if (values.length === 0)
			return op === "in" ? sql<boolean>`1 = 0` : sql<boolean>`1 = 1`;
		const list = values.map((v) => sql`${v}`);
		return op === "in"
			? sql<boolean>`${col} in (${sql.join(list)})`
			: sql<boolean>`${col} not in (${sql.join(list)})`;
	}
	if (op === "contains" || op === "starts_with" || op === "ends_with") {
		const escaped = escapeLike(String(w.value));
		const pattern =
			op === "contains"
				? `%${escaped}%`
				: op === "starts_with"
					? `${escaped}%`
					: `%${escaped}`;
		return insensitive
			? sql<boolean>`lower(${col}) like lower(${pattern}) escape '\\'`
			: sql<boolean>`${col} like ${pattern} escape '\\'`;
	}
	if (insensitive && (op === "eq" || op === "ne")) {
		return sql<boolean>`lower(${col}) ${sql.raw(SQL_OP[op])} lower(${w.value})`;
	}
	return sql<boolean>`${col} ${sql.raw(SQL_OP[op])} ${w.value}`;
}

/** A raw SQL boolean expression from a where tree: left-fold by each node's connector; a group
 *  parenthesizes its members under its own combinator. An empty group fails loud. */
function whereExpr(where: Where[]): Expression<boolean> | undefined {
	let combined: Expression<boolean> | undefined;
	for (const w of where) {
		let clause: Expression<boolean>;
		if (isWhereGroup(w)) {
			const members = "and" in w && w.and !== undefined ? w.and : (w.or ?? []);
			const joiner = "and" in w && w.and !== undefined ? " and " : " or ";
			const inner = members.map((member) => whereExpr([member]));
			if (inner.length === 0 || inner.some((e) => e === undefined)) {
				throw configurationError(
					"@euroclaw/storage-kysely: where group is empty",
					{},
				);
			}
			clause = sql<boolean>`(${sql.join(inner as Expression<boolean>[], sql.raw(joiner))})`;
		} else {
			clause = clauseExpr(w);
		}
		combined =
			combined === undefined
				? clause
				: w.connector === "OR"
					? sql<boolean>`(${combined} or ${clause})`
					: sql<boolean>`(${combined} and ${clause})`;
	}
	return combined;
}

// ── Accepting a raw pool/dialect (the "bring the DB you already have" convenience) ───────────────

/** The SQL dialects this adapter targets. mysql/mssql are declared for the object forms but rejected. */
export type KyselyDatabaseType = "sqlite" | "postgres" | "mysql" | "mssql";

type DB = Record<string, Record<string, unknown>>;

/**
 * What `kyselyAdapter` accepts: a ready Kysely instance, a raw Kysely `Dialect`, a raw driver (a
 * better-sqlite3 `Database` or a `pg` `Pool`), or an explicit `{ dialect, type }` / `{ db, type }`.
 * Raw drivers are duck-typed and wrapped in Kysely — same trick as Better Auth's `dialect.ts`.
 */
export type KyselyDatabase =
	| Kysely<DB>
	| Dialect
	| SqliteDatabase
	| PostgresPool
	| { dialect: Dialect; type: KyselyDatabaseType }
	| { db: Kysely<DB>; type: KyselyDatabaseType };

function assertSupported(type: KyselyDatabaseType): void {
	if (type === "mysql" || type === "mssql") {
		throw unsupportedOperationError(
			`@euroclaw/storage-kysely: ${type} isn't supported yet — create()/update() rely on RETURNING. Use sqlite or postgres.`,
			{ databaseType: type },
		);
	}
}

/**
 * Normalize any accepted input to a Kysely instance, building the dialect from a raw driver by
 * duck-typing (a Kysely instance has `selectFrom`; a `Dialect` has `createDriver`; better-sqlite3
 * has `aggregate`; a `pg`/mysql2 pool has `connect`/`getConnection`). Order matters.
 */
function toKysely(database: KyselyDatabase): Kysely<DB> {
	const probe = database as Record<string, unknown>;
	// Already a Kysely instance — use it directly.
	if ("selectFrom" in probe) return database as Kysely<DB>;
	// Explicit object forms carry their own `type`.
	if ("db" in probe) {
		const w = database as { db: Kysely<DB>; type: KyselyDatabaseType };
		assertSupported(w.type);
		return w.db;
	}
	if ("dialect" in probe) {
		const w = database as { dialect: Dialect; type: KyselyDatabaseType };
		assertSupported(w.type);
		return new Kysely<DB>({ dialect: w.dialect });
	}
	// A raw Kysely Dialect.
	if ("createDriver" in probe)
		return new Kysely<DB>({ dialect: database as Dialect });
	// Raw drivers.
	if ("aggregate" in probe)
		return new Kysely<DB>({
			dialect: new SqliteDialect({ database: database as SqliteDatabase }),
		});
	if ("connect" in probe)
		return new Kysely<DB>({
			dialect: new PostgresDialect({ pool: database as PostgresPool }),
		});
	// mysql2 is detectable — fail loudly rather than emit RETURNING it can't run.
	if ("getConnection" in probe) assertSupported("mysql");
	throw configurationError(
		"@euroclaw/storage-kysely: unrecognized `database` — pass a Kysely instance, a Kysely Dialect, a pg Pool, a better-sqlite3 Database, or { dialect, type } / { db, type }.",
	);
}

/**
 * Adapt Kysely — or a raw driver/pool/dialect — to the storage Adapter port. Tables/columns are
 * addressed by string. SQLite + Postgres today (a mysql2 pool is rejected: create/update use RETURNING).
 */
export function kyselyAdapter(database: KyselyDatabase): Adapter {
	const db = toKysely(database);
	const findOne = async <T>(input: {
		model: string;
		where: Where[];
	}): Promise<T | null> => {
		let q = db.selectFrom(input.model).selectAll();
		const e = whereExpr(input.where);
		if (e !== undefined) q = q.where(e);
		const row = await q.executeTakeFirst();
		return (row ?? null) as never;
	};
	return {
		id: "kysely",

		async create({ model, data }) {
			const row = await db
				.insertInto(model)
				.values(data)
				.returningAll()
				.executeTakeFirstOrThrow();
			return row as never;
		},

		async findOne({ model, where }) {
			return findOne({ model, where });
		},

		async findMany({ model, where, limit, offset, sortBy }) {
			let q = db.selectFrom(model).selectAll();
			const e = whereExpr(where ?? []);
			if (e !== undefined) q = q.where(e);
			for (const sort of sortByList(sortBy))
				q = q.orderBy(sort.field, sort.direction);
			if (limit !== undefined) q = q.limit(limit);
			if (offset) q = q.offset(offset);
			return (await q.execute()) as never;
		},

		async count({ model, where }) {
			let q = db.selectFrom(model).select(sql<number>`count(*)`.as("count"));
			const e = whereExpr(where ?? []);
			if (e !== undefined) q = q.where(e);
			const row = await q.executeTakeFirst();
			return Number((row as { count: number } | undefined)?.count ?? 0);
		},

		async update({ model, where, update }) {
			const before = await findOne<{ id?: string | number }>({ model, where });
			const id = before?.id;
			if (id === undefined || id === null) return null;
			let q = db.updateTable(model).set(update).where("id", "=", id);
			const e = whereExpr(where);
			if (e !== undefined) q = q.where(e);
			const row = await q.returningAll().executeTakeFirst();
			return (row ?? null) as never;
		},

		async updateMany({ model, where, update }) {
			let q = db.updateTable(model).set(update);
			const e = whereExpr(where);
			if (e !== undefined) q = q.where(e);
			const res = await q.executeTakeFirst();
			return Number(res?.numUpdatedRows ?? 0);
		},

		async delete({ model, where }) {
			const before = await findOne<{ id?: string | number }>({ model, where });
			const id = before?.id;
			if (id === undefined || id === null) return;
			let q = db.deleteFrom(model).where("id", "=", id);
			const e = whereExpr(where);
			if (e !== undefined) q = q.where(e);
			await q.execute();
		},

		async deleteMany({ model, where }) {
			let q = db.deleteFrom(model);
			const e = whereExpr(where);
			if (e !== undefined) q = q.where(e);
			const res = await q.executeTakeFirst();
			return Number(res?.numDeletedRows ?? 0);
		},

		// Atomic single-use: in a transaction, take one matching row then delete it by `id`. The
		// transaction serializes concurrent callers, so exactly one wins (the rest see no row).
		async consumeOne({ model, where }) {
			return db.transaction().execute(async (trx) => {
				let q = trx.selectFrom(model).selectAll();
				const e = whereExpr(where);
				if (e !== undefined) q = q.where(e);
				const row = await q.limit(1).executeTakeFirst();
				if (!row) return null;
				let deleteQuery = trx
					.deleteFrom(model)
					.where("id", "=", (row as { id: unknown }).id);
				if (e !== undefined) deleteQuery = deleteQuery.where(e);
				const res = await deleteQuery.executeTakeFirst();
				return Number(res?.numDeletedRows ?? 0) === 1 ? row : null;
			}) as never;
		},

		async transaction(fn) {
			return db
				.transaction()
				.execute((trx) => fn(kyselyAdapter(trx as unknown as Kysely<DB>)));
		},
	};
}
