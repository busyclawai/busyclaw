import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	CLAW_ID_CONTEXT_KEY,
	ORGANIZATION_CONTEXT_KEY,
	ROLE_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	stampedFacts,
	TEAM_CONTEXT_KEY,
} from "../src/index";

describe("stampedFacts — the one typed reader of the reserved identity stamps", () => {
	it("reads facts stamped under the *_CONTEXT_KEY constants and renames them (drift guard)", () => {
		// Built FROM the constants — if a key constant and the schema's literal keys ever drift,
		// this test fails.
		const ctx = {
			principal: "alice",
			[ROLE_CONTEXT_KEY]: "approver",
			[TEAM_CONTEXT_KEY]: "payments",
			[CLAW_ID_CONTEXT_KEY]: "claw-1",
			[ORGANIZATION_CONTEXT_KEY]: "org-a",
			[RUN_MODE_CONTEXT_KEY]: "autonomous",
		};
		expect(stampedFacts(ctx)).toEqual({
			role: "approver",
			team: "payments",
			clawId: "claw-1",
			organizationId: "org-a",
			runMode: "autonomous",
		});
	});

	it("absent stamps stay absent; unrelated and other reserved keys are ignored", () => {
		const facts = stampedFacts({
			principal: "alice",
			euroclaw__principal: "alice",
			hostKey: 42,
		});
		expect(facts).toEqual({});
	});

	it("a garbage stamp fails loud — never silently unstamped", () => {
		expect(stampedFacts({ [RUN_MODE_CONTEXT_KEY]: "batch" })).toBeInstanceOf(
			type.errors,
		);
		expect(stampedFacts({ [ROLE_CONTEXT_KEY]: 42 })).toBeInstanceOf(
			type.errors,
		);
	});
});
