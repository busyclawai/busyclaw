// Deterministic placeholders (lookup-or-mint) + the posture combinators.
// See docs/plans/redaction-coherence-plan.md and docs/plans/redaction-dx-plan.md.
import type {
	Detector,
	PiiMapping,
	PiiMappingStore,
	PiiSpan,
} from "@busyclaw/contracts";
import { conflictError } from "@busyclaw/errors";
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

	it("dedup survives CONCURRENCY: an array walks in parallel and still yields one token", async () => {
		// `walk` runs array elements through Promise.all, so lookup-or-mint genuinely races: every
		// element missed findByHash and minted its own token, and one person arrived at the model
		// wearing three. Arrays are the normal payload shape (a message list, a tool-result list), so
		// this was the common case and not an edge one.
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});

		const out = (await redactor.redactValue(
			["mail a@b.com", "again a@b.com", "third a@b.com"],
			ctx,
		)) as string[];

		const tokens = out.flatMap(tokensOf);
		expect(tokens).toHaveLength(3);
		expect(new Set(tokens).size).toBe(1);
		expect(await redactor.rehydrateValue(out, ctx)).toEqual([
			"mail a@b.com",
			"again a@b.com",
			"third a@b.com",
		]);
	});

	it("dedup survives concurrent redactValue calls on one container", async () => {
		// The same race one level up: parallel tool calls, or an event fan-out inside one claw.
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});

		const outs = await Promise.all([
			redactor.redactValue("one a@b.com", ctx),
			redactor.redactValue("two a@b.com", ctx),
			redactor.redactValue("three a@b.com", ctx),
		]);

		expect(new Set(outs.flatMap(tokensOf)).size).toBe(1);
	});

	it("concurrency does not leak ACROSS containers", async () => {
		// The latch is keyed by (container, hash). Coalescing must never hand claw b a token minted
		// for claw a, which would make one claw's placeholder resolve inside the other.
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
			indexKey: "test-key",
		});

		const [inA, inB] = await Promise.all([
			redactor.redactValue("email a@b.com", { scope: "claw", scopeId: "a" }),
			redactor.redactValue("email a@b.com", { scope: "claw", scopeId: "b" }),
		]);

		expect(tokensOf(inA)[0]).not.toBe(tokensOf(inB)[0]);
		expect(
			await redactor.rehydrateValue(inA, { scope: "claw", scopeId: "b" }),
		).toBe(inA);
	});

	it("concurrent callers each keep their own subject link, so erasure still reaches the mapping", async () => {
		// Coalescing means only ONE caller runs lookup-or-mint. If the others dropped their subjectIds
		// with it, that subject would hold no junction row and deleteForSubject would miss the value
		// entirely — the token would keep rehydrating after an erasure request.
		const mappings = createMemoryPiiMappingStore();
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings,
			indexKey: "test-key",
		});

		const outs = await Promise.all([
			redactor.redactValue("a@b.com", { ...ctx, subjectIds: ["s1"] }),
			redactor.redactValue("a@b.com", { ...ctx, subjectIds: ["s2"] }),
		]);
		expect(new Set(outs.flatMap(tokensOf)).size).toBe(1);

		// s2 never won the latch; erasing it must still reach the shared mapping.
		await mappings.deleteForSubject("s2");
		expect(await redactor.rehydrateValue(outs[0], ctx)).toBe(outs[0]);
	});

	it("without indexKey, concurrent occurrences still mint fresh — the latch is not a cache", async () => {
		const keyless = createStoredRedactor({
			detector: emailDetector,
			mappings: createMemoryPiiMappingStore(),
		});

		const out = (await keyless.redactValue(
			["mail a@b.com", "again a@b.com"],
			ctx,
		)) as string[];

		expect(new Set(out.flatMap(tokensOf)).size).toBe(2);
	});

	// ── losing the cross-process race ───────────────────────────────────────────────────────────────
	// The half the in-process latch cannot cover: another INSTANCE minted for this value a moment
	// earlier, so the unique on (scope, scopeId, originalHash) rejects our insert. A store that only
	// swallowed the conflict would leave us holding a placeholder that was never written — a token with
	// no mapping behind it, which rehydrates as itself into a finished draft. So the winner is adopted.

	const WINNER: PiiMapping = {
		placeholder: "{{pii:email:winner-token-from-elsewhere}}",
		original: "a@b.com",
		originalHash: "hash-of-a@b.com",
		kind: "email",
		scope: "claw",
		scopeId: "a",
		createdAt: "2026-01-01T00:00:00.000Z",
	};

	/** A store whose first insert loses, after which the winner is readable. */
	function losingStore(
		saveError: unknown = conflictError("unique constraint violated"),
	): {
		store: PiiMappingStore;
		saves: { mapping: PiiMapping; subjectIds?: readonly string[] }[];
	} {
		const saves: { mapping: PiiMapping; subjectIds?: readonly string[] }[] = [];
		let lost = false;
		return {
			saves,
			store: {
				durable: true,
				save(mapping, subjectIds) {
					if (!lost) {
						lost = true;
						throw saveError;
					}
					saves.push({ mapping, ...(subjectIds ? { subjectIds } : {}) });
				},
				// Null until our insert has lost — that is what makes us mint in the first place.
				findByHash: () => (lost ? WINNER : null),
				resolve: (placeholder) =>
					placeholder === WINNER.placeholder ? WINNER.original : null,
				deleteForSubject: () => {},
			},
		};
	}

	it("a mint that LOSES to another writer adopts the winner's placeholder", async () => {
		const { store } = losingStore();
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: store,
			indexKey: "test-key",
		});

		const out = await redactor.redactValue("email a@b.com", ctx);

		expect(tokensOf(out)[0]).toBe(WINNER.placeholder);
		// And it round-trips, which is the point: our own minted token never reached the store, so
		// returning it would have produced a placeholder that rehydrates as itself.
		expect(await redactor.rehydrateValue(out, ctx)).toBe("email a@b.com");
	});

	it("the loser still links ITS subjects to the winner's mapping", async () => {
		// The losing save threw before reaching the junction. A dropped link is a subject whose
		// erasure would never reach this mapping — the same rule the latch follows.
		const { store, saves } = losingStore();
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: store,
			indexKey: "test-key",
		});

		await redactor.redactValue("email a@b.com", { ...ctx, subjectIds: ["s9"] });

		expect(saves).toHaveLength(1);
		expect(saves[0]?.mapping.placeholder).toBe(WINNER.placeholder);
		expect(saves[0]?.subjectIds).toEqual(["s9"]);
	});

	it("an error that is NOT a conflict is never swallowed", async () => {
		// Narrow on purpose: treating an unrecognised write failure as a lost race would silently
		// redact against a mapping that was never stored.
		const { store } = losingStore(new Error("disk on fire"));
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings: store,
			indexKey: "test-key",
		});

		await expect(redactor.redactValue("email a@b.com", ctx)).rejects.toThrow(
			"disk on fire",
		);
	});

	it("a conflict whose winner cannot be read back RETHROWS", async () => {
		// Then it was some other uniqueness on the table, not the race we know how to recover from.
		// Inventing a placeholder here would be worse than failing.
		const mappings: PiiMappingStore = {
			durable: true,
			save: () => {
				throw conflictError("unique constraint violated");
			},
			findByHash: () => null,
			resolve: () => null,
			deleteForSubject: () => {},
		};
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings,
			indexKey: "test-key",
		});

		await expect(redactor.redactValue("email a@b.com", ctx)).rejects.toThrow(
			/unique constraint violated/,
		);
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
