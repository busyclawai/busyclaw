// The authz change log — slice 6b. An APPEND-ONLY record of every authz-state mutation for an
// organization (a spec registration, a facts-overlay edit, a policy-slice edit). Its COUNT is the
// org's authz-bundle version: authzBundleKey(org, count) keys the per-org policy router, so an edit
// takes effect on the next decision. Append-only is load-bearing — a DELETE appends a change event
// (it never removes log rows), so the count is MONOTONIC and sound under delete, where max(updatedAt)
// is not (deleting a non-newest row leaves the max unchanged → a stale, wrong bundle).
//
// The log IS the version history (a decision can be stamped with the count it evaluated against); the
// read-side audit API over it is DEFERRED — 6b only writes the log and reads its count.
//
// Impl lives in @euroclaw/storage-durable (the store) and the append call sites (createSpecRegistry +
// the overlay/policy-slice store mutations). This module holds the entity + schemas + TYPES; the
// store port lives next door in ./policy-ports.

import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";

// ── authz_change — append-only; scoped by organizationId, its count is the bundle version ────────

export const authzChangeFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	organizationId: field.string({
		required: true,
		index: true,
		immutable: true,
	}),
	kind: field.enum(["spec_registered", "overlay_changed", "policy_changed"], {
		required: true,
		immutable: true,
	}),
	// What changed — the audit detail (source / actionId / slice name). Opaque JSON; optional.
	summary: field.jsonObject(),
	at: field.string({ required: true, immutable: true }),
	by: field.principal({ required: true, immutable: true }),
} as const;

export const authzChangeEntity = entity("authz_change", authzChangeFields);
export const authzChangeRecord = authzChangeEntity.record;
export type AuthzChangeRecord = EntityRecord<typeof authzChangeFields>;

/** Append input — the store owns id/at (append-only; there is no update). */
export const authzChangeAppend = authzChangeEntity.schema({
	omit: ["id", "at"],
});
export type AuthzChangeAppend = EntityInput<
	typeof authzChangeFields,
	"id" | "at"
>;

/** The storage schema backing the AuthzChangeStore. */
export const authzChangeSchema = authzChangeEntity.storage;
