/**
 * SCENARIO — two people's addresses enter a turn by different doors, and neither escapes.
 *
 * PII reaches a run two ways, and they are redacted by different seams. One arrives in the USER'S
 * MESSAGE, which the api tokenizes before a run exists. The other is born INSIDE the run, in a tool
 * result — world data the redactor never saw on the way in, handled by the runtime instead. A test
 * that only exercises one door proves nothing about the other, and the seams are in different
 * packages.
 *
 * The sweep is "which tables hold this", over ALL of them, because asserting table by table only
 * tests the tables somebody thought of. Exactly one table is allowed to hold the original: the one
 * whose whole job is to be destroyed.
 */

import type { PiiSpan } from "@busyclaw/contracts";
import { govern } from "@busyclaw/contracts";
import { jsonSchema, tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { script } from "../src/model";
import { type Backend, type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

/** The person who wrote in. */
const CUSTOMER = "alice@personal.com";
/** The person the tool looked up — never in any message, so only the runtime seam can catch it. */
const CONTACT = "bob@corp.com";

const emailDetector = (text: string): PiiSpan[] => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+\.\w+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		spans.push({
			start: match.index ?? 0,
			end: (match.index ?? 0) + value.length,
			kind: "email",
			source: "regex",
			value,
		});
	}
	return spans;
};

const BACKENDS: Backend[] = ["memory", "sqlite"];

describe.each(BACKENDS)("pii journey — %s", (database) => {
	it("keeps both addresses out of every table but the destroyable one", async () => {
		const w = await world({
			database,
			detector: emailDetector,
			indexKey: "e2e-key",
			model: script([
				{ tool: "directory", args: {} },
				{ text: "I have passed it on." },
			]),
			tools: {
				directory: govern(
					tool({
						description: "Look up the account contact.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						// Born in the tool's world — nothing upstream could have tokenized it.
						execute: async () => ({ contact: CONTACT }),
					}),
					{ access: "read" },
				),
			},
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w.api.createThread({
			id: "thread-1",
			clawId: "claw-1",
			title: "Chat",
		});
		await w.api.sendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			message: `my address is ${CUSTOMER}, who is my contact?`,
		});
		await w.settle();

		expect(await w.tablesHolding(CUSTOMER)).toEqual(["pii_mapping"]);
		expect(await w.tablesHolding(CONTACT)).toEqual(["pii_mapping"]);
	});

	it("gives one address one placeholder, however many times it appears", async () => {
		// Coreference is the whole point of a stable placeholder: an operator reading the audit, or a
		// model reading the transcript, has to be able to tell that two mentions are the same person.
		// The customer's address appears in the message AND in the answer, through two different
		// seams — if they mint separately, the transcript says two people.
		const w = await world({
			database,
			detector: emailDetector,
			indexKey: "e2e-key",
			model: script([{ text: `Noted, I will write to ${CUSTOMER}.` }]),
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w.api.createThread({
			id: "thread-1",
			clawId: "claw-1",
			title: "Chat",
		});
		await w.api.sendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			message: `write to ${CUSTOMER} please`,
		});
		await w.settle();

		const mappings = await w.rows("pii_mapping");
		const placeholders = new Set(
			mappings
				.filter((row) => row.original === CUSTOMER)
				.map((row) => row.placeholder),
		);
		expect(placeholders.size).toBe(1);
	});
});
