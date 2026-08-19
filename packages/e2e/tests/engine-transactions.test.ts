/**
 * WHICH STORES CAN CARRY A DURABLE RUN, AND WHY MONGO IS NOT ONE OF THEM.
 *
 * The e2e factory offers `memory` and `sqlite` and stops there. That looks like an unfinished axis
 * and is not: `createSqlEngineStore` requires a transactional adapter, and `mongoAdapter` implements
 * no `transaction` at all — so a Mongo-backed claw cannot exist, whatever the scenarios above ask of
 * it. The engine is called `engine-sql` and it says what it needs.
 *
 * This is pinned rather than left as a comment because it is exactly the kind of boundary that gets
 * softened by accident. Someone adding a best-effort `transaction` to the Mongo adapter — one that
 * runs the callback without a real session — would satisfy the check and hand the engine a
 * compare-and-set that cannot actually fence anything, which is the failure mode the lease and the
 * claim CAS exist to prevent. The check failing LOUD at construction is the feature.
 *
 * Asserted against the real `mongoAdapter` and a stand-in `Db`: the adapter touches nothing at
 * construction, so this needs no running mongod to say something true about the shipped adapter.
 */

import { BusyclawError } from "@busyclaw/contracts";
import { createSqlEngineStore } from "@busyclaw/engine-sql";
import { memoryAdapter } from "@busyclaw/storage-core";
import { mongoAdapter } from "@busyclaw/storage-mongodb";
import type { Db } from "mongodb";
import { expect, it } from "vitest";

/** Enough of a `Db` to construct the adapter; nothing here is ever called. */
const unusedDb = { collection: () => ({}) } as unknown as Db;

it("refuses to build an engine over an adapter with no transaction", () => {
	const adapter = mongoAdapter(unusedDb);
	expect(adapter.transaction).toBeUndefined();

	try {
		createSqlEngineStore(adapter);
		throw new Error("expected the engine to refuse this adapter");
	} catch (error) {
		// A CONFIGURATION error, not a runtime one — the deployment is wrong, and it is wrong before
		// any request arrives, which is the only moment this can be cheaply fixed.
		expect(error).toBeInstanceOf(BusyclawError);
		expect((error as BusyclawError).code).toBe("BUSYCLAW_CONFIGURATION_ERROR");
		expect(String(error)).toContain("transactional");
	}
});

it("builds over an adapter that has one", () => {
	// The control. Without it the refusal above would pass against an engine that refuses everything,
	// which is a different bug wearing the same colours.
	const adapter = memoryAdapter();
	expect(adapter.transaction).toBeDefined();
	expect(() => createSqlEngineStore(adapter)).not.toThrow();
});
