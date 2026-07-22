// Word-code placeholders + fuzzy recovery on rehydrate. A model (especially a cheap one) may corrupt
// a token; recovery snaps it back — but ONLY when the repair resolves in-container and is unambiguous,
// so it can never invent a value or cross to another subject. Identity is container-scoped now, so a
// namesake token in another container is a different mapping, never a collision.
//
// The recovery-logic cases use the `email` kind (the generic word book), with fixtures from wordlist.ts:
// `apache`/`apxche` is a unique single-edit repair; `baacus` repairs ambiguously to {abacus, caucus}
// through the full-scan path. The `name` kind draws from a separate NAME book and is covered on its own.
import type { Detector, PiiKind, PiiSpan } from "@euroclaw/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMemoryPiiMappingStore, createStoredRedactor } from "../src/index";
import { NAME_SET } from "../src/wordlist";

/** A detector that flags Alice/Bob/Zoe as the given kind — lets one helper drive both books. */
const detectorFor =
	(kind: PiiKind): Detector =>
	(text) => {
		const spans: PiiSpan[] = [];
		for (const match of text.matchAll(/Alice|Bob|Zoe/g)) {
			const value = match[0];
			if (value === undefined) continue;
			const start = match.index ?? 0;
			spans.push({ start, end: start + value.length, value, kind, source: "regex" });
		}
		return spans;
	};

const ctxA = { scope: "claw", scopeId: "a" };
const ctxB = { scope: "claw", scopeId: "b" };
const born = "2026-07-22T00:00:00.000Z";

/** Save a mapping under a chosen placeholder so recovery has a known target. */
function seed(
	store: ReturnType<typeof createMemoryPiiMappingStore>,
	placeholder: string,
	original: string,
	ctx: { scope: string; scopeId: string },
	subjectIds?: string[],
) {
	return store.save(
		{ placeholder, original, kind: "email", scope: ctx.scope, scopeId: ctx.scopeId, createdAt: born },
		subjectIds,
	);
}

describe("word-code placeholders", () => {
	it("mints a hyphen-joined 4-word generic code, not hex", async () => {
		const redactor = createStoredRedactor({
			detector: detectorFor("email"),
			mappings: createMemoryPiiMappingStore(),
		});
		const out = await redactor.redactValue("Hi Zoe", ctxA);
		expect(out).toMatch(/^Hi \{\{pii:email:[a-z]+(?:-[a-z]+){3}\}\}$/);
	});

	it("round-trips exactly, recovery off or on", async () => {
		for (const recover of [false, true]) {
			const redactor = createStoredRedactor({
				detector: detectorFor("email"),
				mappings: createMemoryPiiMappingStore(),
				recover,
			});
			const redacted = await redactor.redactValue("Hi Zoe", ctxA);
			expect(await redactor.rehydrateValue(redacted, ctxA)).toBe("Hi Zoe");
		}
	});
});

describe("recovery of a mangled token", () => {
	it("repairs a typo'd word when recovery is on (and leaves it when off)", async () => {
		const warn = vi.fn();
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:apache-blizzard}}", "Zoe", ctxA);

		// apache -> apxche: one substitution → snaps uniquely back to "apache".
		const mangled = "call {{pii:email:apxche-blizzard}} now";

		const off = createStoredRedactor({ mappings: store, recover: false });
		expect(await off.rehydrateValue(mangled, ctxA)).toBe(mangled);

		const on = createStoredRedactor({ mappings: store, recover: true, warn });
		expect(await on.rehydrateValue(mangled, ctxA)).toBe("call Zoe now");
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recovered/));
	});

	it("repairs structural damage — dropped braces and spaced separators", async () => {
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:apache-blizzard}}", "Zoe", ctxA);
		const on = createStoredRedactor({ mappings: store, recover: true });

		expect(await on.rehydrateValue("hi {pii:email:apache-blizzard} bye", ctxA)).toBe(
			"hi Zoe bye",
		);
		expect(
			await on.rehydrateValue("hi {{pii: email : apache blizzard}} bye", ctxA),
		).toBe("hi Zoe bye");
	});

	it("still rehydrates a healthy token when recovery is on (no repair needed)", async () => {
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:apache-blizzard}}", "Zoe", ctxA);
		const on = createStoredRedactor({ mappings: store, recover: true });
		expect(await on.rehydrateValue("hi {{pii:email:apache-blizzard}}", ctxA)).toBe("hi Zoe");
	});
});

describe("recovery is fail-safe", () => {
	it("recovers when the repair is unambiguous (one saved value)", async () => {
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:abacus-blizzard}}", "Bob", ctxA);
		const on = createStoredRedactor({ mappings: store, recover: true });
		// baacus -> {abacus, caucus}; only abacus-blizzard is saved → single value → recover.
		expect(await on.rehydrateValue("{{pii:email:baacus-blizzard}}", ctxA)).toBe("Bob");
	});

	it("REFUSES when repairs resolve to two different values (never guesses a subject)", async () => {
		const warn = vi.fn();
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:abacus-blizzard}}", "Alice", ctxA);
		await seed(store, "{{pii:email:caucus-blizzard}}", "Bob", ctxA);
		const on = createStoredRedactor({ mappings: store, recover: true, warn });

		// baacus -> {abacus, caucus}; both resolve to different values → ambiguous → refuse.
		const out = await on.rehydrateValue("see {{pii:email:baacus-blizzard}} today", ctxA);
		expect(out).toBe("see {{pii:email:baacus-blizzard}} today"); // untouched
		expect(out).not.toContain("Alice");
		expect(out).not.toContain("Bob");
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refused|ambiguous/));
	});

	it("does not cross the container fence even with recovery on", async () => {
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:apache-blizzard}}", "Zoe", ctxA);
		const on = createStoredRedactor({ mappings: store, recover: true });
		// A perfectly repairable token, but resolved in the WRONG container → left as-is.
		expect(await on.rehydrateValue("{{pii:email:apxche-blizzard}}", ctxB)).toBe(
			"{{pii:email:apxche-blizzard}}",
		);
	});
});

describe("name-styled tokens (the name book)", () => {
	it("mints a 3-word name-styled code drawn from the name pool, and recovers a typo", async () => {
		const store = createMemoryPiiMappingStore();
		const redactor = createStoredRedactor({
			detector: detectorFor("name"),
			mappings: store,
			recover: true,
		});
		const redacted = await redactor.redactValue("Hi Zoe", ctxA);
		const token = redacted.match(/\{\{pii:name:[a-z-]+\}\}/)?.[0] ?? "";
		const words = token.slice("{{pii:name:".length, -"}}".length).split("-");

		// Name style: three words, every one from the NAME pool (not the generic list).
		expect(words).toHaveLength(3);
		for (const word of words) expect(NAME_SET.has(word)).toBe(true);

		// Corrupt a middle char of the first name-word → recovers via the NAME book (edit>=3 → unique).
		const first = words[0] ?? "";
		const rest = words.slice(1);
		const typo = first.slice(0, 2) + (first[2] === "x" ? "q" : "x") + first.slice(3);
		const mangled = `{{pii:name:${[typo, ...rest].join("-")}}}`;
		expect(await redactor.rehydrateValue(mangled, ctxA)).toBe("Zoe");
	});
});

describe("container-scoped identity", () => {
	it("keeps two containers' same-code tokens distinct (no clobber)", async () => {
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:apache-blizzard}}", "Zoe", ctxA);
		await seed(store, "{{pii:email:apache-blizzard}}", "Yan", ctxB);
		expect(await store.resolve("{{pii:email:apache-blizzard}}", ctxA)).toBe("Zoe");
		expect(await store.resolve("{{pii:email:apache-blizzard}}", ctxB)).toBe("Yan");
	});

	it("erases a subject in its OWN container, sparing a namesake elsewhere", async () => {
		const store = createMemoryPiiMappingStore();
		await seed(store, "{{pii:email:apache-blizzard}}", "Zoe", ctxA, ["subject-1"]);
		await seed(store, "{{pii:email:apache-blizzard}}", "Yan", ctxB, ["subject-2"]);

		await store.deleteForSubject("subject-1");

		expect(await store.resolve("{{pii:email:apache-blizzard}}", ctxA)).toBeNull(); // erased
		expect(await store.resolve("{{pii:email:apache-blizzard}}", ctxB)).toBe("Yan"); // spared
	});
});
