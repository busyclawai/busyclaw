/**
 * The shared where/sort conformance suite, run against a real MongoDB.
 *
 * The non-SQL member of the set, and the one whose disagreements are the most interesting: Mongo's
 * answers to the null questions match the MEMORY adapter rather than the SQL ones, so this run is
 * what turns "memory is wrong" into the more careful claim the repo actually has to deal with —
 * the protocol never decided, and the backends split 3-vs-2.
 */

import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll } from "vitest";
import { describeWhereConformance } from "../../core/tests/kit/where-conformance";
import { mongoAdapter } from "../src/index";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
	mongod = await MongoMemoryServer.create();
	client = new MongoClient(mongod.getUri());
	await client.connect();
	db = client.db("busyclaw_conformance");
}, 120000);

afterAll(async () => {
	await client?.close();
	await mongod?.stop();
});

describeWhereConformance("mongodb", {
	adapter: () => mongoAdapter(db),
	backend: "mongodb",
	reset: async () => {
		for (const c of ["approval", "audit"])
			await db.collection(c).deleteMany({});
	},
});
