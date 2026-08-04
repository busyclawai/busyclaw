// The PII CONTAINER — `(containerKind, containerId)` — and why it is not a scope.
//
// Two dimensions in this codebase used to share the `(scope, scopeId)` shape AND the `ScopeRef` type,
// and they are unrelated:
//
//   TENANCY SCOPE   which BOUNDARY owns a row.        `organization`, `team`, `personal`.
//                   Someone can be a MEMBER of it. Membership decides authorization.
//                   See scope.ts — that file's whole argument is about boundaries.
//
//   PII CONTAINER   which NAMESPACE holds a placeholder's mapping.  `claw`, `run`, a plugin id.
//                   Nobody is a member of a claw-the-container; it is an ENTITY REFERENCE, and
//                   `forgetSubject` proves it by resolving the pair as `{ kind, id }` against the
//                   authz resource registry (api.ts) rather than against any membership resolver.
//
// The confusion was not academic. A run row carries BOTH — `scope`/`scopeId` is the tenancy anchor the
// worker writes from resolved authority, `clawId` is what its container derives from — and with one
// type they were assignable to each other in either direction, silently. A container mismatch throws
// nothing: the lookup misses and the caller receives the literal `{{pii:…}}` string.
//
// Containment follows the entity that owns the DATA'S LIFETIME, never the boundary that owns access:
//   - the claw, because message 3's placeholder must rehydrate in message 40, and the transcript is
//     the thing that outlives the run;
//   - not the org, which would make one namespace per tenant so a placeholder minted in one claw
//     resolves in another — and would silently lose posture, since a claw's birth posture is read only
//     when the container kind is `claw`;
//   - not the person, because a shared claw could not then rehydrate its own transcript.

import { RESERVED_SCOPE_PREFIX } from "./scope";

/**
 * A reference to one PII container — the namespace a placeholder's mapping lives in.
 *
 * Deliberately NOT `ScopeRef`, and deliberately different field names, so the compiler refuses a
 * tenancy pair where a container belongs. An object rather than two positional strings for the same
 * reason it is elsewhere: a transposed call should not compile.
 */
export type PiiContainerRef = {
	containerKind: string;
	containerId: string;
};

/**
 * The container for a row that genuinely belongs to no container — a redaction performed with no turn
 * context, which has no claw, no run, and no subject to inherit one from.
 *
 * It exists because "no container" and "some container" cannot both be representable in a column that
 * is part of a PRIMARY KEY: a key column cannot be NULL. Rather than leave the key undeclared, the
 * absent case gets a value. The value borrows the `busyclaw:` prefix the scope module reserves, which
 * is what keeps it unreachable: nothing registers a resource of that kind, so `forgetSubject` denies
 * it rather than falling through. A sentinel container can only ever narrow.
 */
export const UNCONTAINED = Object.freeze({
	containerKind: `${RESERVED_SCOPE_PREFIX}uncontained`,
	containerId: "-",
}) satisfies PiiContainerRef;
