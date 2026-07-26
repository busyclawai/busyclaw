import {
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	type ContextResolver,
	PRINCIPAL_CONTEXT_KEY,
	ROLE_CONTEXT_KEY,
	userPrincipal,
} from "@euroclaw/contracts";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createTeamStore } from "@euroclaw/storage-durable";
import { describe, expect, it } from "vitest";
import { composeContext, roleMembership, sessionIdentity } from "../src/index";

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

	it("resolves membership role through any roleOf lookup", async () => {
		const team = createTeamStore(memoryAdapter());
		const invite = await team.invite({
			team: "acme",
			email: "bob@x.com",
			role: "approver",
		});
		await team.accept(invite.id, "bob");

		const resolve = resolverFor({
			identity: () => "bob",
			membership: roleMembership({ roleOf: team.roleOf }),
		});
		const ctx = await resolve({ team: "acme" });

		expect(ctx[PRINCIPAL_CONTEXT_KEY]).toBe("bob");
		expect(ctx[ROLE_CONTEXT_KEY]).toBe("approver");
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
