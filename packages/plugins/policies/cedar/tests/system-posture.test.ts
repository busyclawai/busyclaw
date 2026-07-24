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
