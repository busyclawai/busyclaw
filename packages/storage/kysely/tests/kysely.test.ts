import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type KyselyDatabase, kyselyAdapter } from "../src/index";

type DB = Record<string, Record<string, unknown>>;
let sqlite: Database.Database;
let db: Kysely<DB>;

beforeEach(async () => {
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
		.addColumn("hash", "text")
		.execute();
	await db.schema
		.createTable("token")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("digest", "text")
		.execute();
	await db.schema
		.createTable("resource")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("scope", "text")
		.addColumn("scopeId", "text")
		.addColumn("name", "text")
		.addColumn("seq", "integer")
		.execute();
});

afterEach(() => sqlite.close());

describe("@euroclaw/storage-kysely — Kysely adapter (SQLite)", () => {
	it("create + findOne by a where clause", async () => {
		const a = kyselyAdapter(db);
		const created = (await a.create({
			model: "approval",
			data: { id: "ap1", status: "pending" },
		})) as { id: string; status: string };
		expect(created.id).toBe("ap1");
		const got = (await a.findOne({
			model: "approval",
			where: [{ field: "id", value: "ap1" }],
		})) as { status: string } | null;
		expect(got?.status).toBe("pending");
		expect(
			await a.findOne({
				model: "approval",
				where: [{ field: "id", value: "nope" }],
			}),
		).toBeNull();
	});

	it("findMany with operators, sort, limit, offset", async () => {
		const a = kyselyAdapter(db);
		for (const seq of [2, 0, 3, 1])
			await a.create({
				model: "audit",
				data: { seq, name: `t${seq}`, hash: `h${seq}` },
			});
		const sorted = (await a.findMany({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
		})) as { seq: number }[];
		expect(sorted.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
		const page = (await a.findMany({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
			offset: 1,
			limit: 2,
		})) as { seq: number }[];
		expect(page.map((r) => r.seq)).toEqual([1, 2]);
		const gt = (await a.findMany({
			model: "audit",
			where: [{ field: "seq", operator: "gt", value: 1 }],
		})) as { seq: number }[];
		expect(gt.map((r) => r.seq).sort()).toEqual([2, 3]);
		const inSet = (await a.findMany({
			model: "audit",
			where: [{ field: "seq", operator: "in", value: [0, 3] }],
		})) as { seq: number }[];
		expect(inSet.map((r) => r.seq).sort()).toEqual([0, 3]);
	});

	it("handles null predicates with SQL null semantics", async () => {
		const a = kyselyAdapter(db);
		await a.create({ model: "approval", data: { id: "x", status: null } });
		await a.create({ model: "approval", data: { id: "y", status: "pending" } });

		expect(
			(await a.findOne({
				model: "approval",
				where: [{ field: "status", value: null }],
			})) as { id: string } | null,
		).toMatchObject({ id: "x" });
		expect(
			(
				(await a.findMany({
					model: "approval",
					where: [{ field: "status", operator: "ne", value: null }],
				})) as { id: string }[]
			).map((row) => row.id),
		).toEqual(["y"]);
	});

	it("update / updateMany / delete / count", async () => {
		const a = kyselyAdapter(db);
		await a.create({ model: "approval", data: { id: "x", status: "pending" } });
		await a.create({ model: "approval", data: { id: "y", status: "pending" } });
		await a.update({
			model: "approval",
			where: [{ field: "id", value: "x" }],
			update: { status: "approved" },
		});
		expect(
			(
				(await a.findOne({
					model: "approval",
					where: [{ field: "id", value: "x" }],
				})) as { status: string } | null
			)?.status,
		).toBe("approved");
		expect(
			await a.updateMany({
				model: "approval",
				where: [{ field: "status", value: "pending" }],
				update: { status: "expired" },
			}),
		).toBe(1);
		expect(await a.count({ model: "approval" })).toBe(2);
		await a.delete({ model: "approval", where: [{ field: "id", value: "y" }] });
		expect(await a.count({ model: "approval" })).toBe(1);
	});

	it("consumeOne is single-use and race-safe (one winner)", async () => {
		const a = kyselyAdapter(db);
		await a.create({ model: "token", data: { id: "t1", digest: "abc" } });
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				a.consumeOne<{ id: string }>({
					model: "token",
					where: [{ field: "id", value: "t1" }],
				}),
			),
		);
		expect(results.filter((r) => r !== null)).toHaveLength(1);
		expect(await a.count({ model: "token" })).toBe(0);
	});
});

describe("@euroclaw/storage-kysely — accepts a raw driver/dialect, not just a Kysely instance", () => {
	// All four forms wrap the SAME in-memory sqlite that beforeEach created the tables on.
	it("a raw better-sqlite3 Database", async () => {
		const a = kyselyAdapter(sqlite);
		await a.create({
			model: "approval",
			data: { id: "r1", status: "pending" },
		});
		expect(
			(
				(await a.findOne({
					model: "approval",
					where: [{ field: "id", value: "r1" }],
				})) as { status: string } | null
			)?.status,
		).toBe("pending");
	});

	it("a raw Kysely Dialect", async () => {
		const a = kyselyAdapter(new SqliteDialect({ database: sqlite }));
		await a.create({
			model: "approval",
			data: { id: "r2", status: "pending" },
		});
		expect(await a.count({ model: "approval" })).toBe(1);
	});

	it("an explicit { dialect, type } object", async () => {
		const a = kyselyAdapter({
			dialect: new SqliteDialect({ database: sqlite }),
			type: "sqlite",
		});
		await a.create({
			model: "approval",
			data: { id: "r3", status: "pending" },
		});
		expect(await a.count({ model: "approval" })).toBe(1);
	});

	it("an explicit { db, type } object", async () => {
		const a = kyselyAdapter({ db, type: "sqlite" });
		await a.create({
			model: "approval",
			data: { id: "r4", status: "pending" },
		});
		expect(await a.count({ model: "approval" })).toBe(1);
	});

	it("rejects MySQL up front (create/update use RETURNING)", () => {
		// via the object form's explicit type…
		expect(() =>
			kyselyAdapter({
				dialect: new SqliteDialect({ database: sqlite }),
				type: "mysql",
			}),
		).toThrow(/mysql/i);
		// …and via a duck-typed mysql2 pool (has `getConnection`).
		expect(() =>
			kyselyAdapter({ getConnection() {} } as unknown as KyselyDatabase),
		).toThrow(/mysql/i);
	});

	it("rejects an unrecognized input", () => {
		expect(() =>
			kyselyAdapter({ nope: true } as unknown as KyselyDatabase),
		).toThrow(/unrecognized/);
	});
});

describe("@euroclaw/storage-kysely — where trees, operators, and multi-sort (SQLite)", () => {
	const seed = async () => {
		const a = kyselyAdapter(db);
		const rows = [
			{ id: "r1", scope: "personal", scopeId: "alice", name: "Alpha", seq: 1 },
			{
				id: "r2",
				scope: "organization",
				scopeId: "acme",
				name: "beta%x",
				seq: 2,
			},
			{
				id: "r3",
				scope: "organization",
				scopeId: "other",
				name: "Beta",
				seq: 2,
			},
			{ id: "r4", scope: "personal", scopeId: "bob", name: "gamma", seq: 3 },
		];
		for (const row of rows) await a.create({ model: "resource", data: row });
		return a;
	};
	const ids = (rows: unknown[]) => (rows as { id: string }[]).map((r) => r.id);

	it("expresses the shareable-resource union and keyset pagination", async () => {
		const a = await seed();
		const union = await a.findMany({
			model: "resource",
			where: [
				{
					or: [
						{
							and: [
								{ field: "scope", value: "personal" },
								{ field: "scopeId", value: "alice" },
							],
						},
						{
							and: [
								{ field: "scope", value: "organization" },
								{ field: "scopeId", value: "acme" },
							],
						},
					],
				},
			],
			sortBy: { field: "id", direction: "asc" },
		});
		expect(ids(union)).toEqual(["r1", "r2"]);

		// keyset: page after cursor (seq=2, id="r2"), ordered by (seq asc, id asc)
		const page = await a.findMany({
			model: "resource",
			where: [
				{
					or: [
						{ field: "seq", operator: "gt", value: 2 },
						{
							and: [
								{ field: "seq", value: 2 },
								{ field: "id", operator: "gt", value: "r2" },
							],
						},
					],
				},
			],
			sortBy: [
				{ field: "seq", direction: "asc" },
				{ field: "id", direction: "asc" },
			],
		});
		expect(ids(page)).toEqual(["r3", "r4"]);
	});

	it("not_in / starts_with / ends_with, literal wildcards, empty-list semantics", async () => {
		const a = await seed();
		expect(
			ids(
				await a.findMany({
					model: "resource",
					where: [{ field: "scope", operator: "not_in", value: ["personal"] }],
				}),
			).sort(),
		).toEqual(["r2", "r3"]);
		expect(
			await a.findMany({
				model: "resource",
				where: [{ field: "scope", operator: "in", value: [] }],
			}),
		).toEqual([]);
		expect(
			(
				await a.findMany({
					model: "resource",
					where: [{ field: "scope", operator: "not_in", value: [] }],
				})
			).length,
		).toBe(4);
		// sqlite's LIKE is ASCII-case-insensitive by default (documented port caveat), so the
		// nominally-sensitive prefix match also catches "beta%x".
		expect(
			ids(
				await a.findMany({
					model: "resource",
					where: [{ field: "name", operator: "starts_with", value: "Bet" }],
					sortBy: { field: "id", direction: "asc" },
				}),
			),
		).toEqual(["r2", "r3"]);
		expect(
			ids(
				await a.findMany({
					model: "resource",
					where: [{ field: "name", operator: "ends_with", value: "ta" }],
				}),
			),
		).toEqual(["r3"]);
		// "%" in the value is a literal character, never a wildcard
		expect(
			ids(
				await a.findMany({
					model: "resource",
					where: [{ field: "name", operator: "contains", value: "a%x" }],
				}),
			),
		).toEqual(["r2"]);
	});

	it("mode: insensitive, multi-column sort, empty group fails loud", async () => {
		const a = await seed();
		expect(
			ids(
				await a.findMany({
					model: "resource",
					where: [{ field: "name", value: "BETA", mode: "insensitive" }],
				}),
			),
		).toEqual(["r3"]);
		const insensitive = await a.findMany({
			model: "resource",
			where: [
				{
					field: "name",
					operator: "contains",
					value: "BET",
					mode: "insensitive",
				},
			],
			sortBy: { field: "id", direction: "asc" },
		});
		expect(ids(insensitive)).toEqual(["r2", "r3"]);
		const sorted = await a.findMany({
			model: "resource",
			sortBy: [
				{ field: "seq", direction: "desc" },
				{ field: "id", direction: "asc" },
			],
		});
		expect(ids(sorted)).toEqual(["r4", "r2", "r3", "r1"]);
		await expect(
			a.findMany({ model: "resource", where: [{ or: [] }] }),
		).rejects.toThrow(/where group is empty/);
	});
});
