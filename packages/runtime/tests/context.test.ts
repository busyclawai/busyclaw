import {
	ACTOR_CONTEXT_KEY,
	type ContextResolver,
	ORGANIZATION_CONTEXT_KEY,
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
		// sessionIdentity tags the host id at the producing boundary — the stamped actor is `user:alice`.
		expect((await resolve({ headers: "tok" }))[ACTOR_CONTEXT_KEY]).toBe(
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

		expect(ctx[ACTOR_CONTEXT_KEY]).toBe("bob");
		expect(ctx[ROLE_CONTEXT_KEY]).toBe("approver");
	});

	it("resolves organization through a trusted resolver", async () => {
		const resolve = resolverFor({
			organization: () => "organization-1",
		});

		expect((await resolve({}))[ORGANIZATION_CONTEXT_KEY]).toBe(
			"organization-1",
		);
	});
});
