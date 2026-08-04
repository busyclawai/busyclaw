// The Mongo index generator, against a REAL mongod.
//
// Mongo is the adapter where "did it emit the right text" proves least: there is no DDL to eyeball
// and no schema for a validator to reject, so a wrong index specification looks perfectly fine
// right up until a duplicate slips through. The assertions that matter are therefore behavioural —
// apply the indexes, then try to violate them.

import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateMongoIndexes, mongoIndexes } from "../src/generate";

const SCHEMA = {
	claw: {
		fields: {
			id: { type: "string", required: true, primaryKey: true },
			createdBy: { type: "string", required: true, index: true },
			slug: { type: "string", required: true, unique: true },
		},
	},
	pii_mapping: {
		uniques: [["scope", "scopeId", "placeholder"]],
		fields: {
			id: { type: "string", required: true, primaryKey: true },
			scope: { type: "string", required: true },
			scopeId: { type: "string", required: true, fieldName: "scope_id" },
			placeholder: { type: "string", required: true },
		},
	},
	dedup: {
		// The shape the redaction vault's dedup constraint has: the value identifier is OPTIONAL,
		// because a keyless redactor cannot compute it and falls back to minting fresh placeholders.
		uniques: [["scope", "originalHash"]],
		fields: {
			id: { type: "string", required: true, primaryKey: true },
			scope: { type: "string", required: true },
			originalHash: { type: "string" },
		},
	},
} as const;

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
	server = await MongoMemoryServer.create();
	client = new MongoClient(server.getUri());
	await client.connect();
	db = client.db("busyclaw_test");
}, 120_000);

afterAll(async () => {
	await client?.close();
	await server?.stop();
});

/** Apply the generated specs the way the emitted script would — EVERY option, not a chosen subset.
 *  Dropping one here would test a different index than the one the generator describes, which is
 *  exactly what happened while writing this: the helper silently omitted the partial filter and the
 *  live assertion failed against an index the generator never asked for. */
async function applyIndexes(): Promise<void> {
	for (const spec of mongoIndexes(SCHEMA as never)) {
		await db.collection(spec.collection).createIndex(spec.keys, {
			name: spec.name,
			unique: spec.unique,
			...(spec.partialFilterExpression !== undefined
				? { partialFilterExpression: spec.partialFilterExpression }
				: {}),
		});
	}
}

describe("mongoIndexes", () => {
	it("turns a declared primary key into a UNIQUE index, not _id", () => {
		// busyclaw rows carry their own `id` and the adapter strips Mongo's `_id`, so `_id` is an
		// unrelated ObjectId — the declared key has to be enforced by an index or not at all.
		const specs = mongoIndexes(SCHEMA as never);
		expect(specs).toContainEqual(
			expect.objectContaining({
				collection: "claw",
				keys: { id: 1 },
				unique: true,
			}),
		);
	});

	it("turns a composite unique into ONE compound index, using physical column names", () => {
		const specs = mongoIndexes(SCHEMA as never);
		const compound = specs.find(
			(s) => s.name === "pii_mapping_scope_scope_id_placeholder_uq",
		);
		// `scopeId` maps to `scope_id`; an index over the declaration key would silently index nothing.
		expect(compound?.keys).toEqual({ scope: 1, scope_id: 1, placeholder: 1 });
		expect(compound?.unique).toBe(true);
	});

	it("does not re-index a key column that the primary-key index already covers", () => {
		const specs = mongoIndexes(SCHEMA as never);
		expect(
			specs.filter((s) => s.collection === "claw" && "id" in s.keys),
		).toHaveLength(1);
	});

	it("guards a unique index over an OPTIONAL column with a partial filter", () => {
		const specs = mongoIndexes(SCHEMA as never);
		const dedup = specs.find((s) => s.name === "dedup_scope_originalHash_uq");
		expect(dedup?.partialFilterExpression).toEqual({
			originalHash: { $exists: true },
		});
		// A constraint whose columns are all required needs no guard.
		const pk = specs.find((s) => s.name === "claw_id_pk");
		expect(pk?.partialFilterExpression).toBeUndefined();
	});

	it("emits a runnable, self-describing script", () => {
		const script = generateMongoIndexes({ schema: SCHEMA as never });
		expect(script).toContain('db.getCollection("claw").createIndex(');
		expect(script).toContain('"unique":true');
		expect(script).toContain("mongosh");
	});
});

describe("the generated indexes against a real mongod", () => {
	it("the composite unique REFUSES a duplicate and allows a different container", async () => {
		await applyIndexes();
		const mappings = db.collection("pii_mapping");

		const row = {
			scope: "claw",
			scope_id: "c1",
			placeholder: "{{pii:email:x}}",
		};
		await mappings.insertOne({ id: "a", ...row });
		// Same containerKind, same placeholder — the constraint the redaction vault actually wants.
		await expect(mappings.insertOne({ id: "b", ...row })).rejects.toThrow();
		// A namesake token in ANOTHER container is a different mapping, and must still insert.
		await expect(
			mappings.insertOne({ ...row, id: "c", scope_id: "c2" }),
		).resolves.toBeDefined();
	}, 60_000);

	it("the primary-key index refuses a duplicate id", async () => {
		await applyIndexes();
		const claws = db.collection("claw");
		await claws.insertOne({ id: "claw-1", createdBy: "user:a", slug: "one" });
		await expect(
			claws.insertOne({ id: "claw-1", createdBy: "user:b", slug: "two" }),
		).rejects.toThrow();
	}, 60_000);

	it("matches SQL nulls-are-distinct: several rows may omit the optional column", async () => {
		// The divergence this guards. Postgres and SQLite treat NULLs as distinct in a unique index,
		// so any number of rows may leave the column empty. Mongo counts a missing field as null and
		// allows exactly ONE such document — so without the partial filter the SECOND keyless row in
		// a container is rejected here and accepted everywhere else.
		await applyIndexes();
		const dedup = db.collection("dedup");

		await dedup.insertOne({ id: "a", scope: "claw" });
		await expect(
			dedup.insertOne({ id: "b", scope: "claw" }),
		).resolves.toBeDefined();

		// Uniqueness is still real for rows that DO carry the value.
		await dedup.insertOne({ id: "c", scope: "claw", originalHash: "h1" });
		await expect(
			dedup.insertOne({ id: "d", scope: "claw", originalHash: "h1" }),
		).rejects.toThrow();
	}, 60_000);

	it("is idempotent — applying twice is a no-op", async () => {
		await applyIndexes();
		await expect(applyIndexes()).resolves.toBeUndefined();
	}, 60_000);
});

describe("a real Mongo duplicate-key error is recognised as a conflict", () => {
	// The normalizer in @busyclaw/storage-core claims Mongo says "already exists" with code 11000.
	// That claim is checked HERE, where a real mongod can raise it, rather than against a hand-built
	// object shaped the way the documentation describes.
	it("isUniqueViolation sees E11000, and asConflict names the key", async () => {
		const { asConflict, isUniqueViolation } = await import(
			"@busyclaw/storage-core"
		);
		await applyIndexes();
		const claws = db.collection("claw");

		await claws.insertOne({ id: "dup-1", createdBy: "user:a", slug: "s1" });
		const raised = await claws
			.insertOne({ id: "dup-1", createdBy: "user:b", slug: "s2" })
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(raised).toBeDefined();
		expect(isUniqueViolation(raised)).toBe(true);
		const conflict = asConflict(raised, { model: "claw" });
		expect(conflict?.code).toBe("BUSYCLAW_CONFLICT");
		// Mongo reports the offending key pattern; that is what tells you WHICH index refused.
		expect(conflict?.details?.constraint).toBe("id");
	}, 60_000);
});
