// The migration emitter, against a REAL SQLite database — introspection included, so "does this
// table already exist" is answered by the database rather than a fake.
//
// The load-bearing properties, in order of how much damage getting them wrong would do:
//   1. it is ADDITIVE — a second run is a no-op, and an existing column is never retyped;
//   2. a declared composite primary key comes out as one composite key, not several;
//   3. a table with no `primaryKey` field still gets created (pii_mapping is real and has none);
//   4. reference order — a table is created after the table it points at.

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planMigrations } from "../src/migrations";

type DB = Record<string, Record<string, unknown>>;
let sqlite: Database.Database;
let db: Kysely<DB>;

beforeEach(() => {
	sqlite = new Database(":memory:");
	db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
});
afterEach(() => sqlite.close());

const plan = (schema: Parameters<typeof planMigrations>[0]["schema"]) =>
	planMigrations({
		db: db as never,
		schema,
		dialect: "sqlite",
		warn: () => {},
	});

describe("planMigrations", () => {
	it("creates a declared table with its primary key, columns and indexes", async () => {
		const first = await plan({
			claw: {
				fields: {
					id: {
						type: "string",
						required: true,
						primaryKey: true,
						unique: true,
					},
					name: { type: "string" },
					createdBy: { type: "string", required: true, index: true },
				},
			},
		});

		expect(first.isEmpty).toBe(false);
		expect(first.toBeCreated.map((t) => t.table)).toEqual(["claw"]);
		await first.runMigrations();

		const tables = await db.introspection.getTables();
		const claw = tables.find((t) => t.name === "claw");
		expect(claw?.columns.map((c) => c.name).sort()).toEqual([
			"createdBy",
			"id",
			"name",
		]);
	});

	it("is IDEMPOTENT — running against an already-migrated database plans nothing", async () => {
		const schema = {
			claw: {
				fields: {
					id: { type: "string", required: true, primaryKey: true },
					name: { type: "string" },
				},
			},
		} as const;

		await (await plan(schema)).runMigrations();
		const second = await plan(schema);

		expect(second.isEmpty).toBe(true);
		expect(second.toBeCreated).toEqual([]);
		expect(second.toBeAdded).toEqual([]);
		expect(second.compileMigrations()).toBe("");
	});

	it("ADDS a new column to an existing table without recreating it", async () => {
		await (
			await plan({
				claw: {
					fields: { id: { type: "string", required: true, primaryKey: true } },
				},
			})
		).runMigrations();

		const next = await plan({
			claw: {
				fields: {
					id: { type: "string", required: true, primaryKey: true },
					instructions: { type: "string" },
				},
			},
		});

		expect(next.toBeCreated).toEqual([]);
		expect(next.toBeAdded).toEqual([
			{ model: "claw", table: "claw", columns: ["instructions"] },
		]);
		await next.runMigrations();

		const claw = (await db.introspection.getTables()).find(
			(t) => t.name === "claw",
		);
		expect(claw?.columns.map((c) => c.name).sort()).toEqual([
			"id",
			"instructions",
		]);
	});

	it("REPORTS a drifted column type and does not change it", async () => {
		await db.schema
			.createTable("claw")
			.addColumn("id", "text", (c) => c.primaryKey())
			.addColumn("weight", "text")
			.execute();

		const drifted = await plan({
			claw: {
				fields: {
					id: { type: "string", required: true, primaryKey: true },
					weight: { type: "number" },
				},
			},
		});

		expect(drifted.drift).toEqual([
			{
				model: "claw",
				table: "claw",
				column: "weight",
				declared: "number",
				actual: "TEXT",
			},
		]);
		// Reported, never rewritten: nothing is planned for it.
		expect(drifted.isEmpty).toBe(true);
	});

	it("emits ONE composite primary key when several fields declare it", async () => {
		const composite = await plan({
			pii_mapping: {
				fields: {
					placeholder: { type: "string", required: true, primaryKey: true },
					scope: { type: "string", required: true, primaryKey: true },
					scopeId: { type: "string", required: true, primaryKey: true },
					original: { type: "string", required: true },
				},
			},
		});

		const sql = composite.compileMigrations();
		// ONE constraint over all three columns, not three single-column keys.
		expect(sql).toContain('primary key ("placeholder", "scope", "scopeId")');
		expect(sql.match(/primary key/g)).toHaveLength(1);
		// Explicitly NOT NULL even though they are key columns — SQLite would otherwise let a
		// NULL into the primary key.
		expect(sql).toContain('"placeholder" text not null');
		await expect(composite.runMigrations()).resolves.toBeUndefined();
	});

	it("creates a table that declares NO primary key (pii_mapping's real shape today)", async () => {
		const keyless = await plan({
			pii_mapping: {
				fields: {
					placeholder: { type: "string", required: true, index: true },
					scope: { type: "string", index: true },
					original: { type: "string", required: true },
				},
			},
		});

		expect(keyless.compileMigrations()).not.toContain("primary key");
		await expect(keyless.runMigrations()).resolves.toBeUndefined();
	});

	it("refuses a primaryKey field that is not required — a key column cannot be NULL", async () => {
		await expect(
			plan({
				claw: { fields: { id: { type: "string", primaryKey: true } } },
			}),
		).rejects.toThrow(/primaryKey but not required/);
	});

	it("creates a referenced table BEFORE the table referencing it", async () => {
		const ordered = await plan({
			// Declared child-first on purpose — the emitter must reorder.
			thread: {
				fields: {
					id: { type: "string", required: true, primaryKey: true },
					clawId: {
						type: "string",
						required: true,
						references: { model: "claw", field: "id" },
					},
				},
			},
			claw: {
				fields: { id: { type: "string", required: true, primaryKey: true } },
			},
		});

		expect(ordered.toBeCreated.map((t) => t.table)).toEqual(["claw", "thread"]);
		await expect(ordered.runMigrations()).resolves.toBeUndefined();
	});

	it("refuses a reference cycle rather than looping", async () => {
		await expect(
			plan({
				a: {
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						bId: {
							type: "string",
							required: true,
							references: { model: "b", field: "id" },
						},
					},
				},
				b: {
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						aId: {
							type: "string",
							required: true,
							references: { model: "a", field: "id" },
						},
					},
				},
			}),
		).rejects.toThrow(/circular table references/);
	});

	it("honours fieldName / modelName physical overrides", async () => {
		const renamed = await plan({
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
		});

		await renamed.runMigrations();
		const agents = (await db.introspection.getTables()).find(
			(t) => t.name === "agents",
		);
		expect(agents).toBeDefined();
		expect(agents?.columns.map((c) => c.name).sort()).toEqual([
			"created_by",
			"id",
		]);
	});
});
