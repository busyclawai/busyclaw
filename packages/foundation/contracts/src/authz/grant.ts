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
// Impl lives in @euroclaw/storage-durable (createAccessGrantStore); this module holds only the entity
// declaration, the arktype record/create schemas, the derived types, and the behavioural store port.

import { type } from "arktype";
import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";

/** A grant's permission LEVEL — the SAME ordered vocabulary the api decision compares against
 *  (`read < use < manage`). `read` sees, `use` runs/invokes, `manage` mutates/administers/RE-SHARES
 *  (the old `skill_acl` `share` folds in here — you can only share what you manage). This is the ONE
 *  home of the level type; @euroclaw/authz's `ApiPermissionLevel` aliases it, so the store and the PEP
 *  speak one vocabulary with no conversion. */
export const accessGrantPermissionValues = ["read", "use", "manage"] as const;
export type AccessGrantPermission =
	(typeof accessGrantPermissionValues)[number];
/** The permission-level arktype — the boundary validator the share api parses caller input through. */
export const accessGrantPermission = type("'read' | 'use' | 'manage'");

// ── access_grant — one immutable row per (resourceKind, resourceId, principalRef, permission) ────────

export const accessGrantFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
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
 * against. This is the SAME shape @euroclaw/authz's `AccessGrant` names (it imports THIS type), so the
 * store returns it and the PEP feeds it through with no translation. A host-assembled VIEW (plain TS,
 * not arktype): the untrusted boundary is the ROW (validated by `accessGrantRecord`); this is a trusted
 * projection of validated rows.
 */
export type AccessGrant = {
	principalRef: string;
	level: AccessGrantPermission;
};

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
