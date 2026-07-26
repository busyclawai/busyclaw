// SchemaDeclaration → a Drizzle schema file. Lives here, beside the Drizzle adapter, because
// every column helper and import path in it is Drizzle's; @euroclaw/cli only dispatches to it.
//
// Unlike the SQL emitter this NEVER touches a database: it prints the whole schema, and drizzle-kit
// then owns the diffing and the migration. That is the same division Better Auth draws — `migrate`
// is Kysely-only, while `generate` dispatches per adapter and hands each ORM a file in its own
// language (packages/cli/src/generators/drizzle.ts). Competing with drizzle-kit would mean owning
// migration history, which is drizzle-kit's job and it is better at it.
//
// Tables are emitted in reference order because a Drizzle schema is TypeScript: `thread` names the
// `claw` const in its `.references(() => claw.id)` callback, so `claw` has to exist above it.

import type {
	FieldAttribute,
	FieldType,
	SchemaDeclaration,
	TableSchema,
} from "@euroclaw/contracts";
import { configurationError, tableOrder } from "@euroclaw/contracts";
// Type-only, so the cycle with index.ts (which re-exports this module) is erased at compile time.
// The provider vocabulary belongs to the ADAPTER CONFIG — one type, rather than a second, narrower
// copy that would drift the first time the adapter learned a dialect.
import type { DrizzleProvider } from "./index";

/** The providers this generator has column maps for. `mysql` is a declared adapter provider but is
 *  deliberately absent: its column semantics (varchar lengths, no native boolean) differ enough that
 *  an unverified map would emit a schema that looks right and migrates wrong. */
type EmittableProvider = Extract<DrizzleProvider, "pg" | "sqlite">;

const CORE_MODULE: Record<EmittableProvider, string> = {
	pg: "drizzle-orm/pg-core",
	sqlite: "drizzle-orm/sqlite-core",
};

const TABLE_FN: Record<EmittableProvider, string> = {
	pg: "pgTable",
	sqlite: "sqliteTable",
};

/** The column expression for a declared field type, per provider. */
const COLUMN: Record<
	EmittableProvider,
	Record<FieldType, (col: string) => string>
> = {
	pg: {
		string: (col) => `text(${col})`,
		// `doublePrecision`, matching the SQL emitter: one numeric declared type has to hold both
		// counters and confidence scores, and float is the only lossless choice for that pair.
		number: (col) => `doublePrecision(${col})`,
		boolean: (col) => `boolean(${col})`,
		date: (col) => `timestamp(${col}, { withTimezone: true })`,
		json: (col) => `jsonb(${col})`,
	},
	sqlite: {
		string: (col) => `text(${col})`,
		number: (col) => `real(${col})`,
		// SQLite has no boolean; Drizzle stores it as an integer and converts at the edge.
		boolean: (col) => `integer(${col}, { mode: "boolean" })`,
		date: (col) => `text(${col})`,
		json: (col) => `text(${col}, { mode: "json" })`,
	},
};

/** Which column helpers a schema actually uses, so the import line names only those. */
function usedHelpers(
	schema: SchemaDeclaration,
	provider: EmittableProvider,
): Set<string> {
	const helpers = new Set<string>([TABLE_FN[provider]]);
	for (const table of Object.values(schema)) {
		for (const field of Object.values(table.fields)) {
			// The helper name is the leading identifier of the emitted expression.
			const expression = COLUMN[provider][field.type]("x");
			const helper = expression.slice(0, expression.indexOf("("));
			helpers.add(helper);
			if (field.index === true) {
				helpers.add(field.unique === true ? "uniqueIndex" : "index");
			}
		}
		if (primaryKeyOf(table).length > 1) helpers.add("primaryKey");
	}
	return helpers;
}

function primaryKeyOf(table: TableSchema): string[] {
	return Object.entries(table.fields)
		.filter(([, field]) => field.primaryKey === true)
		.map(([name]) => name);
}

/** snake_case / arbitrary table key → a valid camelCase TS identifier. */
function identifier(model: string): string {
	const camel = model
		.split(/[^a-zA-Z0-9]+/)
		.filter((part) => part !== "")
		.map((part, index) =>
			index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join("");
	return /^[0-9]/.test(camel) ? `t${camel}` : camel;
}

const physicalColumn = (name: string, field: FieldAttribute): string =>
	field.fieldName ?? name;

const physicalTable = (model: string, table: TableSchema): string =>
	table.modelName ?? model;

export type DrizzleGenerateOptions = {
	schema: SchemaDeclaration;
	provider: DrizzleProvider;
};

function assertEmittable(provider: DrizzleProvider): EmittableProvider {
	if (provider === "pg" || provider === "sqlite") return provider;
	throw configurationError(
		`@euroclaw/storage-drizzle: no schema generator for the "${provider}" provider yet — pg and sqlite are mapped.`,
		{ provider },
	);
}

/** Emit the Drizzle schema module for a declaration. Pure — no database, no filesystem. */
export function generateDrizzleSchema(options: DrizzleGenerateOptions): string {
	const { schema } = options;
	const provider = assertEmittable(options.provider);
	const order = tableOrder(schema);

	const helpers = [...usedHelpers(schema, provider)].sort();
	const lines: string[] = [
		"// Generated by `euroclaw db generate` — do not edit by hand.",
		"// Re-run it after changing your plugins, schema, or redaction posture; drizzle-kit owns the",
		"// migration from here.",
		"",
		`import { ${helpers.join(", ")} } from "${CORE_MODULE[provider]}";`,
		"",
	];

	for (const model of order) {
		const table = schema[model];
		if (table === undefined) continue;
		const key = primaryKeyOf(table);
		const single = key.length === 1 ? key[0] : undefined;
		const indexes: string[] = [];

		const columns: string[] = [];
		for (const [name, field] of Object.entries(table.fields)) {
			const column = physicalColumn(name, field);
			let expression = COLUMN[provider][field.type](JSON.stringify(column));
			// A primary key is already NOT NULL and unique; restating either would emit a second
			// constraint over the same column.
			const isKey = key.includes(name);
			if (field.required === true || isKey) expression += ".notNull()";
			if (single === name) expression += ".primaryKey()";
			else if (field.unique === true && !isKey) expression += ".unique()";
			if (field.references !== undefined) {
				const target = schema[field.references.model];
				const targetTable = identifier(field.references.model);
				const targetField = field.references.field;
				// Only reference a table we were actually given — a host's own table is theirs to wire.
				if (target !== undefined) {
					expression += `.references(() => ${targetTable}.${targetField})`;
				}
			}
			columns.push(`\t${identifier(name)}: ${expression},`);

			if (field.index === true && !isKey) {
				const kind = field.unique === true ? "uniqueIndex" : "index";
				const suffix = field.unique === true ? "uidx" : "idx";
				indexes.push(
					`\t${kind}(${JSON.stringify(`${physicalTable(model, table)}_${column}_${suffix}`)}).on(t.${identifier(name)}),`,
				);
			}
		}

		const extras: string[] = [...indexes];
		if (key.length > 1) {
			extras.push(
				`\tprimaryKey({ columns: [${key.map((name) => `t.${identifier(name)}`).join(", ")}] }),`,
			);
		}

		const tail = extras.length > 0 ? `, (t) => [\n${extras.join("\n")}\n]` : "";
		lines.push(
			`export const ${identifier(model)} = ${TABLE_FN[provider]}(${JSON.stringify(physicalTable(model, table))}, {`,
			...columns,
			`}${tail});`,
			"",
		);
	}

	return lines.join("\n");
}
