// The customer policy-slice entity — slice 6b of the authz blueprint. A customer's own Cedar
// policies, stored per organization, each in enforce|shadow|off mode, merged OVER the code-owned
// system posture (deny wins; the floor is sealed). Slices ADD — a forbid or a narrower permit;
// redefining what an action IS remains the facts overlay's job (one truth per action's facts, vs
// accumulating rules about what is allowed). RULED: busyclaw stays engine-agnostic — this is the
// durable row + its store port; the bundle loader (loadPolicyBundle), the version key
// (authzBundleKey), and the shadow engine live in @busyclaw/authz, and the host composes
// createOrgPolicyRouter with a cedar engineFor.
//
// Impl lives in @busyclaw/storage-durable (the store) and @busyclaw/busyclaw (the api); this module
// holds only the entity declaration, arktype record/upsert schemas, and the derived TYPES. The
// behavioural store port lives next door in ./policy-ports.

import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";
import { scopeFields } from "../scope";

// ── policy_slice — one row per (scope, scopeId, name); upsert REPLACES in place ─────────────────

export const policySliceFields = {
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	...scopeFields,
	// A human label AND the stable slice id within the org — upsert replaces by (scope, scopeId, name).
	// Indexed like its siblings facts_overlay.actionId / spec_registration.source (the by-name lookup).
	name: field.string({ required: true, index: true }),
	// The raw customer Cedar (one or more permit/forbid statements). UNTRUSTED: stored verbatim and
	// parsed only at bundle CONSTRUCTION (cedarEngine throws configurationError on a bad set) — never
	// parsed or trusted here.
	cedar: field.string({ required: true }),
	// enforce = in the live set; shadow = a real second evaluation (diffed, never applied); off = dropped.
	mode: field.enum(["enforce", "shadow", "off"], { required: true }),
	// WHICH policy plane this slice governs — the same rule a plugin-contributed slice follows (see
	// PolicySourceSlice.plane, R-H04). A slice naming no resource type matches everything in whichever
	// engine it is compiled into, so "which engine" cannot be left to whatever the caller had in mind.
	// Stored slices are written by ADMINS at runtime rather than by plugin authors at build time,
	// which makes stating it more important here, not less: nothing about a row records what the
	// person writing it was looking at.
	plane: field.enum(["tool", "api", "both"], { required: true }),
	// WHO owns this row's content — `operator` for a slice a person wrote, `spec:<source>` for one a
	// spec registration GENERATED. Upsert replaces by name, so without this a regeneration and a human
	// edit are the same write and the store cannot tell them apart: re-registering a spec would
	// silently overwrite whatever an admin had put under the generated name, with no signal anywhere
	// that it happened. The generator rewrites only rows carrying its own tag; a row tagged `operator`
	// is DETACHED and left alone, and the registration that would have regenerated it reports the
	// divergence instead. A generated artifact you cannot take ownership of is one people work around;
	// one that silently eats edits is worse.
	//
	// An explicit value each way, never "absent means human". Optional columns drop undefined on
	// update, so absence is not writable — an edit meaning to hand the row back would silently leave
	// the generator's tag in place and the next registration would eat it, which is precisely the bug
	// this field exists to prevent. Absence therefore means only "written before this field existed".
	//
	// STAMPED BY THE DOOR, never caller input: `putPolicySlice` writes `operator` because a person
	// came through it, and the generator writes its own tag. A caller that could set this could
	// declare its hand-written slice generator-owned and have the next registration silently replace
	// it — or claim a source's tag and never be regenerated again.
	managedBy: field.string(),
	updatedBy: field.principal({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

/**
 * One slice per (scope, scopeId, name) — enforced, matching what the upsert already reads by.
 *
 * Same shape as its siblings: `id` is GENERATED, so two concurrent writers collide on nothing and
 * leave two rows for one named slice. Here that is an AUTHZ fact — reads would pick an arbitrary one
 * of two policies, and a mode change to `enforce` could land on the copy nobody reads.
 * `createRegistryStores` retries its upsert body, so the loser updates the winner's row instead.
 */
export const policySliceEntity = entity("policy_slice", policySliceFields, {
	uniques: [["scope", "scopeId", "name"]],
});
export const policySliceRecord = policySliceEntity.record;
export type PolicySliceRecord = EntityRecord<typeof policySliceFields>;

/** Upsert input — the store owns id/createdAt/updatedAt (replace-by-(scope, scopeId, name)). */
export const policySliceUpsert = policySliceEntity.schema({
	omit: ["id", "createdAt", "updatedAt"],
});
export type PolicySliceUpsert = EntityInput<
	typeof policySliceFields,
	"id" | "createdAt" | "updatedAt"
>;

/** The storage schema backing the PolicySliceStore. */
export const policySliceSchema = policySliceEntity.storage;
