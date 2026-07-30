// The migration emitter, against a REAL SQLite database — introspection included, so "does this
// table already exist" is answered by the database rather than a fake.
//
// The load-bearing properties, in order of how much damage getting them wrong would do:
//   1. it is ADDITIVE — a second run is a no-op, and an existing column is never retyped;
//   2. a declared composite primary key comes out as one composite key, not several;
//   3. a table with no `primaryKey` field still gets created (no core table is keyless now that the
//      PII vault declares its container, but a plugin may declare one);
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

	it("creates a table that declares NO primary key", async () => {
		const keyless = await plan({
			plugin_scratch: {
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

	it("emits a json column as TEXT — the storage layer owns the serialization", async () => {
		// Not a style choice: schemaAdapter's default `json: "string"` mode (what createClaw uses)
		// stringifies on write and demands a string on read. A native jsonb column makes pg return a
		// parsed object and decoding throws — which is exactly how this was found, against real Neon.
		const plan = await planMigrations({
			db: db as never,
			schema: {
				claw: {
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						context: { type: "json", required: true },
					},
				},
			},
			dialect: "postgres",
			warn: () => {},
		});
		const sql = plan.compileMigrations();
		expect(sql).toContain('"context" text');
		expect(sql).not.toContain("jsonb");
	});

	it("reports an existing jsonb column as DRIFT rather than accepting it", async () => {
		await db.schema
			.createTable("claw")
			.addColumn("id", "text", (c) => c.primaryKey())
			.addColumn("context", "jsonb")
			.execute();

		const plan = await planMigrations({
			db: db as never,
			schema: {
				claw: {
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						context: { type: "json", required: true },
					},
				},
			},
			dialect: "postgres",
			warn: () => {},
		});
		expect(plan.drift).toContainEqual(
			expect.objectContaining({ column: "context", declared: "json" }),
		);
	});

	it("emits a table-level composite unique the database actually enforces", async () => {
		const composite = await plan({
			pii_mapping: {
				uniques: [["scope", "scopeId", "placeholder"]],
				fields: {
					id: { type: "string", required: true, primaryKey: true },
					scope: { type: "string", required: true },
					scopeId: { type: "string", required: true },
					placeholder: { type: "string", required: true },
				},
			},
		});

		const sql = composite.compileMigrations();
		// ONE constraint over all three, not three single-column ones.
		expect(sql).toContain(
			'constraint "pii_mapping_scope_scopeId_placeholder_uq" unique ("scope", "scopeId", "placeholder")',
		);
		expect(sql.match(/unique \(/g)).toHaveLength(1);
		await composite.runMigrations();

		// The point of a constraint over an index: the DATABASE refuses the duplicate.
		const insert = (id: string) =>
			db
				.insertInto("pii_mapping")
				.values({ id, scope: "claw", scopeId: "c1", placeholder: "{{p}}" })
				.execute();
		await insert("a");
		await expect(insert("b")).rejects.toThrow();
		// A different container is a different row — the group is what makes that true.
		await expect(
			db
				.insertInto("pii_mapping")
				.values({
					id: "c",
					scope: "claw",
					scopeId: "c2",
					placeholder: "{{p}}",
				})
				.execute(),
		).resolves.toBeDefined();
	});

	it("keeps several `unique: true` fields as SEPARATE constraints", async () => {
		// Why composition lives on the TABLE: composing these flags would silently merge two unrelated
		// constraints into one, and every existing declaration relies on them being apart.
		const separate = await plan({
			thing: {
				fields: {
					id: { type: "string", required: true, primaryKey: true },
					slug: { type: "string", required: true, unique: true },
					email: { type: "string", required: true, unique: true },
				},
			},
		});
		const sql = separate.compileMigrations();
		expect(sql).toContain('"slug" text not null unique');
		expect(sql).toContain('"email" text not null unique');
		// Two inline column constraints, and no composite one grouping them.
		expect(sql).not.toContain("_uq");
		expect(sql).not.toMatch(/unique \(/);
	});

	it("refuses a unique constraint naming a column the table does not have", async () => {
		await expect(
			plan({
				thing: {
					uniques: [["scope", "typo"]],
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						scope: { type: "string", required: true },
					},
				},
			}),
		).rejects.toThrow(/names "typo", which is not a field/);
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

// R-H12. Composite uniques were emitted only in the CREATE-TABLE branch, so a database migrated
// before a constraint was declared never acquired it — and re-running `migrate` did not repair that,
// because the existing-table branch only ever compared columns.
//
// That is the half of R-H11 that decides whether the fix reaches anyone. Declaring the constraint
// fixes fresh databases; this is what fixes the ones that already exist. And it matters because every
// lookup-then-create upsert in storage-durable depends on the database rejecting the second insert:
// a table silently missing its key does not error, it accumulates duplicates.
describe("planMigrations — an EXISTING table acquires a newly declared unique", () => {
	const withUnique = {
		note: {
			uniques: [["scope", "name"]],
			fields: {
				id: { type: "string", required: true, primaryKey: true },
				scope: { type: "string", required: true },
				name: { type: "string", required: true },
			},
		},
	} satisfies Parameters<typeof planMigrations>[0]["schema"];

	const withoutUnique = {
		note: { fields: withUnique.note.fields },
	} satisfies Parameters<typeof planMigrations>[0]["schema"];

	it("adds it to a table created before it was declared", async () => {
		// The table exists WITHOUT the constraint — the state every database migrated before R-H11 is
		// in right now.
		await (await plan(withoutUnique)).runMigrations();

		const second = await plan(withUnique);
		expect(second.isEmpty).toBe(false);
		expect(second.backfilledUniques).toEqual([
			{
				model: "note",
				table: "note",
				constraint: "note_scope_name_uq",
				columns: ["scope", "name"],
			},
		]);
		// A unique INDEX, not a table constraint: SQLite cannot ALTER TABLE ADD CONSTRAINT at all, and
		// an index enforces the same thing while raising the same driver codes `isConflict` keys on.
		expect(second.compileMigrations()).toContain("create unique index");

		await second.runMigrations();

		// The database now REJECTS the duplicate — which is the whole point, since upsertWithRetry
		// treats that rejection as its retry signal.
		await db
			.insertInto("note" as never)
			.values({ id: "a", scope: "s", name: "n" } as never)
			.execute();
		await expect(
			db
				.insertInto("note" as never)
				.values({ id: "b", scope: "s", name: "n" } as never)
				.execute(),
		).rejects.toThrow(/UNIQUE|constraint/i);
	});

	it("is not re-planned once it exists — `isEmpty` stays honest", async () => {
		await (await plan(withUnique)).runMigrations();
		const again = await plan(withUnique);
		// Without introspecting index names this would plan an idempotent CREATE ... IF NOT EXISTS on
		// every run, so a fully-migrated database would permanently report work — training an operator
		// to ignore the one signal that says a migration is outstanding.
		expect(again.backfilledUniques).toEqual([]);
		expect(again.isEmpty).toBe(true);
	});
});
