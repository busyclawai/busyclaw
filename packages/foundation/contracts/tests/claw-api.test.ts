// The claw product-api wire protocol: the shared base method-name list (server route table and
// remote client both derive from it) and the response envelope parser (untrusted network JSON is
// validated, never cast). The list↔ClawApi equality itself is compile-checked in euroclaw.

import { describe, expect, it } from "vitest";
import { CLAW_API_METHOD_NAMES, parseClawResponseEnvelope } from "../src/index";

describe("CLAW_API_METHOD_NAMES — the shared base method list", () => {
	it("contains no duplicates (each name is one route)", () => {
		expect(new Set(CLAW_API_METHOD_NAMES).size).toBe(
			CLAW_API_METHOD_NAMES.length,
		);
	});

	it("holds camelCase identifiers only — kebab derivation must be lossless", () => {
		for (const name of CLAW_API_METHOD_NAMES) {
			expect(name).toMatch(/^[a-z][a-zA-Z]*$/);
		}
	});
});

describe("parseClawResponseEnvelope", () => {
	it("accepts the success and error envelope shapes", () => {
		expect(
			parseClawResponseEnvelope({ data: { id: "c-1" }, ok: true }),
		).toEqual({ data: { id: "c-1" }, ok: true });
		expect(
			parseClawResponseEnvelope({
				error: { code: "EUROCLAW_VALIDATION_FAILED", message: "bad input" },
				ok: false,
			}),
		).toEqual({
			error: { code: "EUROCLAW_VALIDATION_FAILED", message: "bad input" },
			ok: false,
		});
	});

	it("returns undefined for anything that is not an envelope", () => {
		expect(
			parseClawResponseEnvelope("<html>bad gateway</html>"),
		).toBeUndefined();
		expect(parseClawResponseEnvelope(null)).toBeUndefined();
		expect(parseClawResponseEnvelope({ error: { code: 500 } })).toBeUndefined();
		expect(
			parseClawResponseEnvelope({ error: { message: 42 }, ok: false }),
		).toBeUndefined();
	});
});
