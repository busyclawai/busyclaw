// The code-owned system posture (@euroclaw/authz) compiled through the reference Cedar engine — the
// posture is a plain string in authz (no cedar dep there); this is where it meets cedar-wasm. Proves
// it parses at construction and yields reads-run / writes-confirm / autonomous-floor decisions.

import {
	type AuthzActionInput,
	actionEntitiesFromModel,
	buildAuthzModel,
	cedarEngine,
	SYSTEM_POSTURE,
} from "@euroclaw/authz";
import type { PolicyRequest } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";

const model = buildAuthzModel([
	{ id: "readDoc", source: "tool", governance: { access: "read" } },
	{ id: "writeDoc", source: "tool", governance: { access: "write" } },
] satisfies AuthzActionInput[]);

function engine(policies: string) {
	return cedarEngine({
		policies,
		entities: actionEntitiesFromModel(model) as never,
	});
}

const req = (
	action: string,
	context: Record<string, unknown> = {},
): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: action },
	resource: { type: "Tool", id: action },
	context,
});

describe("SYSTEM_POSTURE through cedar", () => {
	it("parses at construction (no configurationError on the seeded text)", () => {
		expect(() => engine(SYSTEM_POSTURE)).not.toThrow();
	});

	it("reads run", async () => {
		const e = engine(SYSTEM_POSTURE);
		expect((await e.authorize(req("readDoc"))).decision).toBe("permit");
	});

	it("writes need confirmation — needs-approval, never a silent permit", async () => {
		const e = engine(SYSTEM_POSTURE);
		const result = await e.authorize(
			req("writeDoc", { runMode: "interactive" }),
		);
		expect(result.decision).toBe("needs-approval");
	});

	it("a customer permit relaxes a known-interactive write but not an autonomous one", async () => {
		// A customer slice permits writes outright, laid over the sealed posture. runMode is stamped
		// on every real request (runtime + mapCall guarantee it is present, default autonomous), so the
		// floor conditions on it directly: interactive relaxes, autonomous/unknown stays gated.
		const withPermit = `${SYSTEM_POSTURE}\npermit(principal, action in Action::"writes", resource);`;
		const e = engine(withPermit);
		// interactive: a human is present → the customer permit applies → the write runs.
		expect(
			(await e.authorize(req("writeDoc", { runMode: "interactive" }))).decision,
		).toBe("permit");
		// autonomous: no human → the floor forbids; confirming would unblock → needs-approval, never ok.
		expect(
			(await e.authorize(req("writeDoc", { runMode: "autonomous" }))).decision,
		).toBe("needs-approval");
	});
});

describe("named policies — the determining-policy trail names the RULE", () => {
	it("the floor's own rules are named, not positional", async () => {
		const e = engine(SYSTEM_POSTURE);
		// A read: the trail names the floor rule that permitted it.
		expect((await e.authorize(req("readDoc"))).policies).toEqual([
			"floor:reads-run",
		]);
		// An unconfirmed autonomous write parks. The trail on a needs-approval is the PROBE's — it names
		// the rule that WOULD permit once confirmed, not the forbid that blocked it. That is the useful
		// end: it says which confirmation requirement fired, which is what an escalation routes on.
		const parked = await e.authorize(req("writeDoc", { runMode: "autonomous" }));
		expect(parked.decision).toBe("needs-approval");
		expect(parked.policies).toEqual(["floor:writes-need-confirmation"]);
	});

	it("a HARD deny names the forbid that blocked it", async () => {
		const e = engine(
			`${SYSTEM_POSTURE}\n@id("deny:tool-blocked") forbid(principal, action == Action::"readDoc", resource);`,
		);
		// Confirmation cannot unblock a forbid, so this stays a deny — and the trail names the rule.
		const denied = await e.authorize(req("readDoc"));
		expect(denied.decision).toBe("deny");
		expect(denied.policies).toContain("deny:tool-blocked");
	});

	it("an @id on a customer slice reaches the trail — the escalation/audit channel", async () => {
		const slice = `@id("escalate:accessibility-team")
permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };`;
		const e = engine(`${SYSTEM_POSTURE}\n${slice}`);
		// The probe flips this to needs-approval, and the trail carries the slice's OWN name — which is
		// what lets the app route the approval to a queue without inventing a second decision channel.
		const parked = await e.authorize(req("writeDoc", { runMode: "autonomous" }));
		expect(parked.decision).toBe("needs-approval");
		expect(parked.policies).toContain("escalate:accessibility-team");
	});

	it("un-annotated policies keep cedar's positional id (no regression)", async () => {
		const e = engine(`permit(principal, action in Action::"reads", resource);`);
		expect((await e.authorize(req("readDoc"))).policies).toEqual(["policy0"]);
	});

	it("a duplicate @id fails LOUD at construction", () => {
		const dupe = `@id("same") permit(principal, action in Action::"reads", resource);
@id("same") permit(principal, action in Action::"writes", resource);`;
		expect(() => engine(dupe)).toThrow(/duplicate Cedar policy id: same/);
	});
});
