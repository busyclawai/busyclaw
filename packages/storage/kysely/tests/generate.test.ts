// The Kysely types generator. Pure: SchemaDeclaration in, TypeScript source out.
//
// The property that matters most is that the emitted types are TRUE of the rows the adapter
// actually returns — which is dialect-dependent in two places SQLite gets wrong if you assume the
// declaration's vocabulary carries over: it has no boolean, and no timestamp.

import type { SchemaDeclaration } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { generateKyselyTypes } from "../src/generate";

const SCHEMA: SchemaDeclaration = {
	thread: {
		fields: {
			id: { type: "string", required: true, primaryKey: true },
			clawId: {
				type: "string",
				required: true,
				references: { model: "claw", field: "id" },
			},
			title: { type: "string" },
		},
	},
	claw: {
		fields: {
			id: { type: "string", required: true, primaryKey: true },
			context: { type: "json", required: true },
			createdAt: { type: "date", required: true },
			archived: { type: "boolean" },
			seq: { type: "number", required: true },
		},
	},
	pii_mapping: {
		fields: {
			placeholder: { type: "string", required: true },
			// Declared without `required`, so it is nullable in the database.
			scope: { type: "string" },
		},
	},
};

describe("generateKyselyTypes", () => {
	it("emits a table interface plus the three row shapes Kysely distinguishes", () => {
		const code = generateKyselyTypes({ schema: SCHEMA, dialect: "postgres" });
		expect(code).toContain("export interface ClawTable {");
		expect(code).toContain("export type Claw = Selectable<ClawTable>;");
		expect(code).toContain("export type NewClaw = Insertable<ClawTable>;");
		expect(code).toContain("export type ClawUpdate = Updateable<ClawTable>;");
	});

	it("maps a column that is not required to a nullable field", () => {
		const code = generateKyselyTypes({ schema: SCHEMA, dialect: "postgres" });
		expect(code).toContain("title: string | null;");
		expect(code).toContain("scope: string | null;");
		// Required and primary-key columns are never nullable.
		expect(code).toContain("id: string;");
		expect(code).toContain("placeholder: string;");
	});

	it("types postgres booleans and dates as postgres actually returns them", () => {
		const code = generateKyselyTypes({ schema: SCHEMA, dialect: "postgres" });
		expect(code).toContain("archived: boolean | null;");
		expect(code).toContain(
			"createdAt: ColumnType<Date, Date | string, Date | string>;",
		);
		expect(code).toContain("context: unknown;");
	});

	it("types SQLITE booleans as numbers and dates as strings — it has neither", () => {
		const code = generateKyselyTypes({ schema: SCHEMA, dialect: "sqlite" });
		expect(code).toContain("archived: number | null;");
		expect(code).toContain("createdAt: string;");
		// jsonb is parsed by the pg driver; sqlite hands back the stored text.
		expect(code).toContain("context: string;");
		// Nothing references ColumnType, so it must not be imported.
		expect(code).not.toContain("ColumnType");
	});

	it("maps every table into the Database interface under its PHYSICAL name", () => {
		const code = generateKyselyTypes({ schema: SCHEMA, dialect: "postgres" });
		expect(code).toContain("export interface Database {");
		expect(code).toContain("pii_mapping: PiiMappingTable;");
		expect(code).toContain("claw: ClawTable;");
		expect(code).toContain("thread: ThreadTable;");
	});

	it("honours modelName / fieldName physical overrides", () => {
		const code = generateKyselyTypes({
			schema: {
				claw: {
					modelName: "agents",
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						createdBy: {
							type: "string",
							required: true,
							fieldName: "created_by",
						},
					},
				},
			},
			dialect: "postgres",
		});
		expect(code).toContain("created_by: string;");
		expect(code).toContain("agents: ClawTable;");
	});

	it("imports only the kysely helpers it used", () => {
		const code = generateKyselyTypes({ schema: SCHEMA, dialect: "sqlite" });
		const line = code.match(/^import type \{ ([^}]+) \} from "kysely";$/m);
		expect(line?.[1]?.split(",").map((n) => n.trim())).toEqual([
			"Insertable",
			"Selectable",
			"Updateable",
		]);
	});
});

describe("the emitted types actually compile", () => {
	// These types exist to be consumed by a compiler, so the only assertion that really counts is
	// that one accepts them. It catches what string matching cannot: a helper kysely does not export,
	// a malformed ColumnType, an identifier that is not valid TypeScript.
	it("typechecks against real kysely, and types a query off the Database interface", async () => {
		const { execFile } = await import("node:child_process");
		const { rmSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { promisify } = await import("node:util");

		// Written INSIDE the package so `kysely` resolves the way it would for a consumer.
		const file = join(process.cwd(), "__generated_typecheck__.ts");
		try {
			writeFileSync(
				file,
				[
					generateKyselyTypes({ schema: SCHEMA, dialect: "postgres" }),
					// The point of the whole generator: a real query, typed off Database.
					'import type { Kysely } from "kysely";',
					"export async function titles(db: Kysely<Database>) {",
					'\tconst rows = await db.selectFrom("thread").select(["id", "title"]).execute();',
					"\treturn rows.map((row) => row.title?.toUpperCase() ?? null);",
					"}",
				].join("\n"),
				"utf8",
			);

			await promisify(execFile)("npx", [
				"tsc",
				"--noEmit",
				"--strict",
				"--skipLibCheck",
				"--ignoreConfig",
				"--moduleResolution",
				"bundler",
				"--module",
				"esnext",
				"--target",
				"es2022",
				file,
			]);
		} finally {
			rmSync(file, { force: true });
		}
	}, 180_000);
});
