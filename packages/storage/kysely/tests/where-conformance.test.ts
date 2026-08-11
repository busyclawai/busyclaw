/**
 * The shared where/sort conformance suite, run against Kysely on SQLite.
 *
 * SQLite is not an arbitrary choice of backend here — it is what `busyclaw db generate` produces for
 * local development, so whatever this run says is what a developer's machine actually does. Where it
 * disagrees with the memory adapter, the disagreement is already live in somebody's dev loop.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeAll } from "vitest";
import { describeWhereConformance } from "../../core/tests/kit/where-conformance";
import { kyselyAdapter } from "../src/index";

type DB = Record<string, Record<string, unknown>>;
let sqlite: Database.Database;
let db: Kysely<DB>;

beforeAll(async () => {
	sqlite = new Database(":memory:");
	db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
	await db.schema
		.createTable("approval")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("status", "text")
		.execute();
	await db.schema
		.createTable("audit")
		.addColumn("seq", "integer")
		.addColumn("name", "text")
		.execute();
});

afterAll(() => sqlite.close());

describeWhereConformance("kysely / sqlite", {
	adapter: () => kyselyAdapter(db),
	backend: "sqlite",
	reset: async () => {
		await db.deleteFrom("approval").execute();
		await db.deleteFrom("audit").execute();
	},
});
