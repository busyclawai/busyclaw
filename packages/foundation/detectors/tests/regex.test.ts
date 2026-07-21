// The deterministic detector's contract: high-precision spans for the categories a pattern can
// reach EXACTLY — email, phone, card, iban — with offsets that are already JavaScript string
// indices (no code-point conversion, unlike Presidio). Over-detection is compliance-safe (a false
// span costs one needless placeholder, never a leak); noise is the real enemy, so every category
// here is either shape-anchored (email) or checksum-gated (card Luhn, iban mod-97), and phone
// carries the year-range/short-run/inside-another-match guards deckerhr's v1 taught.
import type { PiiSpan } from "@euroclaw/contracts";
import { createMemoryRedactor } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import { regexDetector } from "../src/regex/index";

/** Spans sorted by start — the detector makes no ordering promise; the redactor sorts. */
function spansOf(text: string): PiiSpan[] {
	return [...regexDetector(text)].sort((a, b) => a.start - b.start);
}

/** Every span must be a substring-exact slice of the text at its own offsets — the invariant the
 *  whole pseudonymization map leans on. */
function assertSubstringExact(text: string, spans: PiiSpan[]): void {
	for (const span of spans) {
		expect(text.slice(span.start, span.end)).toBe(span.value);
		expect(span.source).toBe("regex");
	}
}

describe("email", () => {
	it("finds an address at substring-exact offsets", () => {
		const text = "reach me at dana@example.com please";
		const spans = spansOf(text);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("email");
		expect(spans[0]?.value).toBe("dana@example.com");
		assertSubstringExact(text, spans);
	});

	it("preserves the matched case verbatim (normalization is the redactor's job, not the detector's)", () => {
		const spans = spansOf("Dana@Example.COM");
		expect(spans[0]?.value).toBe("Dana@Example.COM");
	});

	it("finds every address, once each", () => {
		const spans = spansOf("a@x.io and b@y.io");
		expect(spans.map((s) => s.value)).toEqual(["a@x.io", "b@y.io"]);
	});
});

describe("phone", () => {
	it("finds an international number", () => {
		const text = "call +49 30 901820 today";
		const spans = spansOf(text);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("phone");
		expect(spans[0]?.value).toBe("+49 30 901820");
		assertSubstringExact(text, spans);
	});

	it("rejects an employment year-range (the canonical CV false positive)", () => {
		expect(spansOf("Acme Corp 2021-2026")).toHaveLength(0);
	});

	it("rejects a digit run shorter than 7 digits", () => {
		expect(spansOf("room 12345")).toHaveLength(0);
	});

	it("rejects a digit run longer than 15 digits (E.164 ceiling)", () => {
		expect(spansOf("id 1234567890123456789")).toHaveLength(0);
	});

	it("does not double-count digits that live inside an email", () => {
		const spans = spansOf("ping 1234567@corp.com");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("email");
	});
});

describe("credit card (Luhn-gated)", () => {
	it("finds a Luhn-valid card", () => {
		const text = "card 4111 1111 1111 1111 exp";
		const spans = spansOf(text);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("card");
		expect(spans[0]?.value).toBe("4111 1111 1111 1111");
		assertSubstringExact(text, spans);
	});

	it("ignores a 16-digit run that fails Luhn (neither card nor phone)", () => {
		expect(spansOf("num 4111 1111 1111 1112 x")).toHaveLength(0);
	});

	it("suppresses a phone span coinciding with a detected card (one value, one kind)", () => {
		// 13 digits: within phone's 7..15 gate AND card's 13..19 gate — the card must win.
		const spans = spansOf("4222222222222"); // Luhn-valid 13-digit Visa
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("card");
	});
});

describe("iban (mod-97-gated) → id", () => {
	it("finds a checksum-valid IBAN", () => {
		const text = "IBAN DE89 3704 0044 0532 0130 00 please";
		const spans = spansOf(text);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("id");
		expect(spans[0]?.value).toBe("DE89 3704 0044 0532 0130 00");
		assertSubstringExact(text, spans);
	});

	it("ignores a country-code-shaped string that fails mod-97", () => {
		expect(spansOf("ref DE00 0000 0000 0000 0000 00")).toHaveLength(0);
	});
});

describe("nothing to find", () => {
	it("returns no spans for clean text", () => {
		expect(spansOf("the quick brown fox")).toEqual([]);
	});
	it("returns no spans for empty text", () => {
		expect(spansOf("")).toEqual([]);
	});
});

describe("end-to-end through the real redactor", () => {
	it("produces rehydratable placeholders for detected spans", async () => {
		const redactor = createMemoryRedactor(regexDetector);
		const ctx = { scope: "claw", scopeId: "c1" };
		const redacted = await redactor.redactValue(
			"mail dana@example.com or call +49 30 901820",
			ctx,
		);
		expect(redacted).not.toContain("dana@example.com");
		expect(redacted).not.toContain("+49 30 901820");
		expect(redacted).toMatch(/\{\{pii:email:[a-z0-9]+\}\}/);
		expect(redacted).toMatch(/\{\{pii:phone:[a-z0-9]+\}\}/);

		const back = await redactor.rehydrateValue(redacted, ctx);
		expect(back).toBe("mail dana@example.com or call +49 30 901820");
	});
});
