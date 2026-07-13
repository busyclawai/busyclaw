// Identity & membership resolution — runtime-level wiring, composed into core's neutral
// `resolveContext` hook. Each is a FUNCTION (not a vendor object): a session-getter,
// a JWT decoder, a role lookup — vendor-neutral and testable with a fake.

import {
	type ContextResolver,
	ORGANIZATION_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	type Principal,
	ROLE_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	type TurnContext,
	userPrincipal,
} from "@euroclaw/contracts";

/** Resolves the accountable operator → the `principal` (or undefined). `() => SYSTEM_CRON` for background runs. */
export type IdentityResolver = (
	ctx: TurnContext,
) => Principal | undefined | Promise<Principal | undefined>;

/** The actor's membership for a run: which team, and their role on it. */
export type Membership = { team: string; role: string };

/** Resolves the actor's membership (team + role). Runs after identity (it needs the actor). */
export type MembershipResolver = (
	ctx: TurnContext,
) => Membership | undefined | Promise<Membership | undefined>;

/** Resolves the organization boundary for durable resources and PII mapping scopes. */
export type OrganizationResolver = (
	ctx: TurnContext,
) => string | undefined | Promise<string | undefined>;

/** Build an IdentityResolver from any session-getter — better-auth's, your own — just `getSession`. */
export function sessionIdentity(deps: {
	getSession: (input: {
		headers: unknown;
	}) => Promise<{ user: { id: string } } | null>;
}): IdentityResolver {
	return async (ctx) => {
		// Tag the host's user id into the `user:<id>` principal form at the point it is PRODUCED, so the
		// stamped PRINCIPAL_CONTEXT_KEY is a legible principal — and matches the tagged `scopeId` the store
		// api writes for the same user (the store-resolution round-trip). A blank session ⇒ undefined.
		const id = (await deps.getSession({ headers: ctx.headers }))?.user.id;
		return id === undefined ? undefined : userPrincipal(id);
	};
}

/** Build a MembershipResolver from any `roleOf(team, actor)` lookup — the native team store, better-auth, your own. */
export function roleMembership(deps: {
	roleOf: (
		team: string,
		actor: string,
	) => string | null | Promise<string | null>;
	/** Where the active team comes from in `ctx`. Default: a non-reserved `team` key. */
	team?: (ctx: TurnContext) => string | undefined;
}): MembershipResolver {
	const teamOf =
		deps.team ??
		((ctx) => (typeof ctx.team === "string" ? ctx.team : undefined));
	return async (ctx) => {
		const team = teamOf(ctx);
		const actor = ctx[PRINCIPAL_CONTEXT_KEY];
		if (team === undefined || typeof actor !== "string") return undefined;
		const role = await deps.roleOf(team, actor);
		return role === null ? undefined : { team, role };
	};
}

/** Compose identity + membership into ONE core ContextResolver — identity first (membership needs the actor). */
export function composeContext(parts: {
	identity?: IdentityResolver;
	membership?: MembershipResolver;
	organization?: OrganizationResolver;
}): ContextResolver | undefined {
	const { identity, membership, organization } = parts;
	if (!identity && !membership && !organization) return undefined;
	return async (ctx) => {
		if (organization) {
			const organizationId = await organization(ctx);
			if (typeof organizationId === "string")
				ctx[ORGANIZATION_CONTEXT_KEY] = organizationId;
		}
		if (identity) {
			const principal = await identity(ctx);
			if (typeof principal === "string") ctx[PRINCIPAL_CONTEXT_KEY] = principal;
		}
		if (membership) {
			const m = await membership(ctx);
			if (m) {
				ctx[TEAM_CONTEXT_KEY] = m.team;
				ctx[ROLE_CONTEXT_KEY] = m.role;
			}
		}
		return ctx;
	};
}
