// What the redaction walk will spend on one value.
//
// M-04. Everything crossing this boundary is untrusted — a caller's request body, a model's own
// output, a tool result from someone else's API — and the walk that redacts it had no ceiling on how
// deep it would go, how much it would visit, or how much it would do at once. Each is a way to spend
// the host with a payload rather than with a request.
//
// The budget FAILS CLOSED. Redaction is the privacy boundary, so a value it declined to walk has not
// been made safe; returning it unredacted would trade a resource limit for a disclosure.

import type { Detector, PiiSpan } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryRedactor } from "../src/index";

const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+\.\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			value,
			kind: "email",
			source: "regex",
		});
	}
	return spans;
};

/** `depth` levels of `{ next: { next: … } }`. */
function nest(depth: number): unknown {
	let value: unknown = "a@b.com";
	for (let i = 0; i < depth; i += 1) value = { next: value };
	return value;
}

describe("the redaction walk's budget", () => {
	it("walks an ordinarily-shaped value without complaint", async () => {
		const redactor = createMemoryRedactor(emailDetector);
		const out = await redactor.redactValue({
			user: { contact: { email: "a@b.com" } },
			notes: ["ping a@b.com", "nothing here"],
		});

		expect(JSON.stringify(out)).not.toContain("a@b.com");
		expect(JSON.stringify(out)).toContain("nothing here");
	});

	it("refuses a value nested past the depth ceiling", async () => {
		// Two bytes per level in JSON, so this whole shape arrives in a body far under any size limit
		// and still recurses deeply enough to exhaust the stack of an async walk.
		const redactor = createMemoryRedactor(emailDetector);
		await expect(redactor.redactValue(nest(500))).rejects.toThrow(/deep/i);
	});

	it("refuses a value holding more nodes than the ceiling", async () => {
		const redactor = createMemoryRedactor(emailDetector);
		const wide = Array.from({ length: 200_000 }, (_, i) => `v${i}`);
		await expect(redactor.redactValue(wide)).rejects.toThrow(/large/i);
	});

	it("does not put the whole array on the detector at once", async () => {
		// Every string reaching the detector can be a call to an out-of-process one, so an unbounded
		// `Promise.all` over an array turns one value into thousands of concurrent requests — a flood
		// aimed at our own dependency, from input a model or a caller supplied.
		let inFlight = 0;
		let peak = 0;
		const counting: Detector = async (text) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 0));
			inFlight -= 1;
			return emailDetector(text) as PiiSpan[];
		};

		const redactor = createMemoryRedactor(counting);
		await redactor.redactValue(
			Array.from({ length: 500 }, (_, i) => `item ${i} a${i}@b.com`),
		);

		expect(peak).toBeLessThanOrEqual(16);
		// And it genuinely ran them — a peak of 1 would mean the fan-out collapsed to a serial walk.
		expect(peak).toBeGreaterThan(1);
	});

	it("spends the budget per CALL, not per process", async () => {
		// A ceiling that accumulated across calls would turn a busy host into one that eventually
		// refuses everything — the limit is on the value, not on the lifetime.
		const redactor = createMemoryRedactor(emailDetector);
		const one = Array.from({ length: 60_000 }, (_, i) => `v${i}`);

		await expect(redactor.redactValue(one)).resolves.toBeDefined();
		await expect(redactor.redactValue(one)).resolves.toBeDefined();
	});
});
