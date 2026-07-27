/**
 * SchemaDeclaration → SQL, over Kysely's schema builder.
 *
 * This is the engine behind `@busyclaw/cli`'s `generate` / `migrate`. It lives here, next to the
 * Kysely adapter, because DDL is dialect work and this package already owns that dependency — and
 * because it takes a plain {@link SchemaDeclaration}, so nothing in storage has to import the
 * assembly to know what tables exist. The CLI supplies the declaration; this file turns it into
 * statements.
 *
 * Modeled on Better Auth's `getMigrations` (packages/better-auth/src/db/get-migration.ts) — the
 * introspect-diff-create shape, the two-type-map split, and the warn-never-alter rule are theirs.
 * MIT, © 2024-present Bereket Engida. See THIRD_PARTY_NOTICES.md. What differs is busyclaw's:
 * primary keys are DECLARED (`field.primaryKey`, possibly composite) rather than an implicit `id`
 * column, because not every busyclaw table is keyed by a synthetic id.
 *
 * Three rules make this safe to run against a live database:
 *   1. It only ever ADDS. Missing tables are created, missing columns are added; nothing is
 *      dropped, renamed, or retyped.
 *   2. A column whose type has drifted is WARNED about, never altered — silently rewriting a live
 *      column's type is how data disappears.
 *   3. It is idempotent. Running twice produces an empty plan the second time, so it is safe in a
 *      deploy step.
 */

import type {
	FieldAttribute,
	FieldType,
	SchemaDeclaration,
	TableSchema,
} from "@busyclaw/contracts";
import {
	configurationError,
	tableOrder,
	uniqueConstraints,
} from "@busyclaw/contracts";
import type {
	AlterTableColumnAlteringBuilder,
	ColumnDataType,
	CreateIndexBuilder,
	CreateTableBuilder,
	Kysely,
} from "kysely";

/** The dialects this emitter writes DDL for. */
export type MigrationDialect = "postgres" | "sqlite";

/**
 * The LOOSE map: which existing column types count as "already correct" for a declared field type.
 * Deliberately generous — an existing `varchar(255)` is a perfectly good `string`, and demanding an
 * exact match would make every hand-made or third-party-migrated column look like drift.
 */
const ACCEPTED: Record<
	MigrationDialect,
	Record<FieldType, readonly string[]>
> = {
	postgres: {
		string: ["character varying", "varchar", "text", "uuid", "char"],
		number: [
			"int2",
			"int4",
			"int8",
			"integer",
			"bigint",
			"smallint",
			"numeric",
			"real",
			"double precision",
		],
		boolean: ["bool", "boolean"],
		date: ["timestamptz", "timestamp", "timestamp with time zone", "date"],
		// NOT json/jsonb — see EMITTED below. A native JSON column here is genuine drift: the
		// adapter would get a parsed object back and refuse it, so reporting it is the point.
		json: ["text", "character varying", "varchar"],
	},
	sqlite: {
		string: ["text"],
		number: ["integer", "real", "numeric"],
		boolean: ["integer", "boolean"],
		date: ["date", "text", "integer"],
		json: ["text"],
	},
};

/** The EXACT map: what a column of this declared type is CREATED as. */
const EMITTED: Record<MigrationDialect, Record<FieldType, ColumnDataType>> = {
	postgres: {
		string: "text",
		number: "double precision",
		boolean: "boolean",
		date: "timestamptz",
		// TEXT, deliberately, not jsonb. busyclaw's storage layer serializes a `json` field itself
		// (schema-adapter's `json: "string"` mode, which is what createClaw uses) and demands the
		// serialized string back on read. A jsonb column makes `pg` return a parsed object, and
		// decoding then throws — the column type has to match who owns the serialization.
		json: "text",
	},
	sqlite: {
		string: "text",
		number: "real",
		boolean: "integer",
		date: "text",
		json: "text",
	},
};

/** Normalize `character varying(255)` → `character varying` before comparing. */
function normalizeType(dataType: string): string {
	return (dataType.toLowerCase().split("(")[0] ?? "").trim();
}

function typeMatches(
	columnDataType: string,
	fieldType: FieldType,
	dialect: MigrationDialect,
): boolean {
	return ACCEPTED[dialect][fieldType].includes(normalizeType(columnDataType));
}

/** The physical column name — `fieldName` overrides the declaration key. */
function columnOf(name: string, field: FieldAttribute): string {
	return field.fieldName ?? name;
}

/** The physical table name — `modelName` overrides the declaration key. */
function tableOf(model: string, table: TableSchema): string {
	return table.modelName ?? model;
}

/** The declared primary-key columns, in declaration order. Empty when the table declares none. */
function primaryKeyColumns(table: TableSchema): string[] {
	return Object.entries(table.fields)
		.filter(([, field]) => field.primaryKey === true)
		.map(([name, field]) => columnOf(name, field));
}

/** One planned table creation. */
export type PlannedTable = { model: string; table: string; columns: string[] };
/** One planned column addition to an existing table. */
export type PlannedColumns = {
	model: string;
	table: string;
	columns: string[];
};

export type MigrationPlan = {
	/** Tables that do not exist yet, in reference order. */
	toBeCreated: PlannedTable[];
	/** Columns missing from tables that DO exist. */
	toBeAdded: PlannedColumns[];
	/** Columns whose live type does not match the declaration — reported, never changed. */
	drift: {
		model: string;
		table: string;
		column: string;
		declared: FieldType;
		actual: string;
	}[];
	/** Execute the plan against the database. */
	runMigrations: () => Promise<void>;
	/** The plan as SQL text, for `generate` / review / checking into a repo. */
	compileMigrations: () => string;
	/** Nothing to do — the database already matches the declaration. */
	isEmpty: boolean;
};

/** The same open row type the adapter uses — DDL is written against names, not a typed schema. */
type MigrationDb = Kysely<Record<string, Record<string, unknown>>>;

export type MigrationPlanOptions = {
	db: MigrationDb;
	schema: SchemaDeclaration;
	dialect: MigrationDialect;
	/**
	 * Where type drift and other non-fatal findings go. REQUIRED, and deliberately so: this module
	 * is a library, and the findings it reports (a column whose type has drifted, a table created
	 * without a primary key) are exactly the things a caller must not be able to miss by accident.
	 * A default that swallowed them would make silence ambiguous.
	 */
	warn: (message: string) => void;
};

/**
 * Diff a {@link SchemaDeclaration} against the live database and return the additive plan that
 * reconciles them. Nothing is executed until `runMigrations()` is called.
 */
export async function planMigrations(
	options: MigrationPlanOptions,
): Promise<MigrationPlan> {
	const { db, schema, dialect, warn } = options;

	const live = await db.introspection.getTables();
	const liveByName = new Map(live.map((table) => [table.name, table]));

	const toBeCreated: PlannedTable[] = [];
	const toBeAdded: PlannedColumns[] = [];
	const drift: MigrationPlan["drift"] = [];

	type Statement =
		| AlterTableColumnAlteringBuilder
		| CreateTableBuilder<string, string>
		| CreateIndexBuilder;
	const statements: Statement[] = [];
	// Indexes go last: every column and table they name must already exist.
	const deferredIndexes: CreateIndexBuilder[] = [];

	const addIndex = (table: string, column: string, unique: boolean): void => {
		const builder = db.schema
			.createIndex(`${table}_${column}_${unique ? "uidx" : "idx"}`)
			.on(table)
			.columns([column]);
		deferredIndexes.push(unique ? builder.unique() : builder);
	};

	for (const model of tableOrder(schema)) {
		const declared = schema[model];
		if (declared === undefined) continue;
		const table = tableOf(model, declared);
		const keyColumns = primaryKeyColumns(declared);

		// A primary key column must be NOT NULL. Catching it here — where the declaration is in
		// hand — beats letting the database reject the DDL with no idea which field is at fault.
		for (const [name, field] of Object.entries(declared.fields)) {
			if (field.primaryKey === true && field.required !== true) {
				throw configurationError(
					`"${model}.${name}" is declared primaryKey but not required — a primary key column cannot be nullable`,
					{ field: name, model },
				);
			}
		}

		const existing = liveByName.get(table);

		if (existing === undefined) {
			let create = db.schema.createTable(table);
			for (const [name, field] of Object.entries(declared.fields)) {
				const column = columnOf(name, field);
				create = create.addColumn(
					column,
					EMITTED[dialect][field.type],
					(col) => {
						let built = col;
						const isKey = keyColumns.includes(column);
						// NOT NULL is emitted on key columns too, even though standard SQL says a
						// PRIMARY KEY already implies it. SQLite does NOT honour that rule — a
						// documented legacy quirk lets a PK column hold NULL unless it is INTEGER
						// PRIMARY KEY or the table is WITHOUT ROWID. So this is redundant in
						// Postgres and load-bearing in SQLite.
						if (field.required === true || isKey) built = built.notNull();
						// Uniqueness, on the other hand, IS genuinely implied by the key in both —
						// a second constraint over the same columns would just be a second index.
						if (field.unique === true && !isKey) built = built.unique();
						if (field.references !== undefined) {
							const target = schema[field.references.model];
							const targetTable =
								target === undefined
									? field.references.model
									: tableOf(field.references.model, target);
							built = built.references(
								`${targetTable}.${field.references.field}`,
							);
						}
						return built;
					},
				);
				if (field.index === true && !keyColumns.includes(column)) {
					addIndex(table, column, field.unique === true);
				}
			}
			if (keyColumns.length > 0) {
				// Variance-only cast: Kysely infers the column-name union from the table's typed
				// schema, and a table named by a runtime string has none — so the parameter narrows
				// to `never[]`. The names are the declaration's own, already emitted as columns above.
				create = create.addPrimaryKeyConstraint(
					`${table}_pk`,
					keyColumns as never[],
				);
			} else {
				warn(
					`busyclaw migrations: table "${table}" declares no primaryKey field — created without a primary key`,
				);
			}
			// Named composite-unique groups, as real table constraints. A constraint rather than a
			// unique INDEX because that is what a driver reports as a conflict — the thing a caller
			// doing try-insert/on-conflict has to catch.
			for (const constraint of uniqueConstraints(model, declared)) {
				create = create.addUniqueConstraint(
					constraint.name,
					constraint.columns as never[],
				);
			}
			statements.push(create);
			toBeCreated.push({
				model,
				table,
				columns: Object.entries(declared.fields).map(([name, field]) =>
					columnOf(name, field),
				),
			});
			continue;
		}

		// The table exists: add only the columns it is missing, and report drift on the rest.
		const liveColumns = new Map(
			existing.columns.map((column) => [column.name, column]),
		);
		const missing: string[] = [];
		for (const [name, field] of Object.entries(declared.fields)) {
			const column = columnOf(name, field);
			const liveColumn = liveColumns.get(column);
			if (liveColumn === undefined) {
				missing.push(column);
				const alter = db.schema
					.alterTable(table)
					.addColumn(column, EMITTED[dialect][field.type], (col) => {
						let built = col;
						// A column added to a populated table cannot be NOT NULL without a default —
						// existing rows would violate it instantly. Added columns are nullable; the
						// declaration's `required` is still enforced by the entity validators on write.
						if (field.unique === true) built = built.unique();
						if (field.references !== undefined) {
							const target = schema[field.references.model];
							const targetTable =
								target === undefined
									? field.references.model
									: tableOf(field.references.model, target);
							built = built.references(
								`${targetTable}.${field.references.field}`,
							);
						}
						return built;
					});
				if (field.required === true) {
					warn(
						`busyclaw migrations: "${table}.${column}" is declared required but is being ADDED to an existing table — it will be nullable in the database (existing rows have no value for it)`,
					);
				}
				statements.push(alter);
				if (field.index === true)
					addIndex(table, column, field.unique === true);
				continue;
			}
			if (!typeMatches(liveColumn.dataType, field.type, dialect)) {
				drift.push({
					model,
					table,
					column,
					declared: field.type,
					actual: liveColumn.dataType,
				});
				warn(
					`busyclaw migrations: "${table}.${column}" is "${liveColumn.dataType}" in the database but declared "${field.type}" — NOT changed automatically`,
				);
			}
		}
		if (missing.length > 0) toBeAdded.push({ model, table, columns: missing });
	}

	statements.push(...deferredIndexes);

	return {
		toBeCreated,
		toBeAdded,
		drift,
		isEmpty: statements.length === 0,
		runMigrations: async () => {
			for (const statement of statements) await statement.execute();
		},
		compileMigrations: () =>
			statements.length === 0
				? ""
				: `${statements.map((statement) => statement.compile().sql).join(";\n\n")};\n`,
	};
}
