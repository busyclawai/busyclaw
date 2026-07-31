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
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	type ContextResolver,
	PRINCIPAL_CONTEXT_KEY,
	ROLE_CONTEXT_KEY,
	type ScopeRef,
	SUBJECT_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
} from "@busyclaw/contracts";

/**
 * The facts a run's authority consists of — the answer the host's resolvers gave, ONCE, before
 * anything read it.
 *
 * Frozen, and every field optional, because each is genuinely absent in some real deployment: a cron
 * run has no caller, a single-tenant one has no config scope, a deployment that owes nobody erasure
 * has no subject. Absent means absent — the tool floor fails closed on a modeled action with no
 * principal, which is the correct reading of "we could not establish who this is".
 */
export type RunAuthority = Readonly<{
	/** The canonical principal. The authenticated caller when there is one; otherwise the `identity`
	 *  resolver's answer, which is the caller-LESS fallback (cron, engine resume). */
	principal?: string;
	/** The `(scope, scopeId)` boundary whose durable configuration governs this run — its registered
	 *  tools, policy slices and secrets. Both halves or neither; half a key names no boundary. */
	configScope?: ScopeRef;
	team?: string;
	role?: string;
	/** Whose personal data this run is about — the erasure key its PII mappings link to. */
	subject?: string;
}>;

/** Read the authority back off a context the resolvers have populated. */
function captureAuthority(ctx: Record<string, unknown>): RunAuthority {
	const str = (key: string): string | undefined =>
		typeof ctx[key] === "string" ? ctx[key] : undefined;
	const scope = str(CONFIG_SCOPE_CONTEXT_KEY);
	const scopeId = str(CONFIG_SCOPE_ID_CONTEXT_KEY);
	return Object.freeze({
		principal: str(PRINCIPAL_CONTEXT_KEY),
		// Both halves or neither — the same rule `registeredToolResolver` applies when it reads them.
		configScope:
			scope !== undefined && scopeId !== undefined
				? Object.freeze({ scope, scopeId })
				: undefined,
		team: str(TEAM_CONTEXT_KEY),
		role: str(ROLE_CONTEXT_KEY),
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
	if (authority.configScope !== undefined) {
		ctx[CONFIG_SCOPE_CONTEXT_KEY] = authority.configScope.scope;
		ctx[CONFIG_SCOPE_ID_CONTEXT_KEY] = authority.configScope.scopeId;
	}
	if (authority.team !== undefined) ctx[TEAM_CONTEXT_KEY] = authority.team;
	if (authority.role !== undefined) ctx[ROLE_CONTEXT_KEY] = authority.role;
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
	callerPrincipal: string | undefined;
	resolveContext: ContextResolver | undefined;
}): Promise<{ authority: RunAuthority; ctx: Record<string, unknown> }> {
	const { ctx, callerPrincipal, resolveContext } = input;
	if (callerPrincipal !== undefined) {
		ctx[PRINCIPAL_CONTEXT_KEY] = callerPrincipal;
	}
	const resolved = resolveContext ? await resolveContext(ctx) : ctx;
	return { authority: captureAuthority(resolved), ctx: resolved };
}

/** Two authorities name the same tenant. Absent on both sides counts as agreement — a deployment that
 *  resolves no scope at all is single-tenant, and there is nothing to disagree about. */
export function sameConfigScope(
	a: RunAuthority,
	b: { scope?: string; scopeId?: string },
): boolean {
	return (
		a.configScope?.scope === (b.scope ?? undefined) &&
		a.configScope?.scopeId === (b.scopeId ?? undefined)
	);
}
