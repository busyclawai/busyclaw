// Identity & membership resolution — runtime-level wiring, composed into core's neutral
// `resolveContext` hook. Each is a FUNCTION (not a vendor object): a session-getter,
// a JWT decoder, a role lookup — vendor-neutral and testable with a fake.

import {
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	type ContextResolver,
	MEMBERSHIPS_CONTEXT_KEY,
	type Membership,
	PRINCIPAL_CONTEXT_KEY,
	type Principal,
	type ScopeRef,
	SUBJECT_CONTEXT_KEY,
	type TurnContext,
	userPrincipal,
} from "@busyclaw/contracts";

/** Resolves the accountable operator → the `principal` (or undefined). A background run resolves the
 *  principal of whoever DELEGATED the work, never an anonymous scheduler identity: a scheduled run is a
 *  claw's run, and its approvals and audit both need a person behind them. */
export type IdentityResolver = (
	ctx: TurnContext,
) => Principal | undefined | Promise<Principal | undefined>;

/**
 * Resolves EVERY boundary the principal belongs to, and their role in each. Runs after identity (it
 * needs the principal).
 *
 * Plural and opaque, where this used to be a single `{ team, role }`. A person sits in several teams,
 * and a role is held IN a boundary — the singular pair could express neither, so a role held in one
 * place silently answered for every other. Returning `[]` (or nothing) is a real answer: the run belongs
 * to no boundary and every `scopes.contains(…)` policy is false, rather than erroring.
 */
export type MembershipResolver = (
	ctx: TurnContext,
) =>
	| readonly Membership[]
	| undefined
	| Promise<readonly Membership[] | undefined>;

/** Resolves the run's CONFIG SCOPE — the opaque `(scope, scopeId)` boundary whose durable configuration
 *  governs it (registered tools, policy slices, the facts overlay). Both halves are opaque to core: an
 *  organization is a plugin, so the label is whatever the host's boundary is called. */
export type ConfigScopeResolver = (
	ctx: TurnContext,
) => ScopeRef | undefined | Promise<ScopeRef | undefined>;

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

/**
 * Build a MembershipResolver from any "which boundaries is this principal in" lookup — better-auth's
 * org memberships, an LDAP group query, your own.
 *
 * Core implements NONE of them. Tenancy here is `(scope, scopeId)` and core has no opinion about what
 * a boundary is, so it ships no membership store to back this: a claw with no plugin supplying
 * `membershipsOf` resolves no memberships at all, and every `scopes.contains(…)`/`roles.contains(…)`
 * policy is false. That is the intended shape — a boundary is a plugin's concept — but it means
 * membership-gated policy does nothing until a host wires this seam to a real lookup.
 *
 * This is the whole adapter. The predecessor (`roleMembership({ roleOf })`) additionally had to be told
 * where to find the ONE active team on the context, because the model allowed only one; with the lookup
 * returning every membership there is nothing left to configure.
 *
 * ONE HAZARD MOVES ACROSS THIS SEAM WITH THE STORAGE. Core used to own the membership table and
 * declared a composite unique on it, because a duplicate membership row is a REVOCATION BYPASS:
 * removing the row an admin can see leaves the other one still granting. Whoever owns membership
 * storage now inherits that, and nothing here can check it — `assertUniquesRepresentable` validates
 * only the keys a table actually declares, so a plugin that declares none passes silently. A
 * membership table needs a unique on its own (boundary, principal) pair or the bug reappears
 * somewhere core cannot see it.
 */
export function principalMemberships(deps: {
	membershipsOf: (
		principal: string,
		ctx: TurnContext,
	) => readonly Membership[] | Promise<readonly Membership[]>;
}): MembershipResolver {
	return async (ctx) => {
		const principal = ctx[PRINCIPAL_CONTEXT_KEY];
		if (typeof principal !== "string") return undefined;
		return await deps.membershipsOf(principal, ctx);
	};
}

/**
 * Resolves WHOSE PERSONAL DATA this turn is about — the erasure key every PII mapping minted during it
 * is linked to, so a later `forgetSubject` can find them.
 *
 * Trusted-code only, by construction: the key it writes carries the reserved prefix, so a caller
 * cannot supply it and `stripReserved` drops any attempt. That is the point — a subject the caller
 * names is a subject the caller can misname, and the mapping it links would be erased by the wrong
 * person's request or by nobody's.
 *
 * Without one, ordinary message and tool redaction mints mappings linked to NO subject, and erasure
 * cannot discover them: `forgetSubject` answers successfully having found nothing. busyclaw cannot
 * derive this itself — who a value is ABOUT is domain knowledge, not something a tokenizer can infer
 * from the value — so a deployment that owes anyone erasure has to say.
 */
export type SubjectResolver = (
	ctx: TurnContext,
) => string | undefined | Promise<string | undefined>;

/** Compose identity + membership into ONE core ContextResolver — identity first (membership needs the principal). */
export function composeContext(parts: {
	identity?: IdentityResolver;
	membership?: MembershipResolver;
	configScope?: ConfigScopeResolver;
	subject?: SubjectResolver;
}): ContextResolver | undefined {
	const { identity, membership, configScope, subject } = parts;
	if (!identity && !membership && !configScope && !subject) return undefined;
	return async (ctx) => {
		if (configScope) {
			const ref = await configScope(ctx);
			if (ref !== undefined) {
				ctx[CONFIG_SCOPE_CONTEXT_KEY] = ref.scope;
				ctx[CONFIG_SCOPE_ID_CONTEXT_KEY] = ref.scopeId;
			}
		}
		// The caller-LESS fallback, structurally. The authenticated caller is SEEDED before this runs
		// (`resolveRunAuthority`), so an authenticated run keeps its caller and a cron/engine resume —
		// which has none — gets the resolver's answer. It used to run unconditionally and be overwritten
		// afterwards, which meant the resolvers BELOW it (membership, subject) and the tool resolver all
		// saw the wrong principal: the role was fetched for whoever `identity` named, not for the caller.
		if (identity && ctx[PRINCIPAL_CONTEXT_KEY] === undefined) {
			const principal = await identity(ctx);
			if (typeof principal === "string") ctx[PRINCIPAL_CONTEXT_KEY] = principal;
		}
		if (membership) {
			const m = await membership(ctx);
			// An EMPTY list is stamped, not skipped: "resolved, belongs to nothing" and "never asked"
			// must not read the same downstream. The engine's projections are always present either way.
			if (m !== undefined) ctx[MEMBERSHIPS_CONTEXT_KEY] = [...m];
		}
		// LAST: a deployment usually derives the subject from the principal identity resolved above, so it
		// runs where that is already on the context.
		if (subject) {
			const subjectId = await subject(ctx);
			if (typeof subjectId === "string" && subjectId !== "") {
				ctx[SUBJECT_CONTEXT_KEY] = subjectId;
			}
		}
		return ctx;
	};
}
