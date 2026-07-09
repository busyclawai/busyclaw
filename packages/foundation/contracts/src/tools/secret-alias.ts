// The per-org secret ALIAS — a POINTER into the org's own secret manager, never a value. Product
// durable state (like the tool registry rows), contributed to the schema ONLY when the host opts in
// with `dynamicSecretAliases: { enabled: true }` (see docs/plans/secrets-per-org-aliases.md). One row
// binds a canonical secret name, for one organization, to a `{ provider, ref }` the resolver routes
// through — `registry[provider].get(ref)`. euroclaw stores NO secret VALUES here: the column set is
// deliberately pointer-only (no value field). Pasting a raw value is DEFERRED to the org's own
// SM-as-a-plugin.
//
// This module holds the entity declaration, the arktype record/upsert schemas + derived TYPES, and the
// behavioural store PORT. The store IMPL lives in @euroclaw/storage-durable (createSecretAliasStore);
// the DB-wins resolution + the boot validation + the `claw.api.secrets` surface live in the assembly.

import type { EntityInput, EntityRecord } from "../entity";
import { entity, field } from "../entity";

// ── secret_alias — one row per (organizationId, name); `set` REPLACES it in place ────────────────
// Uniqueness on (organizationId, name) is enforced at the STORE level (findOne-then-upsert), like
// spec_registration / policy_slice — the field DSL carries per-column flags only, not composite keys.

export const secretAliasFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	organizationId: field.string({
		required: true,
		index: true,
		immutable: true,
	}),
	// The canonical secret name (`secrets.get(name)`) — half of the natural key, so immutable.
	name: field.string({ required: true, index: true, immutable: true }),
	// The SM provider KEY this alias points at (a `SecretProvider.name` in the chain).
	provider: field.string({ required: true }),
	// The key WITHIN that provider — passed straight to `provider.get(ref)` (already the backend key,
	// so the provider's own `aliases` remap does NOT apply on top).
	ref: field.string({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const secretAliasEntity = entity("secret_alias", secretAliasFields);
export const secretAliasRecord = secretAliasEntity.record;
export type SecretAliasRecord = EntityRecord<typeof secretAliasFields>;

/** Upsert input — the store owns id/createdAt/updatedAt (replace-by-(organizationId, name)). */
export const secretAliasUpsert = secretAliasEntity.schema({
	omit: ["id", "createdAt", "updatedAt"],
});
export type SecretAliasUpsert = EntityInput<
	typeof secretAliasFields,
	"id" | "createdAt" | "updatedAt"
>;

/** The storage schema backing the SecretAliasStore — merged into the generated schema ONLY when
 *  `dynamicSecretAliases.enabled` (the assembly gates it in getEuroclawTables). */
export const secretAliasSchema = secretAliasEntity.storage;

/** Where an alias points — the `{ provider, ref }` the resolver routes a canonical name through. */
export type SecretAliasPointer = { provider: string; ref: string };

/**
 * The per-org alias store PORT — mirrors ChannelRegistrationsStore (per-org rows over the generic
 * Adapter). The impl catches a "table/relation does not exist" DB error and rethrows a clear
 * `configurationError` (enabled-but-not-migrated), failing LOUD rather than falling through — a
 * missing table when an org HAS an alias could otherwise resolve the WRONG credential.
 */
export type SecretAliasStore = {
	list: (organizationId: string) => Promise<SecretAliasRecord[]>;
	get: (
		organizationId: string,
		name: string,
	) => Promise<SecretAliasRecord | null>;
	/** Upsert by (organizationId, name): create the pointer row or replace its provider/ref in place. */
	set: (
		organizationId: string,
		name: string,
		pointer: SecretAliasPointer,
	) => Promise<SecretAliasRecord>;
	delete: (organizationId: string, name: string) => Promise<void>;
	/** Cross-org scan — boot validation ONLY (coverage + inline/DB duplicate). O(all aliases); for
	 *  many orgs this is the cost docs/plans/secrets-per-org-aliases.md flags — never a hot path. */
	listAll: () => Promise<SecretAliasRecord[]>;
};
