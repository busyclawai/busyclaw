import { describe, expect, it } from "vitest";
import {
	betterAuthAccess,
	betterAuthIdentity,
	betterAuthTeam,
} from "../src/index";

// A FAKE better-auth — no real instance. This IS the proof that each piece takes only a function:
// the whole bundle is exercised with three hand-written stubs.
const fakeAuth = {
	api: {
		getSession: async ({ headers }: { headers: unknown }) =>
			headers === "alice-token" ? { user: { id: "alice" } } : null,
		getActiveMember: async ({ headers }: { headers: unknown }) =>
			headers === "alice-token"
				? { organizationId: "acme", role: "approver" }
				: null,
		hasPermission: async () => true,
	},
};

describe("@euroclaw/better-auth — three concerns from one instance, each a function", () => {
	it("betterAuthIdentity resolves the actor from getSession", async () => {
		const identity = betterAuthIdentity({
			getSession: fakeAuth.api.getSession,
		});
		expect(await identity({ headers: "alice-token" })).toBe("user:alice");
		expect(await identity({ headers: "nope" })).toBeUndefined();
	});

	it("betterAuthTeam resolves { team, role } from the active member", async () => {
		const membership = betterAuthTeam({
			getActiveMember: fakeAuth.api.getActiveMember,
		});
		expect(await membership({ headers: "alice-token" })).toEqual({
			team: "acme",
			role: "approver",
		});
		expect(await membership({ headers: "nope" })).toBeUndefined();
	});

	it("a role ARRAY collapses to a comma string", async () => {
		const membership = betterAuthTeam({
			getActiveMember: async () => ({
				organizationId: "acme",
				role: ["approver", "admin"],
			}),
		});
		expect((await membership({ headers: "x" }))?.role).toBe("approver,admin");
	});

	it("betterAuthAccess({ auth }) wires identity + membership + the authz plugin from ONE auth", async () => {
		const ba = betterAuthAccess({ auth: fakeAuth });
		expect(await ba.identity({ headers: "alice-token" })).toBe("user:alice");
		expect(await ba.membership({ headers: "alice-token" })).toEqual({
			team: "acme",
			role: "approver",
		});
		// the authz piece is a real euroclaw plugin (a gate-bearing object)
		expect(typeof ba.authz.id).toBe("string");
		expect(Array.isArray(ba.authz.gates)).toBe(true);
	});
});
