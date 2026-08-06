// LINEAGE FOLLOWS THE DATA, not the call site — R-M03, at the redactor level.
//
// Minting links a mapping to the subject in context. Nothing linked one that ALREADY existed, and
// that is the gap: a value tokenized before the subject is known — a chat message redacted at the
// door, a message body tokenized at admission, a placeholder mentioned again three turns later —
// never joined the erasure index, so `deleteForSubject` reported success having found nothing.

import type { Detector, PiiSpan } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	createMemoryPiiMappingStore,
	createStoredRedactor,
} from "../src/index";

const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+\.\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		spans.push({
			start: match.index ?? 0,
			end: (match.index ?? 0) + value.length,
			kind: "email",
			value,
		});
	}
	return spans;
};

const container = { containerKind: "claw", containerId: "claw-1" };

function redactor() {
	const mappings = createMemoryPiiMappingStore();
	return {
		mappings,
		redactor: createStoredRedactor({ detector: emailDetector, mappings }),
	};
}

describe("linking an already-tokenized value to a subject", () => {
	it("links a placeholder minted BEFORE anyone said whose data it was", async () => {
		const { mappings, redactor: r } = redactor();
		// Minted with no subject — the door's redaction, which runs before the run resolves one.
		const tokenized = await r.redactValue("mail alice@x.com", container);
		expect(await mappings.deleteForSubject("cust_42", container)).toBe(0);

		// The same text entering a run that DID resolve a subject. Nothing new to detect; the whole
		// effect is the link.
		await r.redactValue(tokenized, { ...container, subjectIds: ["cust_42"] });

		expect(await mappings.deleteForSubject("cust_42", container)).toBe(1);
		expect(await r.rehydrateValue(tokenized, container)).toBe(tokenized);
	});

	it("ignores a placeholder this container has no mapping for", async () => {
		// A namesake, a stale token left in a transcript after an erasure, or a string somebody
		// pasted. An orphan junction row would make a later shred report a count for rows that erase
		// nothing — the same false-confidence answer this area exists to remove.
		const { mappings, redactor: r } = redactor();

		await r.redactValue("see {{pii:email:no-such-token-here}}", {
			...container,
			subjectIds: ["cust_42"],
		});

		expect(await mappings.deleteForSubject("cust_42", container)).toBe(0);
	});

	it("does not reach across containers", async () => {
		// Word-code placeholders are lower entropy than the old hex, so the same token can legitimately
		// exist in two containers meaning two different things. A link written from one must not put
		// the other's row in the index.
		const { mappings, redactor: r } = redactor();
		const mine = await r.redactValue("mail alice@x.com", container);
		const other = { containerKind: "claw", containerId: "claw-2" };

		// Claw 2 sees claw 1's token — meaningless there, and it must stay that way.
		await r.redactValue(mine, { ...other, subjectIds: ["cust_42"] });

		expect(await mappings.deleteForSubject("cust_42", other)).toBe(0);
		expect(await mappings.deleteForSubject("cust_42", container)).toBe(0);
	});

	it("costs nothing when no subject is in context", async () => {
		// Every deployment that has not configured a resolver is this one, so the pass has to be free
		// rather than merely cheap.
		let linkCalls = 0;
		const mappings = createMemoryPiiMappingStore();
		const counted = {
			...mappings,
			linkSubjects: (
				placeholders: readonly string[],
				subjectIds: readonly string[],
				ctx?: { containerKind?: string; containerId?: string },
			) => {
				linkCalls += 1;
				return mappings.linkSubjects?.(placeholders, subjectIds, ctx);
			},
		};
		const r = createStoredRedactor({
			detector: emailDetector,
			mappings: counted,
		});

		const tokenized = await r.redactValue("mail alice@x.com", container);
		await r.redactValue(tokenized, container);

		expect(linkCalls).toBe(0);
	});
});
