// SchemaDeclaration → MongoDB index specifications.
//
// Mongo has no DDL, so this generator emits something different in KIND from the other three. There
// are no tables to create — a collection springs into existence on first write — and no column types
// to declare, because documents carry their own. What a declaration still says that Mongo cannot
// infer is which fields must be UNIQUE and which are worth indexing, and those are exactly the
// things a `createIndex` call expresses.
//
// So every constraint becomes an index here:
//
//   primaryKey  → a unique index over the key columns. NOT `_id`: busyclaw rows carry their own
//                 `id` field and the adapter strips Mongo's `_id` on read, so `_id` is an unrelated
//                 ObjectId and cannot carry the declared key.
//   uniques     → a compound unique index per constraint.
//   unique      → a single-field unique index.
//   index       → a plain index.
//
// The output is a script rather than something applied directly, matching the Drizzle and Prisma
// targets: generating stays offline and needs no connection or credentials. It is safe to re-run —
// `createIndex` is idempotent for an identical specification, which is why Mongo needs no diffing
// step and no migration history.

import type { SchemaDeclaration, TableSchema } from "@busyclaw/contracts";
import { tableOrder, uniqueConstraints } from "@busyclaw/contracts";

/** One index this schema wants, resolved to what `createIndex` takes. */
export type MongoIndexSpec = {
	/** The physical collection name. */
	collection: string;
	/** Index name — stable, derived from the columns it covers. */
	name: string;
	/** Field → direction (always ascending; busyclaw declares no directional intent). */
	keys: Record<string, 1>;
	unique: boolean;
	/**
	 * Present when the index covers a column that is not `required`, restricting it to documents
	 * where those columns exist.
	 *
	 * Mongo does NOT match SQL here, and the difference is silent. Postgres and SQLite treat NULLs
	 * as DISTINCT in a unique index, so any number of rows may leave the column empty; Mongo treats
	 * a missing field as null and permits exactly ONE such document per index — the SQL Server
	 * behaviour. A plain unique index over an optional column would therefore enforce something
	 * stricter here than the same declaration means everywhere else, and would start rejecting
	 * legitimate writes the moment a second row omitted the value. Verified against a real mongod,
	 * not inferred from the docs.
	 */
	partialFilterExpression?: Record<string, { $exists: true }>;
};

const physicalColumn = (name: string, table: TableSchema): string =>
	table.fields[name]?.fieldName ?? name;

const physicalTable = (model: string, table: TableSchema): string =>
	table.modelName ?? model;

const keysOf = (columns: readonly string[]): Record<string, 1> =>
	Object.fromEntries(columns.map((column) => [column, 1 as const]));

/** The `$exists` guard an index needs to match SQL's nulls-are-distinct rule, or nothing when every
 *  covered column is required. Keyed by DECLARATION field so `required` is readable; emitted against
 *  the physical column the index actually covers. */
function existsGuard(
	table: TableSchema,
	columns: readonly string[],
): Record<string, { $exists: true }> | undefined {
	const optional = columns.filter((column) => {
		const field = Object.entries(table.fields).find(
			([name, f]) => (f.fieldName ?? name) === column,
		)?.[1];
		return field !== undefined && field.required !== true;
	});
	if (optional.length === 0) return undefined;
	return Object.fromEntries(
		optional.map((column) => [column, { $exists: true } as const]),
	);
}

/** Build a spec, adding the partial filter only when the index covers an optional column. */
function spec(
	collection: string,
	name: string,
	table: TableSchema,
	columns: readonly string[],
	unique: boolean,
): MongoIndexSpec {
	const guard = unique ? existsGuard(table, columns) : undefined;
	return {
		collection,
		name,
		keys: keysOf(columns),
		unique,
		...(guard !== undefined ? { partialFilterExpression: guard } : {}),
	};
}

/** The indexes a declaration implies, in a stable order. Pure — no database, no filesystem. */
export function mongoIndexes(schema: SchemaDeclaration): MongoIndexSpec[] {
	const specs: MongoIndexSpec[] = [];

	for (const model of tableOrder(schema)) {
		const table = schema[model];
		if (table === undefined) continue;
		const collection = physicalTable(model, table);

		// The declared primary key, as a unique index — see the header on why not `_id`.
		const keyColumns = Object.entries(table.fields)
			.filter(([, field]) => field.primaryKey === true)
			.map(([name]) => physicalColumn(name, table));
		if (keyColumns.length > 0) {
			specs.push(
				spec(
					collection,
					`${collection}_${keyColumns.join("_")}_pk`,
					table,
					keyColumns,
					true,
				),
			);
		}

		for (const constraint of uniqueConstraints(model, table)) {
			specs.push(
				spec(collection, constraint.name, table, constraint.columns, true),
			);
		}

		for (const [name, field] of Object.entries(table.fields)) {
			const column = physicalColumn(name, table);
			// A key column is already covered by the unique index above.
			if (keyColumns.includes(column)) continue;
			if (field.unique === true) {
				specs.push(
					spec(
						collection,
						`${collection}_${column}_uidx`,
						table,
						[column],
						true,
					),
				);
				continue;
			}
			if (field.index === true) {
				specs.push(
					spec(
						collection,
						`${collection}_${column}_idx`,
						table,
						[column],
						false,
					),
				);
			}
		}
	}

	return specs;
}

export type MongoGenerateOptions = { schema: SchemaDeclaration };

/** Emit an idempotent index-creation script for `mongosh`. */
export function generateMongoIndexes(options: MongoGenerateOptions): string {
	const specs = mongoIndexes(options.schema);
	const lines: string[] = [
		"// Generated by `busyclaw db generate --target mongodb` — do not edit by hand.",
		"// Run against your database: mongosh <connection-string> busyclaw-indexes.mongo.js",
		"//",
		"// Safe to re-run: createIndex is idempotent for an identical specification. Mongo creates",
		"// collections on first write, so there is nothing else to migrate — these indexes are the",
		"// whole of what the declaration asks the database to enforce.",
		"",
	];

	if (specs.length === 0) {
		lines.push("// This schema declares no keys, uniques or indexes.", "");
		return lines.join("\n");
	}

	let current = "";
	for (const spec of specs) {
		if (spec.collection !== current) {
			lines.push(
				`// ── ${spec.collection} ${"─".repeat(Math.max(0, 60 - spec.collection.length))}`,
			);
			current = spec.collection;
		}
		const options: Record<string, unknown> = {
			name: spec.name,
			unique: spec.unique,
		};
		if (spec.partialFilterExpression !== undefined) {
			options.partialFilterExpression = spec.partialFilterExpression;
		}
		lines.push(
			`db.getCollection(${JSON.stringify(spec.collection)}).createIndex(${JSON.stringify(spec.keys)}, ${JSON.stringify(options)});`,
		);
	}
	lines.push("");
	return lines.join("\n");
}
