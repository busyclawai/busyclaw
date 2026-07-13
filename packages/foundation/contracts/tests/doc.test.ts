// The euroclaw doc meta channel: authoring is plain `.configure({ euroclaw: { doc } })` (typed by
// the ArkEnv augmentation in governance/doc.ts) and every consumer reads through the ONE `docOf`.
// The runtime spot-check the plan demands lives here: arktype must PRESERVE the namespaced key at
// runtime — the whole channel rides an undeclared-at-runtime meta key — and attaching it must
// leave validation behavior untouched.

import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { docOf } from "../src/index";

/** Guard-narrowed error summary — the test fails loud when validation unexpectedly passed. */
function summaryOf(result: unknown): string {
	if (result instanceof type.errors) return result.summary;
	throw new Error("expected validation to fail");
}

describe("the doc channel survives arktype at runtime", () => {
	it("configure({ euroclaw: { doc } }) preserves the key — t.meta carries it", () => {
		const t = type("string").configure({ euroclaw: { doc: "x" } });
		expect(t.meta.euroclaw).toEqual({ doc: "x" });
	});

	it("leaves validation behavior unchanged", () => {
		const plain = type("string");
		const documented = type("string").configure({ euroclaw: { doc: "x" } });
		expect(documented("hi")).toBe("hi");
		expect(summaryOf(documented(42))).toBe(summaryOf(plain(42)));
	});
});

describe("docOf — the one reader, precedence built in", () => {
	it("euroclaw.doc beats the described text", () => {
		const t = type("string")
			.describe("a terse summary")
			.configure({ euroclaw: { doc: "Rich documentation prose." } });
		expect(docOf(t)).toBe("Rich documentation prose.");
	});

	it("falls back to the .describe() text", () => {
		expect(docOf(type("string").describe("a terse summary"))).toBe(
			"a terse summary",
		);
	});

	it("returns undefined when the schema carries no user-authored prose", () => {
		const t = type("string");
		// arktype always SYNTHESIZES Type.description ("a string") — that is error-message
		// rendering, not documentation, so docOf must not surface it.
		expect(t.description).toBe("a string");
		expect(docOf(t)).toBeUndefined();
	});

	it("reads non-meta-carrying values as undocumented (route tables hold loose callables)", () => {
		expect(docOf(undefined)).toBeUndefined();
		expect(docOf(null)).toBeUndefined();
		expect(docOf((input: unknown) => input)).toBeUndefined();
		expect(docOf({ meta: "not an object" })).toBeUndefined();
	});
});

describe(".describe() text still drives error messages unchanged", () => {
	it("attaching euroclaw.doc does not alter the error summary", () => {
		const described = type("string").describe("a secret name");
		const both = described.configure({ euroclaw: { doc: "Rich prose." } });
		expect(summaryOf(described(42))).toBe(
			"must be a secret name (was a number)",
		);
		expect(summaryOf(both(42))).toBe(summaryOf(described(42)));
	});
});
