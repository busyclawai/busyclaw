// A `field.boolean()` COLUMN, END TO END — written, read back, and filtered on.
//
// It could do none of those on SQLite. better-sqlite3 refuses to bind a JS boolean at all ("SQLite3
// can only bind numbers, strings, bigints, buffers, and null"), so the failure came from the driver
// rather than from anything that knew a boolean column was involved — and it surfaced only when
// somebody finally declared one and tried to query it.
//
// The fix is a codec at the schema layer, driven by an adapter capability: only the adapter knows
// what its driver can bind.

import type { SchemaDeclaration } from "@busyclaw/contracts";
import { field } from "@busyclaw/contracts";
import { entityDb } from "@busyclaw/storage-core";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { kyselyAdapter, planMigrations } from "../src/index";

const fields = {
	id: field.string({ required: true, primaryKey: true, unique: true }),
	name: field.string({ required: true }),
	audit: field.boolean(),
} as const;

const open: (() => void)[] = [];
afterEach(() => {
	for (const close of open.splice(0)) close();
});

async function sqlite() {
	const db = new Database(":memory:");
	open.push(() => db.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: db }),
	});
	const plan = await planMigrations({
		db: kdb,
		schema: { thing: { modelName: "thing", fields } } as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	const adapter = kyselyAdapter(kdb);
	return { adapter, db: entityDb(adapter, { thing: { fields } }) };
}

describe("boolean columns on sqlite", () => {
	it("declares that its driver wants integers", async () => {
		const { adapter } = await sqlite();
		expect(adapter.booleans).toBe("integer");
	});

	it("writes, reads back, and round-trips as a real boolean", async () => {
		const { db } = await sqlite();

		const created = await db.create({
			model: "thing",
			data: { id: "1", name: "one", audit: true },
		});
		expect(created.audit).toBe(true);

		const read = await db.findOne({
			model: "thing",
			where: [{ field: "id", value: "1" }],
		});
		// A boolean, not the 1 the column actually holds — the read side normalizes whatever the
		// store hands back for a declared boolean.
		expect(read?.audit).toBe(true);
	});

	it("filters on it, which is where the gap actually bit", async () => {
		const { db } = await sqlite();
		await db.create({
			model: "thing",
			data: { id: "1", name: "audited", audit: true },
		});
		await db.create({
			model: "thing",
			data: { id: "2", name: "quiet", audit: false },
		});

		const audited = await db.findMany({
			model: "thing",
			where: [{ field: "audit", value: true }],
		});
		expect(audited.map((row) => row.id)).toEqual(["1"]);

		const quiet = await db.findMany({
			model: "thing",
			where: [{ field: "audit", value: false }],
		});
		expect(quiet.map((row) => row.id)).toEqual(["2"]);
	});

	it("filters with `in`, whose values are a list", async () => {
		const { db } = await sqlite();
		await db.create({
			model: "thing",
			data: { id: "1", name: "a", audit: true },
		});
		await db.create({
			model: "thing",
			data: { id: "2", name: "b", audit: false },
		});

		expect(
			(
				await db.findMany({
					model: "thing",
					where: [{ field: "audit", value: [true, false], operator: "in" }],
				})
			).length,
		).toBe(2);
	});

	it("updates it", async () => {
		const { db } = await sqlite();
		await db.create({
			model: "thing",
			data: { id: "1", name: "a", audit: true },
		});

		const updated = await db.update({
			model: "thing",
			where: [{ field: "id", value: "1" }],
			update: { audit: false },
		});

		expect(updated?.audit).toBe(false);
		expect(
			(
				await db.findMany({
					model: "thing",
					where: [{ field: "audit", value: false }],
				})
			).map((row) => row.id),
		).toEqual(["1"]);
	});

	it("leaves an unset boolean absent rather than false", async () => {
		// `field.boolean()` is optional here, and "nobody said" is not "no". Coercing an absent column
		// to `false` would invent an answer.
		const { db } = await sqlite();
		await db.create({ model: "thing", data: { id: "1", name: "a" } });

		expect(
			(
				await db.findOne({
					model: "thing",
					where: [{ field: "id", value: "1" }],
				})
			)?.audit,
		).toBeUndefined();
	});
});
