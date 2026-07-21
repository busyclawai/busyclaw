// The live leg — gated on PRESIDIO_URL, so CI without a container skips it. What MockEngine cannot
// prove: the real analyzer's wire shape, and that a real spaCy model finds entities at offsets our
// code-point→UTF-16 conversion makes substring-exact.
//
//   docker run -p 5002:3000 mcr.microsoft.com/presidio-analyzer:2.2.358
//   PRESIDIO_URL=http://localhost:5002 pnpm --filter @euroclaw/detectors test
import { createMemoryRedactor } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import { presidioDetector } from "../src/presidio/index";

const url = process.env.PRESIDIO_URL;

describe.skipIf(!url)("presidio (live analyzer)", () => {
	const detect = presidioDetector({ url: url ?? "" });

	it("finds a person and an email at substring-exact offsets", async () => {
		const text =
			"Dana Schmidt was a Staff Engineer at Acme. Contact her at dana.schmidt@example.com.";
		const spans = await detect(text);
		// The master invariant: every emitted span slices back to its own value.
		for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.value);
		expect(spans.find((s) => s.kind === "email")?.value).toBe(
			"dana.schmidt@example.com",
		);
		expect(spans.some((s) => s.kind === "name")).toBe(true);
	});

	it("keeps offsets substring-exact across an astral char (the conversion, end-to-end)", async () => {
		// Without code-point→UTF-16 conversion, the emoji shifts every following offset and the
		// email value would come back misaligned. This is the test that would fail on a naive port.
		const text = "🎉 Dana Schmidt — reach me at dana@example.com 🎉";
		const spans = await detect(text);
		expect(spans.length).toBeGreaterThan(0);
		for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.value);
		expect(spans.find((s) => s.kind === "email")?.value).toBe(
			"dana@example.com",
		);
	});

	it("drops DATE_TIME — a DOB the analyzer flags as a date emits nothing", async () => {
		// The live analyzer returns exactly one entity here — DATE_TIME "12 March 1988"@0.85 — and
		// our closed map drops it, so we emit nothing. (A busier sentence can have spaCy over-capture
		// a nearby year into a LOCATION span; that's an NER precision quirk of the model, not the
		// adapter — the DATE_TIME itself is still dropped.)
		const spans = await detect("Her birthday is 12 March 1988.");
		expect(spans).toEqual([]);
	});

	it("every emitted span clears the score floor (junk recognizers excluded)", async () => {
		const spans = await detect(
			"Phone +49 30 901820. IBAN DE89 3704 0044 0532 0130 00.",
		);
		for (const s of spans)
			expect(s.confidence ?? 1).toBeGreaterThanOrEqual(0.35);
	});

	it("round-trips through the redactor with the live analyzer", async () => {
		const redactor = createMemoryRedactor(detect);
		const ctx = { scope: "claw", scopeId: "live" };
		const text = "Dana Schmidt — dana.schmidt@example.com";
		const redacted = await redactor.redactValue(text, ctx);
		expect(redacted).not.toContain("dana.schmidt@example.com");
		expect(redacted).toContain("{{pii:");
		expect(await redactor.rehydrateValue(redacted, ctx)).toBe(text);
	});
});
