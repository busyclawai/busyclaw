// The MySQL update path, against a real MySQL.
//
// H-11: `update` cannot RETURNING on MySQL, so it re-reads the row by id — and it used to do that
// unconditionally, without asking whether the conditional predicate had matched anything. A
// compare-and-set that lost (another worker had already moved the row out of the state the WHERE
// named) still came back with a row, so BOTH workers believed they had won.
//
// Every guarded transition in the durable layer is built on that call returning null when it loses:
// an approval claim, an effect lease, a task claim, a checkpoint. On PostgreSQL and SQLite the
// `.returning()` path gives the true answer, so this defect existed on exactly one provider — which is
// also the one nothing tested, because sqlite is what the other tests run on.
//
// SKIPPED unless a MySQL is reachable. Point it anywhere with BUSYCLAW_TEST_MYSQL_URL; the local
// recipe is:
//   docker run -d --rm --name busyclaw-mysql -e MYSQL_ROOT_PASSWORD=busyclaw \
//     -e MYSQL_DATABASE=busyclaw_test -p 3399:3306 mysql:8

import { drizzleAdapter } from "@busyclaw/storage-drizzle";
import { sql } from "drizzle-orm";
import { mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL =
	process.env.BUSYCLAW_TEST_MYSQL_URL ??
	"mysql://root:busyclaw@127.0.0.1:3399/busyclaw_test";

const approval = mysqlTable("approval", {
	id: varchar("id", { length: 191 }).primaryKey(),
	status: varchar("status", { length: 64 }),
	leaseId: varchar("leaseId", { length: 191 }),
});
const schema = { approval };

let pool: mysql.Pool | undefined;
// Derived from the CALL, not from the bare factory: drizzle's overloads differ by whether a schema
// (and which mode) is passed, so `ReturnType<typeof drizzle>` is a different handle than the one
// this file actually builds.
const connect = (p: mysql.Pool) => drizzle(p, { schema, mode: "default" });
let database: ReturnType<typeof connect> | undefined;

async function reachable(): Promise<boolean> {
	try {
		const probe = await mysql.createConnection(URL);
		await probe.end();
		return true;
	} catch {
		return false;
	}
}

const live = await reachable();
const suite = live ? describe : describe.skip;

beforeAll(async () => {
	if (!live) return;
	pool = mysql.createPool(URL);
	database = connect(pool);
	await database?.execute(sql`DROP TABLE IF EXISTS approval`);
	await database?.execute(
		sql`CREATE TABLE approval (id VARCHAR(191) PRIMARY KEY, status VARCHAR(64), leaseId VARCHAR(191))`,
	);
});

afterAll(async () => {
	await pool?.end();
});

suite("@busyclaw/storage-drizzle — MySQL conditional updates", () => {
	const adapter = () => {
		if (!database) throw new Error("no database");
		return drizzleAdapter(database, { provider: "mysql", schema });
	};

	it("returns null when the conditional predicate matched nothing", async () => {
		const a = adapter();
		await a.create({
			model: "approval",
			data: { id: "ap-lost", status: "approved" },
		});

		// The winner moves it out of `approved`.
		const won = await a.update({
			model: "approval",
			where: [
				{ field: "id", value: "ap-lost" },
				{ field: "status", value: "approved", connector: "AND" },
			],
			update: { status: "executing", leaseId: "lease-a" },
		});
		expect(won).toMatchObject({ status: "executing", leaseId: "lease-a" });

		// The loser asks for the SAME transition. Its predicate now matches zero rows — and it used to
		// get the row back anyway, because the re-read by id knows nothing about the predicate.
		const lost = await a.update({
			model: "approval",
			where: [
				{ field: "id", value: "ap-lost" },
				{ field: "status", value: "approved", connector: "AND" },
			],
			update: { status: "executing", leaseId: "lease-b" },
		});
		expect(lost).toBeNull();

		// And the winner's write stands — the loser did not overwrite it on the way past.
		expect(
			await a.findOne({
				model: "approval",
				where: [{ field: "id", value: "ap-lost" }],
			}),
		).toMatchObject({ leaseId: "lease-a" });
	});

	it("gives exactly one winner under concurrent claims", async () => {
		const a = adapter();
		await a.create({
			model: "approval",
			data: { id: "ap-race", status: "approved" },
		});

		const claims = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				a.update({
					model: "approval",
					where: [
						{ field: "id", value: "ap-race" },
						{ field: "status", value: "approved", connector: "AND" },
					],
					update: { status: "executing", leaseId: `lease-${i}` },
				}),
			),
		);
		// The property the whole durable layer rests on: one caller proceeds, the rest are told no.
		expect(claims.filter((row) => row !== null)).toHaveLength(1);
	});

	// WHAT THESE TESTS DO NOT COVER, and why it is written down rather than left implied.
	//
	// The `affectedRows` guard in the MySQL branch has no test that fails without it, and I could not
	// build one. The reason looks structural: `update` reads the row by predicate FIRST, to learn its
	// id, and a compare-and-set that has already lost fails that read and returns null there — never
	// reaching the branch. Four attempts to force the window (racing clients, a proxied drizzle
	// database, a proxied mysql2 pool flipping the row before and then after the read) all passed
	// against the unguarded code, i.e. they were passing for the wrong reason.
	//
	// So the guard covers a genuine but narrow window — the row changing BETWEEN the two statements —
	// that the adapter's own pre-read makes hard to reach through this API. It stays because the
	// durable layer's correctness rests on a lost transition returning null, and "hard to reach" is
	// not "unreachable". But H-11's practical severity through this surface is lower than High
	// suggests, and nobody should read the tests below as proving the guard works.

	it("still returns the row when the predicate DID match", async () => {
		const a = adapter();
		await a.create({
			model: "approval",
			data: { id: "ap-ok", status: "pending" },
		});
		expect(
			await a.update({
				model: "approval",
				where: [
					{ field: "id", value: "ap-ok" },
					{ field: "status", value: "pending", connector: "AND" },
				],
				update: { status: "approved" },
			}),
		).toMatchObject({ id: "ap-ok", status: "approved" });
	});
});
