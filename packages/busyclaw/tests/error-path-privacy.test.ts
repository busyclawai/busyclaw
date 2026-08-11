/**
 * WHAT HAPPENS WHEN A TOOL THROWS.
 *
 * This file started as a leak hunt and found something else, so it says both.
 *
 * THE LEAK IS NOT THERE — asserted below as a passing control rather than deleted, because "we
 * checked and the seam holds" is worth as much as a finding and costs one test. A tool that fails
 * names a person in its error message (`contact lookup failed for alice@…` is what a real API client
 * throws), and that address never passed through the redactor on the way in, because the redactor is
 * on the RETURN path. It is nevertheless tokenized before anything durable records it: the raw value
 * reaches exactly one table, the one whose job is to be destroyable.
 *
 * WHAT IS THERE ARE TWO OTHER THINGS, both on the same ordinary path — a tool raising an exception.
 * Neither is exotic. Every tool that talks to a network throws sometimes.
 */

import type { Adapter, ToolDefinition } from "@busyclaw/contracts";
import { govern, userPrincipal } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { emailDetector, lookupToolModel, withPrincipal } from "./fixtures";

const ACTOR = userPrincipal("actor-1");
/** Born in the tool's world, never in a message — nothing upstream of the tool could have tokenized it. */
const SECRET = "alice@personal.com";

/**
 * A tool whose upstream failed and said which record it failed on.
 *
 * The mundane shape: an HTTP client that puts the response body in the message, a driver that echoes
 * the row it could not write, a validation error quoting the offending value. A plain `Error`, which
 * is what the overwhelming majority of tools throw.
 */
function throwingLookupTool(email: string): ToolDefinition {
	return govern(
		tool({
			description: "Look up a contact.",
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
			}),
			// The return type is annotated because a body that only throws infers `Promise<never>`,
			// which is not a shape `tool()` can build a result schema from. Declaring what it WOULD
			// have returned keeps this identical to `lookupTool` in every respect but the throw.
			execute: async (): Promise<{ email: string }> => {
				throw new Error(`contact lookup failed for ${email}`);
			},
		}),
		{ access: "read" },
	);
}

/** Which of this claw's tables hold `needle`, out of ALL of them. Same helper, and same argument, as
 *  `prompt-privacy.test.ts`: asserting table by table only tests the tables somebody thought of. */
async function tablesHolding(
	db: Adapter,
	claw: { $tables: unknown },
	needle: string,
): Promise<string[]> {
	const models = Object.keys(claw.$tables as Record<string, unknown>);
	const hits = await Promise.all(
		models.map(async (model) => {
			try {
				const rows = await db.findMany({ model, where: [] });
				return JSON.stringify(rows).includes(needle) ? model : null;
			} catch {
				return null;
			}
		}),
	);
	return hits.filter((model): model is string => model !== null).sort();
}

async function failedTurn() {
	const db = memoryAdapter();
	// `indexKey` IS THE DEDUP, and it is configured here rather than taken from the shared
	// `durableRedactor` fixture, which sets none.
	//
	// Without it `createStoredRedactor` has no `originalHash` to look a value up by, so it skips
	// `findByHash` and mints a fresh placeholder for every occurrence — documented behaviour, warned
	// about at construction, and the reason the coreference case below is worth running at all. The
	// four surfaces `redaction-ingress.test.ts` already covers configure it (`indexKey: "test-key"`);
	// a test of the fifth that did not would be measuring its own setup.
	const redactor = createStoredRedactor({
		detector: emailDetector,
		mappings: createPiiMappingStore(db),
		indexKey: "test-key",
	});
	const claw = createClaw({
		database: db,
		model: lookupToolModel(),
		redaction: { redactor },
		tools: { lookup: throwingLookupTool(SECRET) },
	});
	const api = withPrincipal(claw, ACTOR).api;
	await api.createClaw({ id: "claw-1", name: "Assistant" });
	await api.createThread({ id: "thread-1", clawId: "claw-1", title: "Chat" });
	try {
		await api.sendMessage({
			clawId: "claw-1",
			message: "look up the contact",
			threadId: "thread-1",
		});
	} catch {
		// The tool threw and the turn ended. What was WRITTEN on the way is the subject.
	}
	return { claw, db };
}

describe("a tool that throws", () => {
	it("records the TOOL's failure, not an internal schema-validation failure", async () => {
		// THE DEFECT. What the task's `lastError` actually holds after a tool raises a plain `Error`:
		//
		//   [BUSYCLAW_VALIDATION_FAILED] create tool result input invalid: error must be valid
		//   according to an anonymous predicate (was {"message":"contact lookup failed for
		//   {{pii:email:…}}","name":"Error","reasonCode":"undefined"})
		//
		// Read `"reasonCode":"undefined"` — the STRING, not the value. `errorEventPayload`
		// (`ai-sdk-loop.ts:293`) builds `{ message, name, reasonCode: undefined }`, present-and-
		// undefined rather than absent. The runtime event schema tolerates that (`events.ts:43`
		// declares `"reasonCode?": "string | undefined"`), so it survives; then the redactor walks the
		// object on its way to storage and the absent-ish value becomes the literal `"undefined"`;
		// then `createToolResult` (`storage/durable/src/claws.ts:77`) validates the `error` field
		// against a schema that has no reading of that and refuses the write.
		//
		// So the tool's failure is never recorded AS a tool failure. The run fails with an internal
		// error about busyclaw's own schema, naming a field the tool author has never heard of. This
		// codebase has already made exactly this distinction once, deliberately — `engine-sql.test.ts`
		// has a case for storing "a DENIED result, whose optional fields are ABSENT rather than
		// present-and-undefined". This is the same shape, on the path nobody wrote that case for.
		//
		// It also spends the run's error budget: the task comes back `attempt: 1, errorAttempt: 1` of
		// `maxAttempts: 3` with a retry scheduled, so the run re-drives and fails identically twice
		// more before dead-lettering. Three model calls paid for one unrecordable error.
		const { db } = await failedTurn();

		// The engine's own bookkeeping must not be where the tool's error goes — `lastError` is
		// deliberately an opaque `internal error [<correlation-id>]`, which is the codebase's existing
		// answer to "one audience gets the handle, another gets the detail". What it must not be is a
		// complaint about busyclaw's own record schema.
		const tasks = (await db.findMany({
			model: "runtime_task",
			where: [],
		})) as { lastError?: string }[];
		const taskErrors = tasks.map((t) => t.lastError ?? "").join("\n");
		expect(taskErrors).not.toContain("BUSYCLAW_VALIDATION_FAILED");

		// And the detail has to have LANDED somewhere, or "recorded the failure" is not a claim about
		// anything. `tool_result` is that somewhere: the row the transcript and any operator UI read.
		const results = (await db.findMany({
			model: "tool_result",
			where: [],
		})) as { status?: string; error?: string }[];
		expect(results).toHaveLength(1);
		expect(results[0]?.status).toBe("failed");
		expect(String(results[0]?.error)).toContain("contact lookup failed");
	}, 60000);

	it("mints ONE token for one address, the way every other ingress does", async () => {
		// `redaction-ingress.test.ts:104` states the invariant as its own title — "one value, one
		// token — across run.started, tool.completed, prompt, and final text" — and proves it on those
		// four surfaces. The error path is a fifth, and it mints a fresh placeholder per redaction
		// call: one address, redacted three times in a single turn, produces three unrelated
		// placeholders (observed: `sixties-banshee-…` in the effect row, `yearbook-negation-…` in the
		// task's `lastError`, and a third in between).
		//
		// Why it is worth a test rather than a shrug. Coreference is the entire point of a stable
		// placeholder: an operator reading the audit, or a model reading the transcript, is supposed
		// to be able to tell that two mentions are the same person. Three tokens say they are three
		// people. And the row count is not cosmetic either — every mapping is a copy of the original
		// held against the day somebody asks for erasure.
		const { db } = await failedTurn();

		const mappings = (await db.findMany({
			model: "pii_mapping",
			where: [],
		})) as { placeholder: string; original: string }[];
		const forSecret = new Set(
			mappings.filter((m) => m.original === SECRET).map((m) => m.placeholder),
		);
		expect(forSecret.size).toBe(1);
	}, 60000);

	it("keeps the raw address out of every table but the destroyable one (the control)", async () => {
		// The hypothesis this file was opened to test, kept as a control now that it holds. The loop
		// redacts the thrown error before anything durable sees it, so the address is confined to
		// `pii_mapping` exactly as a tool RESULT would be — the throw path is not a hole in erasure.
		//
		// Worth keeping rather than deleting: it is the assertion that would fail if somebody later
		// "simplified" the error path by persisting `err.message` directly, which is what the SQL
		// worker's own `errorMessage(error)` — `err.message`, verbatim — would do with an error that
		// had not already been redacted upstream.
		const { claw, db } = await failedTurn();
		expect(await tablesHolding(db, claw, SECRET)).toEqual(["pii_mapping"]);
	}, 60000);
});
