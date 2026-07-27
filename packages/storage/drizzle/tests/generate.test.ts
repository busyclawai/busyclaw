// The Drizzle schema generator. Pure: SchemaDeclaration in, source text out — so these assert on the
// emitted code, and on the two things easiest to get quietly wrong: declaration ORDER and COMPOSITE
// primary keys, which euroclaw has and Better Auth's generators never see.

import type { SchemaDeclaration } from "@euroclaw/contracts";
// Imported at module scope, not inside the test. Loading drizzle-orm is slow enough that on a
// saturated machine it alone exceeded vitest's 5s per-test budget — the test failed for being
// scheduled badly, not for being wrong. Module loading belongs to the file, not the assertion.
import * as pgCore from "drizzle-orm/pg-core";
import * as sqliteCore from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { generateDrizzleSchema } from "../src/generate";

/** A claw <- thread pair (declared child-first, so ordering has to be earned) plus a composite key. */
const SCHEMA: SchemaDeclaration = {
	thread: {
		fields: {
			id: { type: "string", required: true, primaryKey: true, unique: true },
			clawId: {
				type: "string",
				required: true,
				index: true,
				references: { model: "claw", field: "id" },
			},
			title: { type: "string" },
			currentSequence: { type: "number", required: true },
		},
	},
	claw: {
		fields: {
			id: { type: "string", required: true, primaryKey: true, unique: true },
			createdBy: { type: "string", required: true, index: true },
			context: { type: "json", required: true },
			createdAt: { type: "date", required: true },
			archived: { type: "boolean" },
		},
	},
	pii_mapping: {
		fields: {
			placeholder: { type: "string", required: true, primaryKey: true },
			scope: { type: "string", required: true, primaryKey: true },
			original: { type: "string", required: true },
		},
	},
};

describe("generateDrizzleSchema", () => {
	it("declares a referenced table BEFORE the table referencing it", () => {
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "pg" });
		// `thread` names the `claw` const in its references callback, so `claw` must come first.
		expect(code.indexOf("export const claw =")).toBeLessThan(
			code.indexOf("export const thread ="),
		);
		expect(code).toContain(".references(() => claw.id)");
	});

	it("maps each declared type to its pg column helper and imports only what it used", () => {
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "pg" });
		expect(code).toContain("import {");
		expect(code).toContain('} from "drizzle-orm/pg-core";');
		// TEXT, not jsonb — the storage layer serializes json fields itself.
		expect(code).toContain('context: text("context").notNull()');
		expect(code).not.toContain("jsonb");
		expect(code).toContain(
			'createdAt: timestamp("createdAt", { withTimezone: true }).notNull()',
		);
		expect(code).toContain('archived: boolean("archived")');
		expect(code).toContain(
			'currentSequence: doublePrecision("currentSequence")',
		);
		// Nothing imports a helper the schema never used.
		expect(code).not.toContain("mysqlTable");
	});

	it("maps to sqlite helpers, where boolean and json have no native type", () => {
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "sqlite" });
		expect(code).toContain('} from "drizzle-orm/sqlite-core";');
		expect(code).toContain(
			'archived: integer("archived", { mode: "boolean" })',
		);
		// No mode:"json" either — that would make Drizzle parse what the adapter wants raw.
		expect(code).toContain('context: text("context")');
		expect(code).not.toContain('mode: "json"');
		expect(code).toContain("sqliteTable(");
	});

	it("emits a single-column key inline and a COMPOSITE key in the table extras", () => {
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "pg" });
		expect(code).toContain('id: text("id").notNull().primaryKey()');
		expect(code).toContain("primaryKey({ columns: [t.placeholder, t.scope] })");
		// The composite table must NOT also mark its columns individually.
		const piiBlock = code.slice(code.indexOf("export const piiMapping ="));
		expect(piiBlock).not.toContain(".primaryKey()");
	});

	it("emits indexes for declared index columns, skipping key columns", () => {
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "pg" });
		expect(code).toContain('index("claw_createdBy_idx").on(t.createdBy)');
		expect(code).toContain('index("thread_clawId_idx").on(t.clawId)');
	});

	it("turns a snake_case table key into a valid identifier and keeps the physical name", () => {
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "pg" });
		expect(code).toContain('export const piiMapping = pgTable("pii_mapping"');
	});
});

describe("the emitted code names REAL drizzle-orm helpers", () => {
	// A string assertion cannot tell `doublePrecision` from `doublePrecison`. Resolving each emitted
	// helper against the actual module does — and it is the mistake most likely to ship, because the
	// generated file is not compiled by this repo.
	const helpersIn = (code: string): string[] => {
		const match = code.match(/^import \{ ([^}]+) \} from/m);
		return (match?.[1] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
	};

	it("every helper it imports from pg-core exists there", () => {
		const core = pgCore;
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "pg" });
		const helpers = helpersIn(code);
		expect(helpers.length).toBeGreaterThan(0);
		for (const helper of helpers) {
			expect(core, `pg-core has no export "${helper}"`).toHaveProperty(helper);
		}
	});

	it("every helper it imports from sqlite-core exists there", () => {
		const core = sqliteCore;
		const code = generateDrizzleSchema({ schema: SCHEMA, provider: "sqlite" });
		const helpers = helpersIn(code);
		expect(helpers.length).toBeGreaterThan(0);
		for (const helper of helpers) {
			expect(core, `sqlite-core has no export "${helper}"`).toHaveProperty(
				helper,
			);
		}
	});

	it("emits a table-level composite unique as one constraint", () => {
		const code = generateDrizzleSchema({
			schema: {
				pii_mapping: {
					uniques: [["scope", "placeholder"]],
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						scope: { type: "string", required: true },
						placeholder: { type: "string", required: true },
					},
				},
			},
			provider: "pg",
		});
		expect(code).toContain(
			'unique("pii_mapping_scope_placeholder_uq").on(t.scope, t.placeholder)',
		);
		// The composite form is imported; the columns are NOT each marked .unique().
		expect(code).toContain("unique");
		expect(code).not.toContain('scope: text("scope").notNull().unique()');
	});

	it("refuses a provider it has no column map for, rather than emitting a wrong one", () => {
		expect(() =>
			generateDrizzleSchema({ schema: SCHEMA, provider: "mysql" }),
		).toThrow(/no schema generator for the "mysql" provider/);
	});
});
