/**
 * The shared where/sort conformance suite, run against Drizzle on SQLite.
 *
 * Paired with the Kysely run on the same engine: the two translate into different libraries but
 * bottom out in the same SQLite, so any disagreement BETWEEN THEM is purely a translation bug with
 * no "the database does it differently" defence available.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll } from "vitest";
import { describeWhereConformance } from "../../core/tests/kit/where-conformance";
import { type DrizzleSchema, drizzleAdapter } from "../src/index";

const approval = sqliteTable("approval", {
	id: text("id").primaryKey(),
	status: text("status"),
});
const audit = sqliteTable("audit", {
	seq: integer("seq"),
	name: text("name"),
});
const schema: DrizzleSchema = { approval, audit };

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
	sqlite = new Database(":memory:");
	sqlite.exec(
		"create table approval (id text primary key, status text); create table audit (seq integer, name text);",
	);
	db = drizzle(sqlite);
});

afterAll(() => sqlite.close());

describeWhereConformance("drizzle / sqlite", {
	adapter: () => drizzleAdapter(db, { provider: "sqlite", schema }),
	backend: "sqlite",
	reset: async () => {
		sqlite.exec("delete from approval; delete from audit;");
	},
});
