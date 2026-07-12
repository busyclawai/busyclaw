import { describe, expect, it } from "vitest";
import {
	type Adapter,
	memoryAdapter,
	type SchemaDeclaration,
	schemaAdapter,
} from "../src/index";

const a = (): Adapter => memoryAdapter();

describe("@euroclaw/storage-core — memory adapter", () => {
	it("create + findOne by a where clause", async () => {
		const db = a();
		await db.create({
			model: "approval",
			data: { id: "ap1", status: "pending" },
		});
		const got = (await db.findOne({
			model: "approval",
			where: [{ field: "id", value: "ap1" }],
		})) as { id: string; status: string } | null;
		expect(got?.status).toBe("pending");
		const miss = await db.findOne({
			model: "approval",
			where: [{ field: "id", value: "nope" }],
		});
		expect(miss).toBeNull();
	});

	it("findMany with where operators, sort, limit, offset", async () => {
		const db = a();
		for (const seq of [2, 0, 3, 1])
			await db.create({ model: "audit", data: { seq, kind: "tool" } });
		const sorted = (await db.findMany({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
		})) as { seq: number }[];
		expect(sorted.map((r) => r.seq)).toEqual([0, 1, 2, 3]);

		const page = (await db.findMany({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
			offset: 1,
			limit: 2,
		})) as { seq: number }[];
		expect(page.map((r) => r.seq)).toEqual([1, 2]);

		const gt = (await db.findMany({
			model: "audit",
			where: [{ field: "seq", operator: "gt", value: 1 }],
		})) as { seq: number }[];
		expect(gt.map((r) => r.seq).sort()).toEqual([2, 3]);

		const inSet = (await db.findMany({
			model: "audit",
			where: [{ field: "seq", operator: "in", value: [0, 3] }],
		})) as { seq: number }[];
		expect(inSet.map((r) => r.seq).sort()).toEqual([0, 3]);
	});

	it("update / updateMany / delete / count", async () => {
		const db = a();
		await db.create({
			model: "approval",
			data: { id: "x", status: "pending" },
		});
		await db.create({
			model: "approval",
			data: { id: "y", status: "pending" },
		});

		await db.update({
			model: "approval",
			where: [{ field: "id", value: "x" }],
			update: { status: "approved" },
		});
		expect(
			(
				(await db.findOne({
					model: "approval",
					where: [{ field: "id", value: "x" }],
				})) as { status: string } | null
			)?.status,
		).toBe("approved");

		const n = await db.updateMany({
			model: "approval",
			where: [{ field: "status", value: "pending" }],
			update: { status: "expired" },
		});
		expect(n).toBe(1); // only y was still pending

		expect(await db.count({ model: "approval" })).toBe(2);
		await db.delete({
			model: "approval",
			where: [{ field: "id", value: "y" }],
		});
		expect(await db.count({ model: "approval" })).toBe(1);
	});

	it("consumeOne is single-use and race-safe (one winner, the rest get null)", async () => {
		const db = a();
		await db.create({ model: "token", data: { id: "t1", digest: "abc" } });

		// Fire several consumes for the same row concurrently — exactly one gets it.
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				db.consumeOne<{ id: string }>({
					model: "token",
					where: [{ field: "id", value: "t1" }],
				}),
			),
		);
		const winners = results.filter((r) => r !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.id).toBe("t1");
		expect(await db.count({ model: "token" })).toBe(0); // consumed
	});

	it("transaction commits or rolls back a group of writes", async () => {
		const db = a();
		await db.transaction?.(async (tx) => {
			await tx.create({ model: "run", data: { id: "r1", status: "queued" } });
			await tx.create({ model: "event", data: { id: "e1", runId: "r1" } });
		});
		expect(await db.count({ model: "run" })).toBe(1);
		expect(await db.count({ model: "event" })).toBe(1);

		await expect(
			db.transaction?.(async (tx) => {
				await tx.create({
					model: "run",
					data: { id: "r2", status: "queued" },
				});
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(
			await db.findOne({ model: "run", where: [{ field: "id", value: "r2" }] }),
		).toBeNull();
	});

	it("serves the two euroclaw use cases: append-only audit + approval lifecycle", async () => {
		const db = a();

		// Audit: append rows, read back in order — what a durable AuditSink will do.
		for (let seq = 0; seq < 3; seq++) {
			await db.create({
				model: "audit",
				data: { seq, name: `tool${seq}`, hash: `h${seq}` },
			});
		}
		const log = (await db.findMany({
			model: "audit",
			sortBy: { field: "seq", direction: "asc" },
		})) as { seq: number }[];
		expect(log.map((r) => r.seq)).toEqual([0, 1, 2]);

		// Approval: create pending → consume once on approval → gone (can't be replayed).
		await db.create({
			model: "approval",
			data: { id: "ap1", status: "pending" },
		});
		const consumed = (await db.consumeOne({
			model: "approval",
			where: [{ field: "id", value: "ap1" }],
		})) as { id: string } | null;
		expect(consumed?.id).toBe("ap1");
		expect(
			await db.consumeOne({
				model: "approval",
				where: [{ field: "id", value: "ap1" }],
			}),
		).toBeNull();
	});
});

const fieldSchema = {
	claw: {
		modelName: "euroclaw_claw",
		fields: {
			id: { type: "string", required: true, unique: true },
			organizationId: {
				type: "string",
				fieldName: "organization_id",
				required: true,
			},
			status: {
				type: "string",
				required: true,
				defaultValue: () => "active",
			},
			context: {
				type: "json",
				required: true,
				defaultValue: () => ({ source: "default" }),
			},
			updatedAt: {
				type: "string",
				required: true,
				defaultValue: () => "created",
				onUpdate: () => "updated",
			},
			secret: { type: "string", returned: false },
			locked: { type: "string", immutable: true },
		},
	},
} satisfies SchemaDeclaration;

type FieldClaw = {
	id: string;
	organizationId: string;
	status: string;
	context: unknown;
	updatedAt: string;
	secret?: string;
	locked?: string;
};

describe("@euroclaw/storage-core — schema adapter", () => {
	it("maps model and field names while encoding and decoding JSON", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);

		const created = (await db.create({
			model: "claw",
			data: { id: "c1", organizationId: "t1", secret: "hidden", locked: "v1" },
		})) as FieldClaw;

		expect(created).toEqual({
			context: { source: "default" },
			id: "c1",
			locked: "v1",
			status: "active",
			organizationId: "t1",
			updatedAt: "created",
		});

		const row = (await raw.findOne({
			model: "euroclaw_claw",
			where: [{ field: "organization_id", value: "t1" }],
		})) as Record<string, unknown> | null;
		expect(row).toMatchObject({
			context: JSON.stringify({ source: "default" }),
			id: "c1",
			secret: "hidden",
			organization_id: "t1",
		});

		const found = (await db.findOne({
			model: "claw",
			where: [{ field: "organizationId", value: "t1" }],
		})) as FieldClaw | null;
		expect(found).toEqual(created);
	});

	it("maps select, sort, count, and update fields", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);
		await db.create({ model: "claw", data: { id: "c2", organizationId: "b" } });
		await db.create({ model: "claw", data: { id: "c3", organizationId: "a" } });

		const selected = (await db.findOne({
			model: "claw",
			select: ["organizationId", "context"],
			where: [{ field: "id", value: "c2" }],
		})) as Partial<FieldClaw> | null;
		expect(selected).toEqual({
			context: { source: "default" },
			organizationId: "b",
		});

		const sorted = (await db.findMany({
			model: "claw",
			sortBy: { field: "organizationId", direction: "asc" },
		})) as FieldClaw[];
		expect(sorted.map((row) => row.organizationId)).toEqual(["a", "b"]);
		expect(
			await db.count({
				model: "claw",
				where: [{ field: "organizationId", value: "a" }],
			}),
		).toBe(1);

		const updated = (await db.update({
			model: "claw",
			where: [{ field: "organizationId", value: "a" }],
			update: { context: { patched: true } },
		})) as FieldClaw | null;
		expect(updated?.context).toEqual({ patched: true });
		expect(updated?.updatedAt).toBe("updated");

		const row = (await raw.findOne({
			model: "euroclaw_claw",
			where: [{ field: "organization_id", value: "a" }],
		})) as Record<string, unknown> | null;
		expect(row?.context).toBe(JSON.stringify({ patched: true }));
		expect(row?.updatedAt).toBe("updated");
	});

	it("lets explicit update values win over onUpdate", async () => {
		const db = schemaAdapter(memoryAdapter(), fieldSchema);
		await db.create({
			model: "claw",
			data: { id: "c4", organizationId: "t4" },
		});

		const updated = (await db.update({
			model: "claw",
			where: [{ field: "id", value: "c4" }],
			update: { updatedAt: "manual" },
		})) as FieldClaw | null;

		expect(updated?.updatedAt).toBe("manual");
	});

	it("rejects missing required fields, unknown fields, immutable fields, and invalid JSON", async () => {
		const db = schemaAdapter(memoryAdapter(), fieldSchema);

		await expect(
			db.create({ model: "claw", data: { id: "missing-organization" } }),
		).rejects.toThrow(/organizationId.*required/);
		await expect(
			db.create({
				model: "claw",
				data: { id: "bad-field", organizationId: "t", unknown: true },
			}),
		).rejects.toThrow(/unknown field/);
		await expect(
			db.update({
				model: "claw",
				where: [{ field: "id", value: "bad-field" }],
				update: { locked: "new" },
			}),
		).rejects.toThrow(/immutable/);
		await expect(
			db.create({
				model: "claw",
				data: { context: () => undefined, id: "bad-json", organizationId: "t" },
			}),
		).rejects.toThrow(/JSON-serializable/);
	});

	it("keeps transactions schema-aware", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);

		await db.transaction?.(async (tx) => {
			await tx.create({
				model: "claw",
				data: { id: "tx1", organizationId: "t" },
			});
		});

		expect(await raw.count({ model: "euroclaw_claw" })).toBe(1);
		await expect(
			db.transaction?.(async (tx) => {
				await tx.create({
					model: "claw",
					data: { id: "tx2", organizationId: "t" },
				});
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(
			await raw.findOne({
				model: "euroclaw_claw",
				where: [{ field: "id", value: "tx2" }],
			}),
		).toBeNull();
	});

	it("maps consumeOne and decodes the returned row", async () => {
		const raw = memoryAdapter();
		const db = schemaAdapter(raw, fieldSchema);
		await db.create({
			model: "claw",
			data: { id: "consume", organizationId: "t" },
		});

		const consumed = (await db.consumeOne({
			model: "claw",
			where: [{ field: "organizationId", value: "t" }],
		})) as FieldClaw | null;

		expect(consumed?.context).toEqual({ source: "default" });
		expect(consumed?.organizationId).toBe("t");
		expect(await raw.count({ model: "euroclaw_claw" })).toBe(0);
	});
});

describe("where trees, operators, and multi-sort", () => {
	const seed = async (db: Adapter) => {
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
		for (const row of rows) await db.create({ model: "resource", data: row });
	};
	const ids = (rows: unknown[]) => (rows as { id: string }[]).map((r) => r.id);

	it("expresses the shareable-resource union — (personal AND mine) OR (org AND my org)", async () => {
		const db = a();
		await seed(db);
		const rows = await db.findMany({
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
		expect(ids(rows)).toEqual(["r1", "r2"]);
	});

	it("expresses keyset pagination — groups + multi-column sort", async () => {
		const db = a();
		await seed(db);
		// page after cursor (seq=2, id="r2"), ordered by (seq asc, id asc)
		const rows = await db.findMany({
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
		expect(ids(rows)).toEqual(["r3", "r4"]);
	});

	it("not_in, with fixed empty-list semantics (in [] none, not_in [] all)", async () => {
		const db = a();
		await seed(db);
		const notPersonal = await db.findMany({
			model: "resource",
			where: [{ field: "scope", operator: "not_in", value: ["personal"] }],
		});
		expect(ids(notPersonal).sort()).toEqual(["r2", "r3"]);
		expect(
			await db.findMany({
				model: "resource",
				where: [{ field: "scope", operator: "in", value: [] }],
			}),
		).toEqual([]);
		expect(
			(
				await db.findMany({
					model: "resource",
					where: [{ field: "scope", operator: "not_in", value: [] }],
				})
			).length,
		).toBe(4);
	});

	it("starts_with / ends_with, and pattern values match literally (no wildcard smuggling)", async () => {
		const db = a();
		await seed(db);
		expect(
			ids(
				await db.findMany({
					model: "resource",
					where: [{ field: "name", operator: "starts_with", value: "Bet" }],
				}),
			),
		).toEqual(["r3"]);
		expect(
			ids(
				await db.findMany({
					model: "resource",
					where: [{ field: "name", operator: "ends_with", value: "ta" }],
				}),
			),
		).toEqual(["r3"]);
		// "%" in the value is a literal character, never a wildcard
		expect(
			ids(
				await db.findMany({
					model: "resource",
					where: [{ field: "name", operator: "contains", value: "a%x" }],
				}),
			),
		).toEqual(["r2"]);
	});

	it("mode: insensitive folds string equality and patterns", async () => {
		const db = a();
		await seed(db);
		expect(
			ids(
				await db.findMany({
					model: "resource",
					where: [{ field: "name", value: "BETA", mode: "insensitive" }],
				}),
			),
		).toEqual(["r3"]);
		const rows = await db.findMany({
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
		expect(ids(rows)).toEqual(["r2", "r3"]);
	});

	it("multi-column sort: first non-tie wins", async () => {
		const db = a();
		await seed(db);
		const rows = await db.findMany({
			model: "resource",
			sortBy: [
				{ field: "seq", direction: "desc" },
				{ field: "id", direction: "asc" },
			],
		});
		expect(ids(rows)).toEqual(["r4", "r2", "r3", "r1"]);
	});

	it("an empty group fails loud — never a silent match-all or match-none", async () => {
		const db = a();
		await seed(db);
		await expect(
			db.findMany({ model: "resource", where: [{ or: [] }] }),
		).rejects.toThrow(/where group is empty/);
	});
});
