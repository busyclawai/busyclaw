// slice proof at the authz layer: `decideApiCall` over `cedarApiEngine` + the GENERIC `API_ACCESS_
// BASELINE` (owner ∪ scope-member ∪ grant + create-permit), evaluated as REAL CEDAR over a per-request
// ENTITY GRAPH — owner is entity/attr equality, scope-member and grant are leveled Cedar `in`. Every
// branch is proven GENERICALLY through stubs — no org plugin, no access_grant table — so the policies
// are shown to read the opaque SHAPE (`createdBy`/`scope`/`scopeId`/`grants`) and the caller's opaque
// memberships, never a kind/tier/role, and the LEVEL ordering (`read < use < manage`) is Cedar's, not a
// TS compare.

import { describe, expect, it } from "vitest";
import {
	API_ACCESS_BASELINE,
	type ApiMembership,
	type ApiResourceShape,
	cedarApiEngine,
	decideApiCall,
} from "../src/index";

// The api engine's live policy set: the generic baseline (owner ∪ scope ∪ grant + create-permit) — the
// exact system floor the assembly compiles, minus plugin slices. `createClaw` is a create method (in the
// `creates` action group) so the create-permit reaches it.
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
}) {
	return decideApiCall({
		engine,
		method: input.method,
		level: input.level,
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

	it("a blank / whitespace principal → deny (never equals a sentinel createdBy)", async () => {
		for (const blank of ["", "   ", "\t"]) {
			const result = await decide({
				method: "getClaw",
				level: "read",
				principal: blank,
				resource: aliceClaw,
			});
			expect(result.decision).toBe("deny");
			expect(result.reason).toContain("actor floor");
		}
	});
});

describe("decideApiCall — owner (LIVE, entity/attr equality)", () => {
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

describe("decideApiCall — fail-closed resource shape", () => {
	it("no createdBy, no scope, no grants → deny even at the lowest level (proves the DENY_SHAPE denies)", async () => {
		const result = await decide({
			method: "getClaw",
			level: "read",
			principal: BOB,
			resource: { grants: [] },
		});
		expect(result.decision).toBe("deny");
	});
});

describe("decideApiCall — scope-membership (generic, stubbed, leveled Cedar `in`)", () => {
	it("level ordering: a use-member passes read/use but is denied manage; a manage-member passes manage", async () => {
		// BOB holds a `use`-level membership in the resource's OWN opaque scope — proving the branch reads
		// resource.scope/scopeId (here "team"/"team-eng"), never a hardcoded "organization", and that the
		// level ordering is Cedar's `in`, not a TS compare.
		const useMember: ApiMembership = {
			scope: "team",
			scopeId: "team-eng",
			level: "use",
		};
		// use satisfies a read requirement (use in read) …
		expect(
			(
				await decide({
					method: "getClaw",
					level: "read",
					principal: BOB,
					resource: aliceClaw,
					memberships: [useMember],
				})
			).decision,
		).toBe("permit");
		// … and a use requirement (self) …
		expect(
			(
				await decide({
					method: "getClaw",
					level: "use",
					principal: BOB,
					resource: aliceClaw,
					memberships: [useMember],
				})
			).decision,
		).toBe("permit");
		// … but NOT a manage requirement (manage is a child of use — not reachable upward).
		expect(
			(
				await decide({
					method: "updateClaw",
					level: "manage",
					principal: BOB,
					resource: aliceClaw,
					memberships: [useMember],
				})
			).decision,
		).toBe("deny");
		// a manage-member satisfies the manage requirement.
		expect(
			(
				await decide({
					method: "updateClaw",
					level: "manage",
					principal: BOB,
					resource: aliceClaw,
					memberships: [
						{ scope: "team", scopeId: "team-eng", level: "manage" },
					],
				})
			).decision,
		).toBe("permit");
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

describe("decideApiCall — grant (generic, stubbed as data, leveled Cedar `in`)", () => {
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

	it("a grant below the required level → deny (Cedar level ordering, not a TS compare)", async () => {
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
	it("any authenticated principal may create (routed by the `creates` action group); absent still denies", async () => {
		const created = await decide({
			method: "createClaw",
			level: "manage",
			principal: BOB,
			resource: { grants: [] },
		});
		expect(created.decision).toBe("permit");

		const anon = await decide({
			method: "createClaw",
			level: "manage",
			principal: undefined,
			resource: { grants: [] },
		});
		expect(anon.decision).toBe("deny");
	});
});
