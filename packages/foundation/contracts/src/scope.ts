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

import { field } from "./entity";

/** A reference to one opaque access boundary — the parameter shape every scope-keyed store verb takes.
 *  An object rather than two positional strings so a transposed call is a compile error rather than a
 *  silent read of the wrong boundary. */
export type ScopeRef = {
	scope: string;
	scopeId: string;
};

/** Core reserves the `euroclaw:` prefix on the `scope` LABEL, and nothing else about the pair. A
 *  plugin's boundary kind ("organization", "team", "personal") never starts with it, so a container
 *  core mints for itself cannot collide with one a plugin means. */
export const RESERVED_SCOPE_PREFIX = "euroclaw:";

/**
 * The container for a row that genuinely belongs to no boundary — a redaction performed with no turn
 * context, which has no claw, no run, and no subject to inherit one from.
 *
 * It exists because "no container" and "some container" cannot both be representable in a column that
 * is part of a PRIMARY KEY: a key column cannot be NULL. Rather than leave the key undeclared, the
 * absent case gets a value. The value is deliberately one NOBODY CAN BE A MEMBER OF — a membership
 * resolver returning a `euroclaw:`-prefixed scope is refused by {@link isReservedScope}, so a sentinel
 * container can never widen access. It narrows: rows here are reachable only by an equally
 * context-less read.
 */
export const UNCONTAINED = Object.freeze({
	scope: `${RESERVED_SCOPE_PREFIX}uncontained`,
	scopeId: "-",
}) satisfies ScopeRef;

/** Whether a scope label is core's rather than a plugin's. Membership is never resolvable into one:
 *  a host resolver that returns a reserved scope is claiming a boundary core minted for the absence
 *  of a boundary, which would turn "belongs to nothing" into "shared with everyone". */
export function isReservedScope(scope: string): boolean {
	return scope.startsWith(RESERVED_SCOPE_PREFIX);
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
