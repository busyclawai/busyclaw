// R-H12, Mongo half — against a REAL mongod, because the whole failure mode is behavioural.
//
// Mongo has no DDL and no migrator: `mongoIndexes()` emits a script an operator is expected to run,
// and nothing checked whether they had. A collection missing a unique index does not fail, it accepts
// the duplicate — so the constraint busyclaw's stores depend on was, on Mongo, a document somebody
// was trusted to have read.
//
// That dependency is not incidental: effect ids are DETERMINISTIC, so two processes replaying the
// same run derive the same id and the unique index is the entire mechanism that makes the second one
// lose. The first test here is that failure, reproduced.

import { verifiedAdapter } from "@busyclaw/storage-core";
import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mongoIndexes } from "../src/generate";
import { mongoAdapter } from "../src/index";
import { missingMongoIndexes, requiredMongoIndexes } from "../src/verify";

const SCHEMA = {
	effect: {
		fields: {
			id: { type: "string", required: true, primaryKey: true },
			// A plain index, so the required-set is genuinely a SUBSET and the filter has something to
			// remove. Without one every emitted index is unique and the assertion below tests nothing.
			status: { type: "string", required: true, index: true },
		},
	},
	pii_mapping: {
		uniques: [["scope", "scopeId", "placeholder"]],
		fields: {
			id: { type: "string", required: true, primaryKey: true },
			scope: { type: "string", required: true },
			scopeId: { type: "string", required: true },
			placeholder: { type: "string", required: true },
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
	db = client.db("verify");
}, 120_000);

afterAll(async () => {
	await client.close();
	await server.stop();
});

beforeEach(async () => {
	for (const name of ["effect", "pii_mapping"]) {
		await db
			.collection(name)
			.drop()
			.catch(() => undefined);
	}
});

/** Apply what the generator says an operator should run. */
async function applyIndexes(): Promise<void> {
	for (const spec of mongoIndexes(SCHEMA)) {
		await db.collection(spec.collection).createIndex(spec.keys, {
			name: spec.name,
			unique: spec.unique,
			...(spec.partialFilterExpression
				? { partialFilterExpression: spec.partialFilterExpression }
				: {}),
		});
	}
}

describe("missingMongoIndexes", () => {
	it("reproduces the failure: without the script, a deterministic effect id duplicates", async () => {
		// No indexes applied — the state of any deployment whose operator skipped the script.
		await db
			.collection("effect")
			.insertOne({ id: "run:abc", status: "claimed" });
		await db
			.collection("effect")
			.insertOne({ id: "run:abc", status: "claimed" });
		// Two rows, one id, no error anywhere. Both processes believe they claimed the effect.
		expect(
			await db.collection("effect").countDocuments({ id: "run:abc" }),
		).toBe(2);
	});

	it("reports exactly the required uniques a collection lacks", async () => {
		await db.collection("effect").insertOne({ id: "seed", status: "x" });
		const missing = await missingMongoIndexes(db, SCHEMA);
		expect(missing.map((index) => index.collection)).toEqual(["effect"]);
		expect(Object.keys(missing[0]?.keys ?? {})).toEqual(["id"]);
	});

	it("reports nothing once the script has been run", async () => {
		await applyIndexes();
		expect(await missingMongoIndexes(db, SCHEMA)).toEqual([]);
	});

	it("a collection that does not exist yet is not missing anything", async () => {
		// Mongo creates collections on first write, so a fresh deployment has none — refusing there
		// would refuse every new install. The index is required before the collection holds data.
		expect(await missingMongoIndexes(db, SCHEMA)).toEqual([]);
	});

	it("accepts an equivalent index under a DIFFERENT name", async () => {
		// Compared on KEYS, not names: an operator who created the constraint by hand, or through a
		// tool that names indexes its own way, has the enforcement busyclaw needs. Refusing over a
		// label would be refusing over nothing.
		await db.collection("effect").insertOne({ id: "seed", status: "x" });
		await db
			.collection("effect")
			.createIndex({ id: 1 }, { name: "someone_elses_name", unique: true });
		expect(await missingMongoIndexes(db, SCHEMA)).toEqual([]);
	});

	it("a NON-unique index over the same keys does not count", async () => {
		// It does not reject the duplicate, which is the only thing being asked about here.
		await db.collection("effect").insertOne({ id: "seed", status: "x" });
		await db.collection("effect").createIndex({ id: 1 }, { name: "just_fast" });
		expect((await missingMongoIndexes(db, SCHEMA)).length).toBe(1);
	});

	it("only UNIQUE indexes are required — a missing plain index is not a refusal", () => {
		// A missing non-unique index is a performance problem an operator finds and fixes at leisure;
		// a missing unique one is duplicated side effects. Mixing them would make the refusal easy to
		// dismiss, which is how a fail-closed check stops working.
		const required = requiredMongoIndexes(SCHEMA);
		expect(required.every((spec) => spec.unique)).toBe(true);
		expect(required.length).toBeLessThan(mongoIndexes(SCHEMA).length);
	});
});

// The adapter exposes the CHECK; `verifiedAdapter` in the assembly decides when to run it. These
// drive the pair the way busyclaw does, because that composition is what actually ships — the adapter
// alone no longer verifies anything on its own, deliberately: only the assembly holds the merged
// declaration (core models plus every plugin and host extension), and a check asked about the base
// models would pass while the extensions went unprotected.
describe("the adapter refuses to write into an unprotected database", () => {
	const guarded = (target: Db = db) =>
		verifiedAdapter(mongoAdapter(target), SCHEMA as never);

	it("throws, naming the missing index — and does NOT insert", async () => {
		await db.collection("effect").insertOne({ id: "seed", status: "x" });
		const adapter = guarded();
		await expect(
			adapter.create({
				model: "effect",
				data: { id: "run:abc", status: "claimed" },
			}),
		).rejects.toThrow(/missing 1 required unique index/);
		expect(
			await db.collection("effect").countDocuments({ id: "run:abc" }),
		).toBe(0);
	});

	it("recovers without a restart once the index exists", async () => {
		await db.collection("effect").insertOne({ id: "seed", status: "x" });
		const adapter = guarded();
		await expect(
			adapter.create({ model: "effect", data: { id: "a", status: "x" } }),
		).rejects.toThrow();
		// A FAILED check is not memoized — an operator who creates the index should not have to bounce
		// the process to be believed.
		await applyIndexes();
		await expect(
			adapter.create({ model: "effect", data: { id: "a", status: "x" } }),
		).resolves.toBeDefined();
	});

	it("the RAW adapter still writes — the check is the assembly's to run", async () => {
		// The capability is exposed, not self-invoked. A host using the adapter directly gets the old
		// behaviour and can call `assertMongoIndexes` itself; busyclaw's assembly wraps it so the safe
		// path is the one nobody has to remember.
		await db.collection("effect").insertOne({ id: "seed", status: "x" });
		await expect(
			mongoAdapter(db).create({
				model: "effect",
				data: { id: "b", status: "x" },
			}),
		).resolves.toBeDefined();
	});

	it("an adapter with no verifySchema is returned UNCHANGED", () => {
		const plain = { id: "plain" } as never;
		expect(verifiedAdapter(plain, SCHEMA as never)).toBe(plain);
	});

	it("verifies ONCE across many writes", async () => {
		await applyIndexes();
		let listed = 0;
		const counting = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === "listCollections") listed++;
				return Reflect.get(target, prop, receiver);
			},
		}) as Db;
		const adapter = guarded(counting);
		for (let i = 0; i < 5; i++) {
			await adapter.create({
				model: "effect",
				data: { id: `n${i}`, status: "x" },
			});
		}
		expect(listed).toBe(1);
	});
});
