// The run's authority — WHO it runs as and WHERE — resolved once, frozen, then stamped.
//
// R-H03. It used to be derived in three places, and nothing compared the answers:
//
//   1. `resolveRunContext` ran the host's resolvers to pick TOOLS — without the authenticated caller,
//      which the entry point had already established;
//   2. `resolveGovernanceContext` ran them AGAIN to decide policy, stamping the caller over the top of
//      that second answer only;
//   3. core re-ran them at each of its six boundary doors.
//
// Three consequences, all silent. A registered tool's closure captured the principal from (1) and sent
// its request under that identity, while the decision permitting it named the one from (2).
// `roleMembership` looks a role up FOR `ctx[principal]`, so at (1) it fetched the role of whoever the
// `identity` resolver named — a run could be authorized as one person carrying another person's role.
// And because (3) re-derived per door, a resolver reading a mutable store answered differently at
// each one: a run could be an admin at one tool call and a member at the next, with nothing recording
// that it changed.
//
// So: resolve once, freeze, stamp. Every door gets the same answer by construction rather than by
// each caller remembering to ask the same question in the same way.

import {
	asPrincipal,
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	type ContextResolver,
	MEMBERSHIPS_CONTEXT_KEY,
	type Membership,
	PRINCIPAL_CONTEXT_KEY,
	type Principal,
	type ScopeRef,
	SUBJECT_CONTEXT_KEY,
	UNSCOPED,
} from "@busyclaw/contracts";

/**
 * The facts a run's authority consists of — the answer the host's resolvers gave, ONCE, before
 * anything read it.
 *
 * Frozen. Most fields are optional because each is genuinely absent in some real deployment: a cron
 * run has no caller, a deployment that owes nobody erasure has no subject. Absent means absent — the
 * tool floor fails closed on a modeled action with no principal, which is the correct reading of "we
 * could not establish who this is".
 *
 * `configScope` is the exception and is always a value. See the field.
 */
export type RunAuthority = Readonly<{
	/** The canonical principal. The authenticated caller when there is one; otherwise the `identity`
	 *  resolver's answer, which is the caller-LESS fallback (cron, engine resume). */
	principal?: Principal;
	/**
	 * The `(scope, scopeId)` boundary whose durable configuration governs this run — its registered
	 * tools, policy slices and secrets.
	 *
	 * ALWAYS a value. A run that resolves no tenant carries {@link UNSCOPED} rather than `undefined`,
	 * so no consumer downstream has to decide for itself what an absent boundary means — six of them
	 * used to, and they did not agree on the direction. Half a resolved key still names no boundary and
	 * collapses here, at the one place that answers the question.
	 */
	configScope: ScopeRef;
	/** Every boundary the principal belongs to, and their role in each — frozen with the rest of the
	 *  authority, so a resolver reading a mutable store cannot answer differently at two doors of the
	 *  same run. Absent means the deployment resolves no membership at all; `[]` means it resolved and
	 *  the principal belongs to nothing. */
	memberships?: readonly Membership[];
	/** Whose personal data this run is about — the erasure key its PII mappings link to. */
	subject?: string;
}>;

/** Read the authority back off a context the resolvers have populated. */
function captureAuthority(ctx: Record<string, unknown>): RunAuthority {
	const str = (key: string): string | undefined =>
		typeof ctx[key] === "string" ? ctx[key] : undefined;
	const scope = str(CONFIG_SCOPE_CONTEXT_KEY);
	const scopeId = str(CONFIG_SCOPE_ID_CONTEXT_KEY);
	// Re-establish the BRAND on the way out. The value went into the context as a `Principal` and comes
	// back as `unknown` — the only place in the run where the type is lost — so this is a parse
	// boundary, not a cast: a resolver that answered a bare host id (`alice` rather than `user:alice`)
	// throws HERE, once, instead of stamping a malformed principal that every door downstream then
	// compares, logs and authorizes against.
	const rawPrincipal = str(PRINCIPAL_CONTEXT_KEY);
	// Frozen deeply enough to matter: the array is what a later door re-stamps, so a consumer that
	// mutated it would change what the NEXT door authorizes against.
	const rawMemberships = ctx[MEMBERSHIPS_CONTEXT_KEY];
	const memberships = Array.isArray(rawMemberships)
		? Object.freeze([...(rawMemberships as readonly Membership[])])
		: undefined;
	return Object.freeze({
		principal:
			rawPrincipal === undefined ? undefined : asPrincipal(rawPrincipal),
		// The ONE place the absent (or half-named) boundary becomes a value — the same move
		// `piiContainer` makes for the other pair, and for the same reason: an open family of
		// near-misses collapses to exactly one bucket that everything downstream can look up.
		configScope:
			scope !== undefined && scopeId !== undefined
				? Object.freeze({ scope, scopeId })
				: UNSCOPED,
		...(memberships !== undefined ? { memberships } : {}),
		subject: str(SUBJECT_CONTEXT_KEY),
	});
}

/**
 * Write an authority onto a context. Called at every door; never re-derives anything.
 *
 * Mutates and returns the same object, matching `ContextResolver`'s shape — core hands over a freshly
 * stripped context each time and expects the trusted facts written back onto it.
 */
export function stampAuthority(
	ctx: Record<string, unknown>,
	authority: RunAuthority,
): Record<string, unknown> {
	if (authority.principal !== undefined) {
		ctx[PRINCIPAL_CONTEXT_KEY] = authority.principal;
	}
	ctx[CONFIG_SCOPE_CONTEXT_KEY] = authority.configScope.scope;
	ctx[CONFIG_SCOPE_ID_CONTEXT_KEY] = authority.configScope.scopeId;
	if (authority.memberships !== undefined) {
		ctx[MEMBERSHIPS_CONTEXT_KEY] = [...authority.memberships];
	}
	if (authority.subject !== undefined) {
		ctx[SUBJECT_CONTEXT_KEY] = authority.subject;
	}
	return ctx;
}

/**
 * Resolve the run's authority — the single derivation.
 *
 * The caller principal is SEEDED BEFORE the resolvers run, not stamped after. That ordering is the
 * whole fix for two of the three splits: `membership`, `subject` and `configScope` all read
 * `ctx[principal]`, so seeding first is what makes them resolve for the person the run is actually
 * authorized as. `composeContext` treats `identity` as the caller-less fallback (it skips when a
 * principal is already present), so the seed survives the resolvers rather than being overwritten and
 * re-stamped.
 *
 * `ctx` arrives already stripped of reserved keys — the caller cannot forge any of this.
 */
export async function resolveRunAuthority(input: {
	ctx: Record<string, unknown>;
	callerPrincipal: Principal | undefined;
	resolveContext: ContextResolver | undefined;
}): Promise<{ authority: RunAuthority; ctx: Record<string, unknown> }> {
	const { ctx, callerPrincipal, resolveContext } = input;
	if (callerPrincipal !== undefined) {
		ctx[PRINCIPAL_CONTEXT_KEY] = callerPrincipal;
	}
	const resolved = resolveContext ? await resolveContext(ctx) : ctx;
	return { authority: captureAuthority(resolved), ctx: resolved };
}

/**
 * Two boundaries are the same one.
 *
 * Plain equality, because both sides are always values now: the resumed run carries its resolved
 * boundary and the parked record carries the one it was created in. It used to have to treat "absent
 * on both sides" as agreement, which is the shape that hides a real disagreement whenever exactly one
 * side fails to resolve.
 */
export function sameConfigScope(a: ScopeRef, b: ScopeRef): boolean {
	return a.scope === b.scope && a.scopeId === b.scopeId;
}
