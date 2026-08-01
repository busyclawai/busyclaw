import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	CLAW_ID_CONTEXT_KEY,
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	MEMBERSHIPS_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	stampedFacts,
} from "../src/index";

describe("stampedFacts — the one typed reader of the reserved identity stamps", () => {
	it("reads facts stamped under the *_CONTEXT_KEY constants and renames them (drift guard)", () => {
		// Built FROM the constants — if a key constant and the schema's literal keys ever drift,
		// this test fails.
		const ctx = {
			principal: "alice",
			[MEMBERSHIPS_CONTEXT_KEY]: [
				{ scope: "team", scopeId: "payments", role: "approver" },
				// A membership with no role at all — belonging and ranking are separate facts.
				{ scope: "betterauth", scopeId: "org_123" },
			],
			[CLAW_ID_CONTEXT_KEY]: "claw-1",
			[CONFIG_SCOPE_CONTEXT_KEY]: "organization",
			[CONFIG_SCOPE_ID_CONTEXT_KEY]: "org-a",
			[RUN_MODE_CONTEXT_KEY]: "autonomous",
		};
		expect(stampedFacts(ctx)).toEqual({
			memberships: [
				{ scope: "team", scopeId: "payments", role: "approver" },
				{ scope: "betterauth", scopeId: "org_123" },
			],
			clawId: "claw-1",
			configScope: "organization",
			configScopeId: "org-a",
			runMode: "autonomous",
		});
	});

	it("absent stamps stay absent; unrelated and other reserved keys are ignored", () => {
		const facts = stampedFacts({
			principal: "alice",
			busyclaw__principal: "alice",
			hostKey: 42,
		});
		expect(facts).toEqual({});
	});

	it("a garbage stamp fails loud — never silently unstamped", () => {
		expect(stampedFacts({ [RUN_MODE_CONTEXT_KEY]: "batch" })).toBeInstanceOf(
			type.errors,
		);
		expect(stampedFacts({ [MEMBERSHIPS_CONTEXT_KEY]: 42 })).toBeInstanceOf(
			type.errors,
		);
		// A membership missing its `scopeId` half is garbage too — a `<scope>:undefined` ref would match
		// nothing forever, which is the failure mode that never announces itself.
		expect(
			stampedFacts({ [MEMBERSHIPS_CONTEXT_KEY]: [{ scope: "team" }] }),
		).toBeInstanceOf(type.errors);
	});
});
