// @euroclaw/better-auth — the better-auth integration across ALL THREE access concerns:
//   identity   → the actor, from `getSession`
//   membership → the active org + role, from `getActiveMember`
//   authz      → delegated to `hasPermission` (re-exported from @euroclaw/policy-better-auth)
// Each piece takes only the FUNCTION it needs (not the `auth` object), so it's vendor-neutral in
// shape and testable with a fake. `betterAuthAccess({ auth })` is the convenience that wires all
// three from one instance — the "specify exactly what you need, not auth" pattern, with one entry.

import { type Principal, userPrincipal } from "@euroclaw/contracts";
import {
	type BetterAuthAccessControlConfig,
	betterAuthAccessControl,
} from "@euroclaw/policy-better-auth";

// The minimal slices each concern needs — structural, so any better-auth-shaped instance satisfies them.
type GetSession = (input: {
	headers: unknown;
}) => Promise<{ user: { id: string } } | null>;
type GetActiveMember = (input: {
	headers: unknown;
}) => Promise<{ organizationId: string; role: string | string[] } | null>;

/** Resolve the operator (the `principal`) from a better-auth session — needs only `getSession`. */
export function betterAuthIdentity(deps: { getSession: GetSession }) {
	return async (ctx: Record<string, unknown>): Promise<Principal | undefined> => {
		// Tag the host's user id into the `user:<id>` principal at the point it is PRODUCED (matching
		// sessionIdentity), so the stamped principal is a legible, authorizable identity — never a bare
		// host id. A blank session ⇒ undefined.
		const id = (await deps.getSession({ headers: ctx.headers }))?.user.id;
		return id === undefined ? undefined : userPrincipal(id);
	};
}

/** Resolve the active org + role from a better-auth member — needs only `getActiveMember`. */
export function betterAuthTeam(deps: { getActiveMember: GetActiveMember }) {
	return async (
		ctx: Record<string, unknown>,
	): Promise<{ team: string; role: string } | undefined> => {
		const member = await deps.getActiveMember({ headers: ctx.headers });
		if (!member) return undefined;
		return {
			team: member.organizationId,
			role: Array.isArray(member.role) ? member.role.join(",") : member.role,
		};
	};
}

/** The slice of a better-auth instance the bundle reads: identity + membership + authz, one place. */
export type BetterAuthLike = BetterAuthAccessControlConfig["auth"] & {
	api: { getSession: GetSession; getActiveMember: GetActiveMember };
};

/**
 * Wire identity + membership + authz from ONE better-auth instance. Spread the pieces into the claw:
 *   const ba = betterAuthAccess({ auth })
 *   euroclaw({ model, identity: ba.identity, membership: ba.membership, plugins: [ba.authz] })
 * (Named `betterAuthAccess`, not `betterAuth`, to avoid clashing with better-auth's own `betterAuth`.)
 */
export function betterAuthAccess(config: { auth: BetterAuthLike }): {
	identity: (ctx: Record<string, unknown>) => Promise<Principal | undefined>;
	membership: (
		ctx: Record<string, unknown>,
	) => Promise<{ team: string; role: string } | undefined>;
	authz: ReturnType<typeof betterAuthAccessControl>;
} {
	const { auth } = config;
	return {
		identity: betterAuthIdentity({ getSession: auth.api.getSession }),
		membership: betterAuthTeam({ getActiveMember: auth.api.getActiveMember }),
		authz: betterAuthAccessControl({ auth }),
	};
}

export type { BetterAuthAccessControlConfig } from "@euroclaw/policy-better-auth";
export { betterAuthAccessControl } from "@euroclaw/policy-better-auth";
