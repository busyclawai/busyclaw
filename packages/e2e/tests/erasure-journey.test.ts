/**
 * SCENARIO — somebody asks to be forgotten, and the answer has to be true.
 *
 * Erasure here is crypto-shredding: `forgetSubject` destroys the MAPPINGS, so every placeholder that
 * pointed at a person stops resolving. That works precisely because there is exactly one copy of the
 * original, behind a key — which is what the PII journey scenario asserts. This one asserts the other
 * half: that destroying the key actually reaches it.
 *
 * It has one blind spot and the blind spot is total. Text that was never tokenized has no mapping to
 * shred, and a mapping linked to NOBODY cannot be found by subject. `appendMessage` says so in its own
 * doc — "Omitted ⇒ the mappings are linked to nobody and erasure cannot find them" — so both halves
 * are pinned here: the DSR that works, and the one that silently does not.
 *
 * The sweep is over every table, because a completed DSR is a statement about everywhere, and
 * asserting table by table only tests the tables somebody thought of.
 */

import type { PiiSpan } from "@busyclaw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

const CUSTOMER = "alice@personal.com";
const SUBJECT = "customer-42";

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

async function chat() {
	const w = await world({
		database: "sqlite",
		detector: emailDetector,
		indexKey: "e2e-key",
		model: script([{ text: "noted" }]),
	});
	await w.api.createClaw({ id: "claw-1", name: "Assistant" });
	await w.api.createThread({
		id: "thread-1",
		clawId: "claw-1",
		title: "Chat",
	});
	return w;
}

describe("erasure journey — sqlite", () => {
	it("destroys the mapping a subject was linked to, everywhere at once", async () => {
		const w = await chat();
		open = w;

		// LINEAGE AT WRITE TIME. busyclaw cannot infer whose data this is, and neither the caller's
		// identity nor the model's claim would be trustworthy for it — so the host says.
		await w.api.appendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			role: "user",
			content: `my address is ${CUSTOMER}`,
			subjectIds: [SUBJECT],
		});

		// Before: exactly one table holds the original, and it is the destroyable one.
		expect(await w.tablesHolding(CUSTOMER)).toEqual(["pii_mapping"]);

		const { erased } = await w.api.forgetSubject({
			subjectId: SUBJECT,
			containerKind: "claw",
			containerId: "claw-1",
		});
		expect(erased).toBeGreaterThan(0);

		// After: nowhere. Not the transcript, not the mapping table, not a row somebody forgot about.
		expect(await w.tablesHolding(CUSTOMER)).toEqual([]);
	});

	it("cannot reach a mapping that was never linked to anyone", async () => {
		// THE BLIND SPOT, pinned as a test rather than left as a docstring. A message written without
		// `subjectIds` is tokenized exactly the same way and looks identical at rest — the difference
		// only shows up at erasure, which is the worst possible moment to discover it.
		//
		// This is the failure mode the DSR claim actually dies of: not "we forgot to redact" but "we
		// redacted and never recorded whose it was", and the completed-erasure report is then a false
		// statement about that copy.
		const w = await chat();
		open = w;

		await w.api.appendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			role: "user",
			content: `my address is ${CUSTOMER}`,
		});

		const { erased } = await w.api.forgetSubject({
			subjectId: SUBJECT,
			containerKind: "claw",
			containerId: "claw-1",
		});

		expect(erased).toBe(0);
		// Still there, and correctly so — nothing ever said this value was theirs.
		expect(await w.tablesHolding(CUSTOMER)).toEqual(["pii_mapping"]);
	});
});
