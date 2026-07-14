// slice-1 proof at the authz layer: `decideApiCall` over `cedarApiEngine` + the GENERIC `API_ACCESS_
// BASELINE` (owner ∪ scope-member ∪ grant + create-permit). Every branch is proven GENERICALLY through
// stubs — no org plugin, no access_grant table — so the policies are shown to read the opaque SHAPE
// (`createdBy`/`scope`/`scopeId`/`grants`) and the caller's resolved level facts, never a kind/tier/role.

import { describe, expect, it } from "vitest";
import {
	API_ACCESS_BASELINE,
	type ApiMembership,
	type ApiResourceShape,
	cedarApiEngine,
	decideApiCall,
} from "../src/index";

// The api engine's live policy set: the generic baseline (owner ∪ scope ∪ grant + create-permit) —
// the exact system floor the assembly compiles, minus plugin slices.
const engine = cedarApiEngine({
	policies: API_ACCESS_BASELINE,
	methods: ["getClaw", "updateClaw", "createClaw"],
	createMethods: ["createClaw"],
});

const ALICE = "user:alice";
const BOB = "user:bob";

/** A claw owned by ALICE, in an opaque scope, no grants — the baseline resource for the tests. */
const aliceClaw: ApiResourceShape = {
	createdBy: ALICE,
	scope: "team",
	scopeId: "team-eng",
	grants: [],
};

function decide(input: {
	method: string;
	level: "read" | "use" | "manage";
	principal: string | undefined;
	resource?: ApiResourceShape;
	memberships?: readonly ApiMembership[];
	isCreate?: boolean;
}) {
	return decideApiCall({
		engine,
		method: input.method,
		level: input.level,
		isCreate: input.isCreate ?? false,
		principal: input.principal,
		resource: input.resource ?? { grants: [] },
		memberships: input.memberships ?? [],
	});
}

describe("decideApiCall — the actor floor", () => {
	it("no caller principal → deny (never reaches the engine)", async () => {
		const result = await decide({
			method: "getClaw",
			level: "read",
			principal: undefined,
			resource: aliceClaw,
		});
		expect(result.decision).toBe("deny");
		expect(result.reason).toContain("actor floor");
	});
});

describe("decideApiCall — owner (LIVE)", () => {
	it("createdBy == caller → permit at every level", async () => {
		for (const level of ["read", "use", "manage"] as const) {
			const result = await decide({
				method: "getClaw",
				level,
				principal: ALICE,
				resource: aliceClaw,
			});
			expect(result.decision).toBe("permit");
		}
	});

	it("a different principal, no membership/grant → deny", async () => {
		const result = await decide({
			method: "getClaw",
			level: "read",
			principal: BOB,
			resource: aliceClaw,
		});
		expect(result.decision).toBe("deny");
	});
});

describe("decideApiCall — scope-membership (generic, stubbed)", () => {
	it("a (scope,scopeId) membership at level ≥ required → permit; below → deny", async () => {
		// BOB holds a `use`-level membership in the resource's OWN opaque scope — proving the branch
		// reads resource.scope/scopeId (here "team"/"team-eng"), never a hardcoded "organization".
		const membership: ApiMembership = {
			scope: "team",
			scopeId: "team-eng",
			level: "use",
		};
		const permitted = await decide({
			method: "getClaw",
			level: "read",
			principal: BOB,
			resource: aliceClaw,
			memberships: [membership],
		});
		expect(permitted.decision).toBe("permit");

		const denied = await decide({
			method: "updateClaw",
			level: "manage",
			principal: BOB,
			resource: aliceClaw,
			memberships: [membership],
		});
		expect(denied.decision).toBe("deny");
	});

	it("a membership in a DIFFERENT scopeId does not match (opaque id compare)", async () => {
		const result = await decide({
			method: "getClaw",
			level: "read",
			principal: BOB,
			resource: aliceClaw,
			memberships: [{ scope: "team", scopeId: "team-sales", level: "manage" }],
		});
		expect(result.decision).toBe("deny");
	});
});

describe("decideApiCall — grant (generic, stubbed as data)", () => {
	it("a direct user grant at level ≥ required → permit", async () => {
		const result = await decide({
			method: "getClaw",
			level: "read",
			principal: BOB,
			resource: { ...aliceClaw, grants: [{ principalRef: BOB, level: "use" }] },
		});
		expect(result.decision).toBe("permit");
	});

	it("a team grant reaches a member of that team; a `public` grant reaches anyone", async () => {
		// team grant: BOB isn't the ref, but holds a membership whose <scope>:<scopeId> == the ref.
		const teamGrant = await decide({
			method: "getClaw",
			level: "read",
			principal: BOB,
			resource: {
				...aliceClaw,
				grants: [{ principalRef: "team:team-eng", level: "manage" }],
			},
			memberships: [{ scope: "team", scopeId: "team-eng", level: "read" }],
		});
		expect(teamGrant.decision).toBe("permit");

		const publicGrant = await decide({
			method: "getClaw",
			level: "read",
			principal: "user:stranger",
			resource: {
				...aliceClaw,
				grants: [{ principalRef: "public", level: "read" }],
			},
		});
		expect(publicGrant.decision).toBe("permit");
	});

	it("a grant below the required level → deny", async () => {
		const result = await decide({
			method: "updateClaw",
			level: "manage",
			principal: BOB,
			resource: { ...aliceClaw, grants: [{ principalRef: BOB, level: "use" }] },
		});
		expect(result.decision).toBe("deny");
	});
});

describe("decideApiCall — create-permit", () => {
	it("any authenticated principal may create; absent principal still denies", async () => {
		const created = await decide({
			method: "createClaw",
			level: "manage",
			principal: BOB,
			isCreate: true,
			resource: { grants: [] },
		});
		expect(created.decision).toBe("permit");

		const anon = await decide({
			method: "createClaw",
			level: "manage",
			principal: undefined,
			isCreate: true,
			resource: { grants: [] },
		});
		expect(anon.decision).toBe("deny");
	});
});
