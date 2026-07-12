// The tool-registry entities — the durable side of the authz blueprint (slice 5). RULED: the tool
// registry is PRODUCT, not a plugin, so these are contracts entities merged into CORE_TABLES,
// siblings of approvals/run_checkpoint. Three rows describe an organization's uploaded surface:
//   spec_registration — one per (organizationId, source): the raw uploaded document (claim-check
//     blob), the registrant, the extraction report, and the content version the model built from.
//   registered_tool   — one per extracted operation: its schema/facts/binding + a per-row content
//     version. `governance` is stored as opaque JSON and re-validated through `toolGovernance` at
//     model-assembly time (never trusted blindly on read).
//   facts_overlay     — one per (organizationId, actionId) override: overlay-wins facts a customer
//     lays over the derived model (loosenings reported, not silently applied).
// Impl lives in @euroclaw/storage-durable (stores) and @euroclaw/runtime (registration flow); this
// module holds only the entity declarations, arktype record/input schemas, and the derived record/
// input TYPES. The behavioural store ports the stores satisfy live next door in ./registry-ports.

import { type } from "arktype";
import type { EntityInput, EntityRecord, EntityUpdateInput } from "../entity";
import { entity, field } from "../entity";
import { toolGovernance } from "../govern";
import { sourceDiagnostic } from "./source";

// What one registration did — the diff's outcome (addresses touched) plus the extractor's
// diagnostics, verbatim. The stored `report` column IS this schema (schema-first `field.json`).
export const specRegistrationReport = type({
	added: "string[]",
	updated: "string[]",
	removed: "string[]",
	skipped: sourceDiagnostic.array(),
	warnings: sourceDiagnostic.array(),
});

// ── spec_registration — one row per (organizationId, source); re-registration REPLACES it ──────

export const specRegistrationFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	organizationId: field.string({
		required: true,
		index: true,
		immutable: true,
	}),
	// The slug, also the address prefix (`<source>.<tool>`).
	source: field.string({ required: true, index: true, immutable: true }),
	// The raw uploaded document — claim-check style; may carry PII the spec's examples embed.
	specBlob: field.jsonObject({ required: true, pii: "possible" }),
	// Hash of the extracted tool rows — the cache key the org router routes on.
	contentVersion: field.string({ required: true }),
	// What the last registration did — schema-first, so the record type carries the report shape
	// and every read validates it.
	report: field.json(specRegistrationReport, { required: true }),
	// The acting principal at registration time.
	registeredBy: field.string({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const specRegistrationEntity = entity(
	"spec_registration",
	specRegistrationFields,
);
export const specRegistrationRecord = specRegistrationEntity.record;
export type SpecRegistrationRecord = EntityRecord<
	typeof specRegistrationFields
>;

/** Upsert input — the store owns id/createdAt/updatedAt (replace-by-(org, source)). */
export const specRegistrationUpsert = specRegistrationEntity.schema({
	omit: ["id", "createdAt", "updatedAt"],
});
export type SpecRegistrationUpsert = EntityInput<
	typeof specRegistrationFields,
	"id" | "createdAt" | "updatedAt"
>;

/** The storage schema backing the SpecRegistrationStore. */
export const specRegistrationSchema = specRegistrationEntity.storage;

// ── registered_tool — one row per extracted operation ──────────────────────────────────────────

export const registeredToolFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	organizationId: field.string({
		required: true,
		index: true,
		immutable: true,
	}),
	source: field.string({ required: true, index: true, immutable: true }),
	// The extractor's tool name.
	name: field.string({ required: true }),
	// `<source>.<name>` — the catalog-dotted action id (can never collide with host code tools).
	address: field.string({ required: true, index: true }),
	description: field.string(),
	inputSchema: field.jsonObject({ required: true }),
	// The ToolGovernance stamp. Schema-first (`field.json`): the column IS `toolGovernance`, so the
	// record type is `ToolGovernance` and every read validates it — the old opaque blob + downstream
	// re-derivation (a cast in the invoker, a re-parse at model assembly) collapse to one boundary.
	governance: field.json(toolGovernance, { required: true }),
	// Format-opaque invocation metadata (the OpenApiBinding today).
	binding: field.jsonObject({ required: true }),
	// Hash of this row's content (schema/governance/binding/description).
	contentVersion: field.string({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const registeredToolEntity = entity(
	"registered_tool",
	registeredToolFields,
);
export const registeredToolRecord = registeredToolEntity.record;
export type RegisteredToolRecord = EntityRecord<typeof registeredToolFields>;

/** Create input — the store owns id/createdAt/updatedAt. */
export const registeredToolCreate = registeredToolEntity.schema({
	omit: ["id", "createdAt", "updatedAt"],
});
export type RegisteredToolCreate = EntityInput<
	typeof registeredToolFields,
	"id" | "createdAt" | "updatedAt"
>;

/** The mutable slice a re-registration diff writes — derived from the fields' own
 *  `immutable`/`input` flags (entity.updateSchema); the store validates every patch through it
 *  and stamps `updatedAt` itself (a caller-supplied one is overridden). */
export const registeredToolPatch = registeredToolEntity.updateSchema();
export type RegisteredToolPatch = EntityUpdateInput<
	typeof registeredToolFields
>;

/** The storage schema backing the RegisteredToolStore. */
export const registeredToolSchema = registeredToolEntity.storage;

// ── facts_overlay — one row per (organizationId, actionId) override ─────────────────────────────

export const factsOverlayFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	organizationId: field.string({
		required: true,
		index: true,
		immutable: true,
	}),
	// Matches an action id (dotted for registered tools, bare for domain verbs / code tools).
	actionId: field.string({ required: true, index: true }),
	// Validated as the ActionAccess enum in the record schema (stored as a string column).
	access: field.enum(["read", "write"]),
	// A string array — schema-first (`field.json`), so it persists as a JSON column while the record
	// type is `string[]` and every read validates it strictly; a hostile stored value fails loud.
	groups: field.json(type("string[]")),
	resource: field.string(),
	audit: field.boolean(),
	updatedBy: field.string({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const factsOverlayEntity = entity("facts_overlay", factsOverlayFields);
export const factsOverlayRecord = factsOverlayEntity.record;
export type FactsOverlayRecord = EntityRecord<typeof factsOverlayFields>;

/** Upsert input — the store owns id/createdAt/updatedAt (replace-by-(org, actionId)). */
export const factsOverlayUpsert = factsOverlayEntity.schema({
	omit: ["id", "createdAt", "updatedAt"],
});
export type FactsOverlayUpsert = EntityInput<
	typeof factsOverlayFields,
	"id" | "createdAt" | "updatedAt"
>;

/** The storage schema backing the FactsOverlayStore. */
export const factsOverlaySchema = factsOverlayEntity.storage;
