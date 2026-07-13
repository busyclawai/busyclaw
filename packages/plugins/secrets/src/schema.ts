import type { SchemaDeclaration } from "@euroclaw/contracts";
import { type EntityField, entity, field } from "@euroclaw/contracts";

// A stored secret is a USER-managed resolution row over the tenancy boundary pair: one row binds a
// canonical secret name, for one `(scope, scopeId)` boundary (`personal:actorId` |
// `organization:orgId` | later `team:teamId`), to either a pasted VALUE or (a later slice) a
// `{provider, ref}` POINTER into the org's own SM. The provider walks the context's OWN boundaries
// nearest-first, so a personal row beats an org-wide one. Org fully additive: an org-less
// deployment still resolves personal rows. See docs/plans/secret-store-plugin.md.
export const storedSecretKindValues = ["value", "pointer"] as const;

export const storedSecretFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	// Who saved it — accountability/erasure attribution, never the access boundary itself.
	createdBy: field.principal({ required: true, index: true, immutable: true }),
	// The access boundary. `scope` is an OPAQUE string this table never interprets; store-defaults
	// `personal:createdBy` (the claws/skills pattern).
	scope: field.string({ required: true, index: true }),
	scopeId: field.string({ required: true, index: true }),
	// The canonical secret name (`secrets.get(name)`).
	name: field.string({ required: true, index: true }),
	// `value` = pasted material lives in THIS row; `pointer` = the row redirects to
	// `{provider, ref}` (no write surface yet — the enterprise phase, shipped WITH its target-gate).
	kind: field.enum(storedSecretKindValues, { required: true }),
	// The pasted material (set iff kind=value). `redacted` keeps it out of audit/exports.
	value: field.string({ pii: "redacted" }),
	// The pointer target (set iff kind=pointer) — the SecretPointer vocabulary from contracts.
	provider: field.string(),
	ref: field.string(),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const storedSecretEntity = entity("stored_secret", storedSecretFields);
export const storedSecretRecord = storedSecretEntity.record;

// Set input: the caller names the secret, pastes the value, and says who they are; the boundary
// defaults to personal:createdBy in the store. kind/provider/ref are the STORE's to write (this
// slice writes only value-kind rows), id/timestamps are server-owned.
export const setStoredSecretInputOptions = {
	omit: ["id", "kind", "provider", "ref", "createdAt", "updatedAt"],
	optional: ["scope", "scopeId"],
} as const;
export const setStoredSecretInput = storedSecretEntity.schema(
	setStoredSecretInputOptions,
);

/** The models this plugin registers via `plugin.schema` — collected into migrations. */
export const storedSecretModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = {
	[storedSecretEntity.name]: {
		fields: storedSecretEntity.fields,
	},
};

/** The storage view of the same table — what the store persists through. */
export const storedSecretSchema: SchemaDeclaration = {
	...storedSecretEntity.storage,
};
