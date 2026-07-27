// Does better-sqlite3, through Kysely, actually raise what the conflict detector expects?
//
// @busyclaw/storage-core owns the rule and pins its logic; it cannot own this question, because
// answering it needs the driver. Kysely appears in no branch of that detector — the claim is that it
// hands its driver's error through untouched — so this is where that claim is checked.

import { asConflict, isUniqueViolation } from "@busyclaw/storage-core";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type DB = Record<string, Record<string, unknown>>;
let sqlite: Database.Database;
let db: Kysely<DB>;

beforeEach(async () => {
	sqlite = new Database(":memory:");
	db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
	await db.schema
		.createTable("claw")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("slug", "text", (c) => c.unique())
		.execute();
});
afterEach(() => sqlite.close());

const raise = (run: Promise<unknown>): Promise<unknown> =>
	run.then(
		() => undefined,
		(error: unknown) => error,
	);

describe("sqlite through kysely", () => {
	it("a unique-column collision is recognised", async () => {
		await db.insertInto("claw").values({ id: "a", slug: "one" }).execute();
		const error = await raise(
			db.insertInto("claw").values({ id: "b", slug: "one" }).execute(),
		);

		expect(error).toBeDefined();
		expect(isUniqueViolation(error)).toBe(true);
		expect(asConflict(error, { model: "claw" })?.code).toBe(
			"BUSYCLAW_CONFLICT",
		);
	});

	it("a primary-key collision is recognised", async () => {
		await db.insertInto("claw").values({ id: "a", slug: "one" }).execute();
		const error = await raise(
			db.insertInto("claw").values({ id: "a", slug: "two" }).execute(),
		);
		expect(isUniqueViolation(error)).toBe(true);
	});

	it("a NON-unique failure keeps its identity", async () => {
		// A missing table has no recovery, so normalizing it would turn a real bug into a retry.
		const error = await raise(
			db.insertInto("nope").values({ id: "a" }).execute(),
		);
		expect(error).toBeDefined();
		expect(isUniqueViolation(error)).toBe(false);
		expect(asConflict(error)).toBeUndefined();
	});
});
