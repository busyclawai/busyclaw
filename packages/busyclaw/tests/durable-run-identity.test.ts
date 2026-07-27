import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { describe, expect, it } from "vitest";
import { durableRedactor, owned, textModel } from "./fixtures";

// A durable run executes its tool calls under the run row's principal, so whoever writes that column
// chooses the identity the work runs as. The column used to be an input field, documented as
// "caller-supplied … for attribution" — true right up until the worker started authorizing with it.
//
// This is the assertion that was missing when the stamping landed: the commit claimed the body cannot
// choose, and nothing checked it.
describe("a durable run's identity", () => {
	it("comes from the authenticated caller, never the request body", async () => {
		const { db, redactor } = durableRedactor();
		const store = createSqlEngineStore(db);
		const claw = owned({
			cronHandler: { secret: "s3cret" },
			database: db,
			engine: sqlEngine({ store, workerId: "w1" }),
			model: textModel("done"),
			redaction: { redactor },
		});
		// `owned()` binds user:actor-1. The body tries to claim someone else.
		const run = await claw.api.startRun({
			prompt: "hi",
			run: { principal: "user:admin" } as never,
		});
		const record = await claw.api.getRun(
			{ id: run.id },
			{ principal: "user:actor-1" },
		);
		// `owned()` binds user:actor-1; the body asked for user:admin and does not get it.
		expect(record?.principal).toBe("user:actor-1");
		// And the forged value is nowhere on the row — not stored, not shadowed.
		expect(JSON.stringify(record)).not.toContain("user:admin");
	});
});
