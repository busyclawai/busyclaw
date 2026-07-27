import { piiMappingSchema, piiSubjectSchema } from "@euroclaw/contracts";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";
import { planMigrations } from "../src/migrations";

// The PII vault's own schema, migrated against a real SQLite database.
//
// Everything else in this file uses fixtures shaped to exercise the emitter. This one asserts the
// table euroclaw actually ships: its key is the container triple, and that key was undeclarable until
// `scope`/`scopeId` became required — a primary key cannot contain NULL. The emitter's composite
// support was already tested; that the REAL schema uses it was asserted and not run.
describe("the real PII schema", () => {
	it("creates with its container-composite primary key", async () => {
		const db = new Kysely<Record<string, never>>({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
		});
		const plan = await planMigrations({
			db: db as never,
			schema: { ...piiMappingSchema, ...piiSubjectSchema },
			dialect: "sqlite",
			warn: () => {},
		});
		const sql = plan.compileMigrations();
		expect(sql).toContain('primary key ("placeholder", "scope", "scopeId")');
		// Key columns must be NOT NULL or SQLite would quietly admit a null into the key.
		expect(sql).toContain('"scope" text not null');
		expect(sql).toContain('"scopeId" text not null');
		await expect(plan.runMigrations()).resolves.toBeUndefined();
		await db.destroy();
	});
});
