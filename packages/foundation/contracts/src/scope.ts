// The opaque access boundary a scope-keyed row belongs to — `(scope, scopeId)`.
//
// Core never interprets either half. `scope` is a LABEL ("organization", "team") that some plugin gives
// meaning to; `scopeId` is that boundary's id. This is why the pair exists instead of an
// `organizationId` column: an organization is a PLUGIN, and core's config tables — policy slices, the
// facts overlay, spec registrations, registered tools, the authz change log — have to say "this row
// belongs to a boundary" without core learning what a boundary is. A column literally named for one kind of
// boundary made every one of those tables assert an answer core is not entitled to have.
//
// The pair is a LOOKUP KEY, never authority. A request naming `(organization, acme)` is only choosing
// which boundary it wants to act in; whether the caller BELONGS to that boundary is decided by the
// app-authz PEP against `resolvePrincipalScopes`, a resolver the host supplies. Naming a boundary you
// are not in resolves no membership and denies — which is exactly why it is safe for the request to
// name it.

import { configurationError } from "@busyclaw/errors";
import { field } from "./entity";

/** A reference to one opaque access boundary — the parameter shape every scope-keyed store verb takes.
 *  An object rather than two positional strings so a transposed call is a compile error rather than a
 *  silent read of the wrong boundary. */
export type ScopeRef = {
	scope: string;
	scopeId: string;
};

/** Core reserves the `busyclaw:` prefix on the `scope` LABEL, and nothing else about the pair. A
 *  plugin's boundary kind ("organization", "team", "personal") never starts with it, so a container
 *  core mints for itself cannot collide with one a plugin means. */
export const RESERVED_SCOPE_PREFIX = "busyclaw:";

/**
 * The container for a row that genuinely belongs to no boundary — a redaction performed with no turn
 * context, which has no claw, no run, and no subject to inherit one from.
 *
 * It exists because "no container" and "some container" cannot both be representable in a column that
 * is part of a PRIMARY KEY: a key column cannot be NULL. Rather than leave the key undeclared, the
 * absent case gets a value. The value is deliberately one NOBODY CAN BE A MEMBER OF — a membership
 * resolver returning a `busyclaw:`-prefixed scope is refused by {@link isReservedScope}, so a sentinel
 * container can never widen access. It narrows: rows here are reachable only by an equally
 * context-less read.
 */
export const UNCONTAINED = Object.freeze({
	scope: `${RESERVED_SCOPE_PREFIX}uncontained`,
	scopeId: "-",
}) satisfies ScopeRef;

/**
 * The config-scope boundary of a run that resolves no tenant — a single-tenant deployment, a cron
 * one-off, a host that configures no `configScope` resolver at all.
 *
 * Same move as {@link UNCONTAINED}, for the other pair: the absent case gets a VALUE so that
 * everything downstream asks one question instead of inventing its own answer. Six consumers used to
 * each decide what an undefined config scope meant — five narrowed, one widened — and no signature
 * carrying `ScopeRef | undefined` could say which was intended.
 *
 * NOTHING LIVES HERE. Config writes refuse a reserved scope ({@link assertUnreservedScope}), so a
 * lookup in this boundary finds nothing by construction. That is deliberate and load-bearing: if rows
 * could live here, a multi-tenant deployment whose resolver silently returned undefined would stop
 * getting nothing and start getting the shared bucket's tools and policies. A single-tenant deployment
 * that wants registered tools names a REAL boundary — `{ scope: "deployment", scopeId: "default" }`
 * is a fine one — and the assembly warns when a registry is configured with no resolver to reach it.
 */
export const UNSCOPED = Object.freeze({
	scope: `${RESERVED_SCOPE_PREFIX}unscoped`,
	scopeId: "-",
}) satisfies ScopeRef;

/** Whether a scope label is core's rather than a plugin's. Membership is never resolvable into one:
 *  a host resolver that returns a reserved scope is claiming a boundary core minted for the absence
 *  of a boundary, which would turn "belongs to nothing" into "shared with everyone". */
export function isReservedScope(scope: string): boolean {
	return scope.startsWith(RESERVED_SCOPE_PREFIX);
}

/**
 * Whether a pair names a real TENANT — a boundary someone can be a member of.
 *
 * One negation, and worth a name anyway: two call sites were asking exactly this while spelling it
 * `scope === undefined`, and both broke the moment the absent case became a value. The secrets chain
 * would have fenced the deployment's own credentials off from the runs they exist for; the approval
 * loader would have routed an ad-hoc run's own approval through a boundary nobody can be a member of
 * and denied the person their own decision. The question is "is this somebody's boundary", not "is
 * this field populated", and it reads wrong inline in a way it does not read wrong here.
 *
 * Takes a WHOLE {@link ScopeRef}: a half-named boundary is collapsed upstream, at the one place that
 * answers it, so there is no partial pair left for this to re-check.
 */
export function namesTenant(ref: ScopeRef): boolean {
	return !isReservedScope(ref.scope);
}

/** Refuse a reserved scope where a caller (or a host) is naming the boundary a row will LIVE in.
 *  Core mints those labels for the absence of a boundary; a row stored under one would be reachable
 *  by every context that failed to resolve a real boundary. */
export function assertUnreservedScope(ref: ScopeRef): void {
	if (isReservedScope(ref.scope)) {
		throw configurationError(
			`"${ref.scope}" is reserved — core mints the "${RESERVED_SCOPE_PREFIX}" prefix to stand for the ABSENCE of a boundary, so nothing may be stored in one`,
			{ scope: ref.scope, scopeId: ref.scopeId },
		);
	}
}

/** The `(scope, scopeId)` column pair for a scope-keyed CORE CONFIG row. Immutable: unlike a claw —
 *  which is re-shareable over its life — a policy slice or a spec registration is created inside one
 *  boundary and does not migrate between them. Spread into an entity (`...scopeFields`) so all five
 *  config tables declare the boundary identically and an index cannot be forgotten on one of them. */
export const scopeFields = {
	scope: field.string({
		required: true,
		index: true,
		immutable: true,
		doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this row belongs to.",
	}),
	scopeId: field.string({
		required: true,
		index: true,
		immutable: true,
		doc: "The access boundary's id — with scope it names the boundary this row belongs to. Authorized by verified membership, never by the request asserting it.",
	}),
} as const;
