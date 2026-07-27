// The generic shareable-resource ACL — the `access_grant` entity + the `AccessGrantStore` port
// (docs/plans/app-authz.md §6, build-slice 5). ONE table for EVERY shareable resource (claw, thread,
// skill, …): `resourceKind` is an OPAQUE label the core never interprets (exactly like `scope`), so a
// new shareable kind needs ZERO new authz code — just a loader (assembly) that presents its base row.
// SUPERSEDES the skills plugin's bespoke `skill_acl` (its split `principalType`+`principalId` collapses
// into the unified `principalRef`; its `share` permission folds into `manage`).
//
// The PEP feeds `listForResource` grants straight into the generic decision — the {@link AccessGrant}
// projection IS what `decideApiCall` renders (no translation seam). Rows are IMMUTABLE: a share is an
// INSERT, an unshare a DELETE (grants are DATA, never compiled policy — the authz bundle never moves).
//
// Impl lives in @busyclaw/storage-durable (createAccessGrantStore); this module holds only the entity
// declaration, the arktype record/create schemas, the derived types, and the behavioural store port.

import { type } from "arktype";
import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";
import type { RouteLevel } from "../governance/route";

/** A grant's permission LEVEL — the SAME ordered vocabulary the api decision compares against
 *  (`read < use < manage`). `read` sees, `use` runs/invokes, `manage` mutates/administers/RE-SHARES
 *  (the old `skill_acl` `share` folds in here — you can only share what you manage). This is the ONE
 *  home of the level type; @busyclaw/authz's `ApiPermissionLevel` aliases it, so the store and the PEP
 *  speak one vocabulary with no conversion. */
export const accessGrantPermissionValues = ["read", "use", "manage"] as const;
export type AccessGrantPermission =
	(typeof accessGrantPermissionValues)[number];
/** The permission-level arktype — the boundary validator the share api parses caller input through. */
export const accessGrantPermission = type("'read' | 'use' | 'manage'");

// The route builder's `RouteLevel` spells this union out rather than importing it — it has to stay a
// leaf for the client's wire allowlist (importing this module would pull `entity.ts` into the closure).
// One vocabulary is load-bearing: a grant row's `permission` is compared against the level an action
// requires, so a third value on either side would compare against nothing. Assert mutual assignability
// here, where the wire allowlist does not reach, so drift is a compile error rather than a silent hole.
type _LevelVocabularyIsOne = [AccessGrantPermission] extends [RouteLevel]
	? [RouteLevel] extends [AccessGrantPermission]
		? true
		: never
	: never;
const _levelsAgree: _LevelVocabularyIsOne = true;
void _levelsAgree;

/**
 * The BOUNDARY validator for a grantee ref — `public`, or a tagged `<authority>:<id>`.
 *
 * The tag is the AUTHORITY that issued the id (`user:` for a principal busyclaw itself names;
 * `betterauth:` / `workday:` / … for a scope some source defines) — never a taxonomy, see the
 * AMENDMENT in docs/plans/org-tenancy-refactor.md. The authority stays OPAQUE: this checks the SHAPE
 * only, so a new source needs no change here and `grantReaches` keeps comparing plain strings.
 *
 * Why validate, when an unmatched ref already fails closed? Because it fails closed SILENTLY: an
 * untagged `engineering` — exactly the mistake an authority-tagged model invites — is accepted today,
 * stored, and then reaches nobody. A grant row that looks right and grants nothing, with no error at
 * the boundary it entered. This makes it a rejected call instead. It deliberately does NOT catch a
 * well-formed ref to a group that does not exist (`workday:typo`): that needs the source itself, and
 * is the org plugin's `exists`.
 */
export const accessGrantPrincipalRef = type("string").narrow((value, ctx) => {
	if (value === "public") return true;
	const colon = value.indexOf(":");
	if (colon === -1) {
		return ctx.reject(
			"`public`, or a tagged `<authority>:<id>` grantee (e.g. `user:alice`) — no colon found",
		);
	}
	if (colon === 0) {
		return ctx.reject("a grantee with a non-empty authority before the colon");
	}
	if (colon === value.length - 1) {
		return ctx.reject("a grantee with a non-empty id after the colon");
	}
	return true;
});

// ── access_grant — one immutable row per (resourceKind, resourceId, principalRef, permission) ────────

export const accessGrantFields = {
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	// The OPAQUE resource-kind label (`"claw"`/`"thread"`/`"skill"`/…) — never interpreted by core,
	// exactly like `scope`. With resourceId it is the hot-path lookup the PEP reads per governed call.
	resourceKind: field.string({ required: true, index: true, immutable: true }),
	resourceId: field.string({ required: true, index: true, immutable: true }),
	// The UNIFIED polymorphic grantee ref — `user:<id>` | `team:<id>` | `organization:<id>` | `public`.
	// OPAQUE: `grantReaches` matches it (public / direct principal / labelled scope), never parses a
	// kind. Supersedes skill_acl's split principalType+principalId. Not a `field.principal` — a team /
	// organization / public ref is not a single accountable principal.
	principalRef: field.string({ required: true, index: true, immutable: true }),
	// The level this grant confers (read|use|manage) — compared against the action's required level by
	// Cedar `in`, not a TS >=. `share` folded into `manage`.
	permission: field.enum(accessGrantPermissionValues, {
		required: true,
		index: true,
		immutable: true,
	}),
	// Who wrote the grant — a real accountable principal (audit / provenance), distinct from the
	// polymorphic grantee. Immutable: a share is a fact of the moment it was granted.
	grantedBy: field.principal({ required: true, index: true, immutable: true }),
	createdAt: field.string({ required: true, immutable: true }),
} as const;

export const accessGrantEntity = entity("access_grant", accessGrantFields);
export const accessGrantRecord = accessGrantEntity.record;
export type AccessGrantRecord = EntityRecord<typeof accessGrantFields>;

/** Create input — the store owns id + createdAt; every other column is caller-supplied. Rows are
 *  immutable, so there is no update input. */
export const accessGrantCreateInput = accessGrantEntity.schema({
	omit: ["id", "createdAt"],
});
export type NewAccessGrant = EntityInput<
	typeof accessGrantFields,
	"id" | "createdAt"
>;

/** The storage schema backing the AccessGrantStore (migrations + the entity-validating adapter). */
export const accessGrantSchema = accessGrantEntity.storage;

/**
 * One grant as the PEP consumes it — the projection `decideApiCall` renders into the Cedar entity graph.
 * `principalRef` is the opaque polymorphic ref; `level` is what the action's required level is compared
 * against. This is the SAME shape @busyclaw/authz's `AccessGrant` names (it imports THIS type), so the
 * store returns it and the PEP feeds it through with no translation. A host-assembled VIEW (plain TS,
 * not arktype): the untrusted boundary is the ROW (validated by `accessGrantRecord`); this is a trusted
 * projection of validated rows.
 */
export type AccessGrant = {
	principalRef: string;
	level: AccessGrantPermission;
};

/** A scope the caller BELONGS TO — an opaque (scope, scopeId) — the only input {@link grantReaches} needs to
 *  decide whether a labelled `<scope>:<scopeId>` grant reaches the caller. A structural subset of
 *  @busyclaw/authz's `PrincipalScope` (which additionally carries a level), so the PEP passes its richer
 *  scopes straight through. */
export type GrantScope = {
	scope: string;
	scopeId: string;
};

/**
 * Does a grant's opaque `principalRef` REACH the caller? `public` reaches everyone; a direct match
 * reaches the principal; a `team:`/`organization:` (any labelled) ref reaches a caller who holds a
 * held scope whose `<scope>:<scopeId>` equals it — so grants to groups work the moment scopes do,
 * with no per-ref-kind code. This is the ONE matcher both the product-api PEP (@busyclaw/authz renders
 * it into the Cedar `in` graph) and the skills runtime gate share — DEFINED here beside {@link AccessGrant}
 * so neither reimplements it. It only decides REACH (does this grant apply to the caller); whether the
 * reached grant's LEVEL satisfies the requirement is a separate compare ({@link grantLevelSatisfies} in a
 * TS gate, or Cedar `in` in the PEP).
 */
export function grantReaches(
	grant: AccessGrant,
	principal: string,
	scopes: readonly GrantScope[],
): boolean {
	if (grant.principalRef === "public") return true;
	if (grant.principalRef === principal) return true;
	return scopes.some((m) => `${m.scope}:${m.scopeId}` === grant.principalRef);
}

/** Does a HELD level satisfy a REQUIRED one under the `read < use < manage` order (the SAME order the
 *  PEP walks as the Cedar access-node hierarchy)? `manage` satisfies `use` and `read`; `use` satisfies
 *  `read`; `read` satisfies only `read`. The TS-gate counterpart of the PEP's transitive `in` — a plain
 *  `>=` over {@link accessGrantPermissionValues}, so a leveled gate (e.g. skills' runtime activate/read
 *  check) decides "holds ≥ the required level" without reimplementing the ordering. */
export function grantLevelSatisfies(
	held: AccessGrantPermission,
	required: AccessGrantPermission,
): boolean {
	return (
		accessGrantPermissionValues.indexOf(held) >=
		accessGrantPermissionValues.indexOf(required)
	);
}

/**
 * The generic ACL store — org-blind (every id/ref is opaque). `listForResource` is the hot path the PEP
 * calls per governed call; `create`/`delete` back the share/unshare api. Rows are immutable, so there is
 * no update. `delete` removes by the (resourceKind, resourceId, principalRef) natural key (an unshare
 * revokes every level a grantee held on the resource) and returns how many rows went.
 */
export type AccessGrantStore = {
	/** Every grant on (resourceKind, resourceId), projected to the PEP shape — the hot path. */
	listForResource: (
		resourceKind: string,
		resourceId: string,
	) => Promise<AccessGrant[]>;
	create: (input: NewAccessGrant) => Promise<AccessGrantRecord>;
	delete: (input: {
		resourceKind: string;
		resourceId: string;
		principalRef: string;
	}) => Promise<number>;
};
