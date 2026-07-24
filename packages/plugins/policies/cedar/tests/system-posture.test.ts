// The code-owned system posture (@euroclaw/authz) compiled through the reference Cedar engine — the
// posture is a NAMED set of plain text in authz (no cedar dep there); this is where it meets
// cedar-wasm. Proves it parses at construction, yields reads-run / writes-confirm / autonomous-floor
// decisions, and that a decision's determining-policy trail reports the rule's NAME.

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

function engine(policies: string | Readonly<Record<string, string>>) {
	return cedarEngine({
		policies,
		entities: actionEntitiesFromModel(model) as never,
	});
}

/** The floor plus a named customer slice — the shape `loadPolicyBundle` produces. */
const withSlice = (name: string, cedar: string) => ({
	...SYSTEM_POSTURE,
	[name]: cedar,
});

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
		const withPermit = withSlice(
			"customer:allow-writes",
			`permit(principal, action in Action::"writes", resource);`,
		);
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
			withSlice(
				"deny:tool-blocked",
				`forbid(principal, action == Action::"readDoc", resource);`,
			),
		);
		// Confirmation cannot unblock a forbid, so this stays a deny — and the trail names the rule.
		const denied = await e.authorize(req("readDoc"));
		expect(denied.decision).toBe("deny");
		expect(denied.policies).toContain("deny:tool-blocked");
	});

	it("a slice's own NAME reaches the trail — the escalation/audit channel", async () => {
		const e = engine(
			withSlice(
				"escalate:accessibility-team",
				`permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };`,
			),
		);
		// The probe flips this to needs-approval and the trail carries the slice's own name — nothing had
		// to be annotated. That is what lets the app route the approval to a queue without inventing a
		// second decision channel (Cedar itself can only ever answer allow/deny).
		const parked = await e.authorize(req("writeDoc", { runMode: "autonomous" }));
		expect(parked.decision).toBe("needs-approval");
		expect(parked.policies).toContain("escalate:accessibility-team");
	});

	it("a slice holding SEVERAL policies is split into <name>#<i>", async () => {
		const e = engine(
			withSlice(
				"customer:pair",
				`forbid(principal, action == Action::"readDoc", resource);
permit(principal, action in Action::"writes", resource);`,
			),
		);
		// cedar-wasm takes one policy per id, so the pair is indexed under the slice's name — still the
		// managed handle, and stable as long as the slice's own contents don't move.
		const denied = await e.authorize(req("readDoc"));
		expect(denied.decision).toBe("deny");
		expect(denied.policies).toContain("customer:pair#0");
	});

	it("plain policy TEXT still works — cedar assigns its own positional ids", async () => {
		const e = engine(`permit(principal, action in Action::"reads", resource);`);
		expect((await e.authorize(req("readDoc"))).policies).toEqual(["policy0"]);
	});
});
