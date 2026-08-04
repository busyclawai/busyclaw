import {
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	type ContextResolver,
	MEMBERSHIPS_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	userPrincipal,
} from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	composeContext,
	principalMemberships,
	sessionIdentity,
} from "../src/index";

function resolverFor(
	parts: Parameters<typeof composeContext>[0],
): ContextResolver {
	const resolver = composeContext(parts);
	if (!resolver) throw new Error("expected a resolver");
	return resolver;
}

describe("runtime context", () => {
	it("resolves a tagged user principal from a swappable session function", async () => {
		const resolve = resolverFor({
			identity: sessionIdentity({
				getSession: async ({ headers }) =>
					headers === "tok" ? { user: { id: "alice" } } : null,
			}),
		});
		// sessionIdentity tags the host id at the producing boundary — the stamped principal is `user:alice`.
		expect((await resolve({ headers: "tok" }))[PRINCIPAL_CONTEXT_KEY]).toBe(
			userPrincipal("alice"),
		);
	});

	it("resolves EVERY membership through any membershipsOf lookup", async () => {
		// A plugin's lookup, standing in for the real one — core ships no membership store, so the seam
		// is only ever fed from outside.
		const membershipsOf = async (principal: string) =>
			principal === userPrincipal("bob")
				? [
						{ scope: "team", scopeId: "acme", role: "approver" },
						{ scope: "team", scopeId: "platform", role: "member" },
					]
				: [];

		const resolve = resolverFor({
			identity: () => userPrincipal("bob"),
			membership: principalMemberships({ membershipsOf }),
		});
		// No `team` on the context: which boundary is "active" is not an input any more. The predecessor
		// had to be told, because it could carry only one.
		const ctx = await resolve({});

		expect(ctx[PRINCIPAL_CONTEXT_KEY]).toBe(userPrincipal("bob"));
		expect(ctx[MEMBERSHIPS_CONTEXT_KEY]).toEqual([
			{ scope: "team", scopeId: "acme", role: "approver" },
			{ scope: "team", scopeId: "platform", role: "member" },
		]);
	});

	it("resolves the config scope through a trusted resolver", async () => {
		const resolve = resolverFor({
			configScope: () => ({ scope: "organization", scopeId: "organization-1" }),
		});

		// Both halves land, or neither — half a key names no boundary.
		const ctx = await resolve({});
		expect(ctx[CONFIG_SCOPE_CONTEXT_KEY]).toBe("organization");
		expect(ctx[CONFIG_SCOPE_ID_CONTEXT_KEY]).toBe("organization-1");
	});
});
