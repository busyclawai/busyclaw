// The customer policy-slice entity — slice 6b of the authz blueprint. A customer's own Cedar
// policies, stored per organization, each in enforce|shadow|off mode, merged OVER the code-owned
// system posture (deny wins; the floor is sealed). Slices ADD — a forbid or a narrower permit;
// redefining what an action IS remains the facts overlay's job (one truth per action's facts, vs
// accumulating rules about what is allowed). RULED: euroclaw stays engine-agnostic — this is the
// durable row + its store port; the bundle loader (loadPolicyBundle), the version key
// (authzBundleKey), and the shadow engine live in @euroclaw/authz, and the host composes
// createOrgPolicyRouter with a cedar engineFor.
//
// Impl lives in @euroclaw/storage-durable (the store) and @euroclaw/euroclaw (the api); this module
// holds only the entity declaration, arktype record/upsert schemas, and the derived TYPES. The
// behavioural store port lives next door in ./policy-ports.

import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";

// ── policy_slice — one row per (organizationId, name); upsert REPLACES in place ─────────────────

export const policySliceFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	organizationId: field.string({
		required: true,
		index: true,
		immutable: true,
	}),
	// A human label AND the stable slice id within the org — upsert replaces by (organizationId, name).
	// Indexed like its siblings facts_overlay.actionId / spec_registration.source (the by-name lookup).
	name: field.string({ required: true, index: true }),
	// The raw customer Cedar (one or more permit/forbid statements). UNTRUSTED: stored verbatim and
	// parsed only at bundle CONSTRUCTION (cedarEngine throws configurationError on a bad set) — never
	// parsed or trusted here.
	cedar: field.string({ required: true }),
	// enforce = in the live set; shadow = a real second evaluation (diffed, never applied); off = dropped.
	mode: field.enum(["enforce", "shadow", "off"], { required: true }),
	updatedBy: field.principal({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const policySliceEntity = entity("policy_slice", policySliceFields);
export const policySliceRecord = policySliceEntity.record;
export type PolicySliceRecord = EntityRecord<typeof policySliceFields>;

/** Upsert input — the store owns id/createdAt/updatedAt (replace-by-(organizationId, name)). */
export const policySliceUpsert = policySliceEntity.schema({
	omit: ["id", "createdAt", "updatedAt"],
});
export type PolicySliceUpsert = EntityInput<
	typeof policySliceFields,
	"id" | "createdAt" | "updatedAt"
>;

/** The storage schema backing the PolicySliceStore. */
export const policySliceSchema = policySliceEntity.storage;
