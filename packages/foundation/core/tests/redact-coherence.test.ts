// Deterministic placeholders (lookup-or-mint) + the posture combinators.
// See docs/plans/redaction-coherence-plan.md and docs/plans/redaction-dx-plan.md.
import type { Detector, PiiMappingStore, PiiSpan } from "@euroclaw/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	composeDetectors,
	createInertRedactor,
	createMemoryPiiMappingStore,
	createRoutingRedactor,
	createStoredRedactor,
} from "../src/index";

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

const TOKEN = /\{\{pii:email:[a-z0-9-]+\}\}/;
const TOKENS = /\{\{pii:email:[a-z0-9-]+\}\}/g;

function tokensOf(text: string): string[] {
	return [...text.matchAll(TOKENS)].map((match) => match[0]);
}

describe("deterministic placeholders (indexKey)", () => {
	const ctx = { scope: "claw", scopeId: "a" };

	it("same value → same token, within one text and across calls", async () => {
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});
		const first = await redactor.redactValue(
			"email a@b.com and again a@b.com",
			ctx,
		);
		const [one, two] = tokensOf(first);
		expect(one).toMatch(TOKEN);
		expect(one).toBe(two);

		const later = await redactor.redactValue("later a@b.com", ctx);
		expect(tokensOf(later)[0]).toBe(one);

		const other = await redactor.redactValue("other c@d.com", ctx);
		expect(tokensOf(other)[0]).not.toBe(one);
	});

	it("the kind rides the token", async () => {
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});
		const out = await redactor.redactValue("email a@b.com", ctx);
		expect(out).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);
	});

	it("cross-container: different tokens, and a traveling token is inert", async () => {
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});
		const inA = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "a",
		});
		const inB = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "b",
		});
		expect(tokensOf(inA)[0]).not.toBe(tokensOf(inB)[0]);
		expect(
			await redactor.rehydrateValue(inA, { scope: "claw", scopeId: "b" }),
		).toBe(inA);
		expect(
			await redactor.rehydrateValue(inA, { scope: "claw", scopeId: "a" }),
		).toBe("email a@b.com");
	});

	it("erasure is never undone by dedup: a reappearing value gets a NEW token", async () => {
		const mappings = createMemoryPiiMappingStore();
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings,
			indexKey: "test-key",
		});
		const subjectCtx = { ...ctx, subjectIds: ["s1"] };
		const first = await redactor.redactValue("email a@b.com", subjectCtx);
		const token1 = tokensOf(first)[0];

		await mappings.deleteForSubject("s1");
		// The dead token is permanently inert…
		expect(await redactor.rehydrateValue(first, subjectCtx)).toBe(first);
		// …and the value coming back mints FRESH — erased mappings never resurrect.
		const second = await redactor.redactValue("email a@b.com", subjectCtx);
		const token2 = tokensOf(second)[0];
		expect(token2).toBeDefined();
		expect(token2).not.toBe(token1);
		expect(await redactor.rehydrateValue(second, subjectCtx)).toBe(
			"email a@b.com",
		);
	});

	it("without indexKey: fresh tokens per occurrence, and a durable store warns once", async () => {
		const keyless = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
		});
		const first = await keyless.redactValue("email a@b.com", ctx);
		const second = await keyless.redactValue("email a@b.com", ctx);
		expect(tokensOf(first)[0]).not.toBe(tokensOf(second)[0]);

		const warn = vi.fn();
		const durableShim: PiiMappingStore = {
			durable: true,
			save: () => {},
			resolve: () => null,
			findByHash: () => null,
			deleteForSubject: () => {},
		};
		createStoredRedactor({ mappings: durableShim, warn });
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockClear();
		createStoredRedactor({ mappings: durableShim, warn, indexKey: "k" });
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("createRoutingRedactor", () => {
	const strict = createStoredRedactor({
		detector: emailDetector,
		mappings: createMemoryPiiMappingStore(),
		indexKey: "test-key",
	});
	const routing = createRoutingRedactor({
		strict,
		postureOf: (ctx) => (ctx?.scopeId === "raw1" ? "raw" : "strict"),
	});

	it("routes per container: raw passes through, strict tokenizes", async () => {
		const raw = await routing.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "raw1",
		});
		expect(raw).toBe("email a@b.com");

		const redacted = await routing.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "strict1",
		});
		expect(redacted).toMatch(TOKEN);
	});

	it("rehydration always delegates (raw containers hold no live tokens)", async () => {
		const strictCtx = { scope: "claw", scopeId: "strict1" };
		const redacted = await routing.redactValue("email a@b.com", strictCtx);
		expect(await routing.rehydrateValue(redacted, strictCtx)).toBe(
			"email a@b.com",
		);
		// The same token traveling into a raw container resolves to nothing.
		expect(
			await routing.rehydrateValue(redacted, {
				scope: "claw",
				scopeId: "raw1",
			}),
		).toBe(redacted);
	});

	it("reports the strict redactor's durability", () => {
		expect(routing.durable).toBe(strict.durable);
	});
});

describe("createInertRedactor", () => {
	it("is identity both ways and vacuously durable", async () => {
		const inert = createInertRedactor();
		expect(inert.durable).toBe(true);
		expect(await inert.redactValue("email a@b.com")).toBe("email a@b.com");
		expect(await inert.rehydrateValue("{{pii:email:abc}}")).toBe(
			"{{pii:email:abc}}",
		);
	});
});

describe("composeDetectors", () => {
	it("unions detectors; overlapping spans resolve without mangling", async () => {
		const domainDetector: Detector = (text) => {
			const spans: PiiSpan[] = [];
			for (const match of text.matchAll(/b\.com/g)) {
				const start = match.index ?? 0;
				spans.push({
					start,
					end: start + match[0].length,
					value: match[0],
					kind: "url",
					source: "regex",
				});
			}
			return spans;
		};
		const redactor = createStoredRedactor({
			detector: composeDetectors(emailDetector, domainDetector),
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});
		const out = await redactor.redactValue("email a@b.com now", {
			scope: "claw",
			scopeId: "a",
		});
		// The email span (earlier start) wins the overlap; exactly one token, no residue.
		expect(out).toMatch(/^email \{\{pii:email:[a-z0-9-]+\}\} now$/);
	});
});

describe("idempotence over existing placeholders", () => {
	const ctx = { scope: "claw", scopeId: "a" };
	// The hostile shape: a hex-run detector ALWAYS matches inside a token's 32-hex body, so
	// without span masking a second pass is guaranteed to corrupt the placeholder.
	const hexDetector: Detector = (text) => {
		const spans: PiiSpan[] = [];
		for (const match of text.matchAll(/[0-9a-f]{8,}/g)) {
			const value = match[0];
			if (value === undefined) continue;
			const start = match.index ?? 0;
			spans.push({
				start,
				end: start + value.length,
				value,
				kind: "id",
				source: "regex",
			});
		}
		return spans;
	};

	it("redact(redact(x)) === redact(x) even when the detector matches token bodies", async () => {
		const mappings = createMemoryPiiMappingStore();
		const save = vi.spyOn(mappings, "save");
		const redactor = createStoredRedactor({
			detector: hexDetector,
			mappings,
			indexKey: "test-key",
		});
		const once = await redactor.redactValue("serial deadbeef0123 done", ctx);
		expect(once).toMatch(/^serial \{\{pii:id:[a-z0-9-]+\}\} done$/);
		const savesAfterFirst = save.mock.calls.length;

		const twice = await redactor.redactValue(once, ctx);
		expect(twice).toBe(once);
		expect(save.mock.calls.length).toBe(savesAfterFirst);
	});

	it("raw PII beside an existing placeholder is still caught; the placeholder survives", async () => {
		const redactor = createStoredRedactor({
			detector: composeDetectors(emailDetector, hexDetector),
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});
		const once = await redactor.redactValue("serial deadbeef0123", ctx);

		const mixed = await redactor.redactValue(`${once} and a@b.com`, ctx);
		expect(mixed.startsWith(once)).toBe(true);
		expect(mixed).toMatch(TOKEN);
		expect(mixed).not.toContain("a@b.com");
	});
});
