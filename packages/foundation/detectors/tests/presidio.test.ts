// The Presidio adapter's contract, encoding what we proved against a live analyzer
// (mcr.microsoft.com/presidio-analyzer:2.2.358). The redactor owns overlap resolution, dedup, and
// the mapping store, so this detector's whole job is the pure transform from Presidio's wire shape
// to euroclaw spans: a CLOSED entity→kind map, a score floor, and — the one subtle correctness
// point — converting Presidio's Python CODE-POINT offsets to JavaScript UTF-16 indices.
import { createMemoryRedactor } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import {
	codePointToUtf16,
	presidioDefaultEntityMap,
	presidioDetector,
	presidioKindOf,
	presidioSpans,
} from "../src/presidio/index";

/** A Presidio /analyze result row (snake_case, as the service emits it). */
function result(
	entity_type: string,
	start: number,
	end: number,
	score: number,
) {
	return { entity_type, start, end, score };
}

/** A fake fetch that captures the request and replays canned /analyze rows. */
function fakeFetch(
	rows: ReturnType<typeof result>[],
	opts: {
		status?: number;
		capture?: (req: { url: string; body: unknown; headers: Headers }) => void;
	} = {},
): typeof globalThis.fetch {
	return (async (url: string, init: RequestInit) => {
		opts.capture?.({
			url: String(url),
			body: JSON.parse(String(init.body)),
			headers: new Headers(init.headers),
		});
		return new Response(JSON.stringify(rows), {
			status: opts.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof globalThis.fetch;
}

describe("presidioKindOf — the closed mapping", () => {
	it("maps the categories euroclaw targets", () => {
		expect(presidioKindOf("EMAIL_ADDRESS")).toBe("email");
		expect(presidioKindOf("PHONE_NUMBER")).toBe("phone");
		expect(presidioKindOf("PERSON")).toBe("name");
		expect(presidioKindOf("LOCATION")).toBe("address");
		expect(presidioKindOf("CREDIT_CARD")).toBe("card");
		expect(presidioKindOf("IBAN_CODE")).toBe("id");
		expect(presidioKindOf("US_SSN")).toBe("id");
		expect(presidioKindOf("IP_ADDRESS")).toBe("id");
		expect(presidioKindOf("CRYPTO")).toBe("id");
		expect(presidioKindOf("URL")).toBe("url");
	});

	it("DROPS DATE_TIME — a DOB and an employment range are indistinguishable (both PERSON-grade 0.85)", () => {
		expect(presidioKindOf("DATE_TIME")).toBeNull();
	});

	it("drops any unmapped entity — additions are conscious, test-gated events", () => {
		expect(presidioKindOf("MEDICAL_LICENSE")).toBeNull();
		expect(presidioKindOf("US_DRIVER_LICENSE")).toBeNull();
		expect(presidioKindOf("NONSENSE")).toBeNull();
	});

	it("uses a custom map when given one — a different model, a different label set", () => {
		const map = { PASSPORT_NUMBER: "id", FULL_NAME: "name" } as const;
		expect(presidioKindOf("PASSPORT_NUMBER", map)).toBe("id");
		expect(presidioKindOf("FULL_NAME", map)).toBe("name");
		expect(presidioKindOf("EMAIL_ADDRESS", map)).toBeNull(); // custom map replaces the default
	});

	it("exposes the default map for extension via spread", () => {
		const extended = { ...presidioDefaultEntityMap, MRN: "id" } as const;
		expect(presidioKindOf("EMAIL_ADDRESS", extended)).toBe("email");
		expect(presidioKindOf("MRN", extended)).toBe("id");
	});
});

describe("codePointToUtf16 — the offset boundary", () => {
	it("is identity for plain ASCII", () => {
		expect(codePointToUtf16("hello world", 6)).toBe(6);
	});

	it("shifts past an astral char (Presidio counts 1 code point, JS counts 2 UTF-16 units)", () => {
		// Proven live: for "🎉 Dana…", Presidio returns PERSON start=2; JS needs 3.
		expect(codePointToUtf16("🎉 Dana", 2)).toBe(3);
	});

	it("counts an astral char as 2 UTF-16 units", () => {
		expect(codePointToUtf16("🎉ab", 1)).toBe(2);
	});

	it("clamps an index at or past the end to the string length", () => {
		expect(codePointToUtf16("ab", 2)).toBe(2);
		expect(codePointToUtf16("ab", 9)).toBe(2);
	});

	it("is 0 for index 0", () => {
		expect(codePointToUtf16("🎉ab", 0)).toBe(0);
	});
});

describe("presidioSpans — the assembly (fake rows, no network)", () => {
	const CV =
		"Dana Schmidt was a Staff Engineer at Acme. Contact her at dana.schmidt@example.com.";

	it("maps mapped entities to substring-exact spans, source=model", () => {
		const spans = presidioSpans(
			[result("PERSON", 0, 12, 0.85), result("EMAIL_ADDRESS", 58, 82, 1.0)],
			CV,
		);
		const person = spans.find((s) => s.kind === "name");
		const email = spans.find((s) => s.kind === "email");
		expect(person?.value).toBe("Dana Schmidt");
		expect(email?.value).toBe("dana.schmidt@example.com");
		expect(spans.every((s) => s.source === "model")).toBe(true);
		for (const s of spans) expect(CV.slice(s.start, s.end)).toBe(s.value);
	});

	it("drops DATE_TIME even at NER-grade score", () => {
		const text = "Born 12 March 1988. Worked 2021-2026.";
		const spans = presidioSpans(
			[result("DATE_TIME", 5, 18, 0.85), result("DATE_TIME", 27, 36, 0.85)],
			text,
		);
		expect(spans).toEqual([]);
	});

	it("drops a MAPPED entity below the score floor, keeps it above", () => {
		const text = "call 030 12345 now";
		expect(presidioSpans([result("PHONE_NUMBER", 5, 14, 0.2)], text)).toEqual(
			[],
		);
		expect(
			presidioSpans([result("PHONE_NUMBER", 5, 14, 0.75)], text),
		).toHaveLength(1);
	});

	it("honors a custom score floor", () => {
		const text = "call 030 12345 now";
		expect(
			presidioSpans([result("PHONE_NUMBER", 5, 14, 0.2)], text, {
				scoreFloor: 0.1,
			}),
		).toHaveLength(1);
	});

	it("maps a custom model's labels via entityMap", () => {
		const text = "Patient MRN 12345 admitted.";
		const spans = presidioSpans([result("MRN", 8, 17, 0.9)], text, {
			entityMap: { MRN: "id" },
		});
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("id");
		expect(spans[0]?.value).toBe("MRN 12345"); // offsets 8..17, value filled by slice
	});

	it("drops unmapped entities regardless of score", () => {
		const text = "License D1234567 issued.";
		expect(
			presidioSpans([result("US_DRIVER_LICENSE", 8, 16, 0.99)], text),
		).toEqual([]);
	});

	it("converts astral offsets so the value is substring-exact", () => {
		const text = "🎉 Dana Schmidt is here.";
		// Presidio (code points): PERSON start=2 end=14.
		const spans = presidioSpans([result("PERSON", 2, 14, 0.85)], text);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.value).toBe("Dana Schmidt");
		expect(text.slice(spans[0]?.start ?? 0, spans[0]?.end ?? 0)).toBe(
			"Dana Schmidt",
		);
	});

	it("returns overlapping spans verbatim — overlap resolution is the redactor's job", () => {
		// The real analyzer's email shape: EMAIL_ADDRESS plus URL sub-spans over the domain.
		const spans = presidioSpans(
			[result("EMAIL_ADDRESS", 58, 82, 1.0), result("URL", 71, 82, 0.5)],
			CV,
		);
		expect(spans).toHaveLength(2);
	});
});

describe("presidioDetector — the factory (injected fetch)", () => {
	it("POSTs to {url}/analyze with the text and language, returns mapped spans", async () => {
		let seen: { url: string; body: unknown; headers: Headers } | undefined;
		const detect = presidioDetector({
			url: "http://presidio:5002",
			fetch: fakeFetch([result("PERSON", 0, 4, 0.85)], {
				capture: (r) => {
					seen = r;
				},
			}),
		});
		const spans = await detect("Dana is here");
		expect(seen?.url).toBe("http://presidio:5002/analyze");
		expect(seen?.body).toEqual({ text: "Dana is here", language: "en" });
		expect(spans).toEqual([
			{
				start: 0,
				end: 4,
				value: "Dana",
				kind: "name",
				confidence: 0.85,
				source: "model",
			},
		]);
	});

	it("sends X-Api-Key only when configured", async () => {
		let withKey: Headers | undefined;
		await presidioDetector({
			url: "http://p",
			apiKey: "secret-123",
			fetch: fakeFetch([], { capture: (r) => (withKey = r.headers) }),
		})("x");
		expect(withKey?.get("x-api-key")).toBe("secret-123");

		let noKey: Headers | undefined;
		await presidioDetector({
			url: "http://p",
			fetch: fakeFetch([], { capture: (r) => (noKey = r.headers) }),
		})("x");
		expect(noKey?.get("x-api-key")).toBeNull();
	});

	it("passes a custom entityMap through to the mapping", async () => {
		const detect = presidioDetector({
			url: "http://p",
			entityMap: { CUSTOM_NAME: "name" },
			fetch: fakeFetch([result("CUSTOM_NAME", 0, 4, 0.9)]),
		});
		expect(await detect("Dana")).toEqual([
			{
				start: 0,
				end: 4,
				value: "Dana",
				kind: "name",
				confidence: 0.9,
				source: "model",
			},
		]);
	});

	it("skips the network call for blank text", async () => {
		let called = false;
		const detect = presidioDetector({
			url: "http://p",
			fetch: fakeFetch([], { capture: () => (called = true) }),
		});
		expect(await detect("   ")).toEqual([]);
		expect(called).toBe(false);
	});

	it("throws on a non-ok response — fail-closed, never leak unredacted text", async () => {
		const detect = presidioDetector({
			url: "http://p",
			fetch: fakeFetch([], { status: 503 }),
		});
		await expect(detect("Dana")).rejects.toThrow();
	});

	it("through the redactor: overlapping email+url collapse to one email token", async () => {
		const text = "Contact her at dana.schmidt@example.com.";
		// Offsets within THIS string: email 15..39, url (domain) 28..39.
		const detect = presidioDetector({
			url: "http://p",
			fetch: fakeFetch([
				result("EMAIL_ADDRESS", 15, 39, 1.0),
				result("URL", 28, 39, 0.5),
			]),
		});
		const redactor = createMemoryRedactor(detect);
		const ctx = { scope: "claw", scopeId: "c1" };
		const redacted = await redactor.redactValue(text, ctx);
		expect(redacted).not.toContain("dana.schmidt@example.com");
		expect(redacted.match(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/g)).toHaveLength(1);
		expect(redacted).toContain("{{pii:email:");
		expect(await redactor.rehydrateValue(redacted, ctx)).toBe(text);
	});
});
