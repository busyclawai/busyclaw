// Schema collection — the `getAuthTables` analog. busyclaw owns the core durable tables; plugins and
// the host register extra fields declaratively (a plugin's `schema`, the host's `models`). This module
// merges them at the FIELD level into one model map (default < plugin < host): a model key that names
// a core table adds columns to it (extend), a new key becomes a plugin-owned table (own). Core columns
// can't be rewritten — schema is additive. The merged FIELDS are the single source both projections
// derive from: `getBusyclawTables` projects them to the SchemaDeclaration the `generate` CLI turns
// into migrations, and `getBusyclawModels` feeds the entity-validating adapter the assembly wraps
// once — so a plugin's extra columns are migrated AND validated from one declaration. Nothing here —
// and nothing in storage-durable — imports a plugin; registration is declarative.
import {
	accessGrantFields,
	approvalFields,
	authzChangeFields,
	type BusyclawPlugin,
	checkpointFields,
	clawFields,
	configurationError,
	conversationBindingFields,
	type EntityField,
	effectStorageFields,
	entity,
	factsOverlayEntity,
	factsOverlayFields,
	messageFields,
	piiErasureFields,
	piiMappingEntity,
	piiMappingFields,
	piiSubjectFields,
	policySliceEntity,
	policySliceFields,
	registeredToolFields,
	runCheckpointFields,
	runMessageFields,
	specRegistrationEntity,
	specRegistrationFields,
	threadFields,
	toolCallFields,
	toolResultFields,
} from "@busyclaw/contracts";
import type { EntityModelMap, SchemaDeclaration } from "@busyclaw/storage-core";
import type { ClawSchemaConfig } from "./models";
import {
	clawRedactionFields,
	normalizeRedactionConfig,
	type RedactionConfig,
} from "./redaction";

/**
 * Table-level constraints for the core models that declare them.
 *
 * Sourced from the ENTITIES rather than restated, so the constraint a store's code depends on and the
 * one a migration emits are the same list. They were previously lost here: `CORE_MODELS` held field
 * maps and nothing else, so `(scope, scopeId, source)` and its siblings never reached a generator —
 * and `upsertWithRetry` documents an explicit dependency on the database rejecting the second insert.
 * Without the constraint that rejection never comes, so two concurrent upserts both INSERT.
 */
const CORE_UNIQUES: Record<string, readonly (readonly string[])[]> = {
	spec_registration:
		specRegistrationEntity.storage["spec_registration"]?.uniques ?? [],
	facts_overlay: factsOverlayEntity.storage["facts_overlay"]?.uniques ?? [],
	pii_mapping: piiMappingEntity.storage["pii_mapping"]?.uniques ?? [],
	policy_slice: policySliceEntity.storage["policy_slice"]?.uniques ?? [],
	// Natural keys that were never declared anywhere. Each is a real identity, and each was
	// enforceable only by whichever code path happened to look first:
	//   tool_call — a result is addressed by (run, toolCallId); a duplicate is a cross-run disclosure.
	//   conversation_binding — the key its own comment already states: a bot scopes external
	//     conversation ids (telegram DM chat ids repeat across bots), so without it inbound routing is
	//     ambiguous and a reply can land in the wrong thread.
	tool_call: [["runId", "toolCallId"]],
	conversation_binding: [["provider", "endpointKey", "externalConversationId"]],
};

/**
 * Refuse a constraint the physical schema could not carry — one naming a column the merged model does
 * not have. A generator handed that would emit invalid DDL or quietly skip it, and a constraint that
 * quietly did not ship is discovered in production, as duplicate rows.
 *
 * Exported for its own test because it is unreachable through the public API: a core model always has
 * the columns its own key names, which is what an assertion IS. It earned its keep immediately —
 * the first draft of `conversation_binding`'s key was written from the audit's prose rather than read
 * off the columns, and this is what caught it.
 */
export function assertUniquesRepresentable(
	model: string,
	fields: Record<string, EntityField>,
	uniques: readonly (readonly string[])[] | undefined,
): void {
	for (const key of uniques ?? []) {
		for (const column of key) {
			if (!(column in fields)) {
				throw configurationError(
					`model "${model}" declares a unique over "${column}", which it has no column for`,
					{ model, column, constraint: [...key] },
				);
			}
		}
	}
}

/** The models busyclaw's own durable stores own — the base every plugin/host field merges onto. */
const CORE_MODELS: Record<string, Record<string, EntityField>> = {
	claw: clawFields,
	thread: threadFields,
	message: messageFields,
	tool_call: toolCallFields,
	tool_result: toolResultFields,
	checkpoint: checkpointFields,
	conversation_binding: conversationBindingFields,
	approval: approvalFields,
	effect: effectStorageFields,
	pii_mapping: piiMappingFields,
	pii_subject: piiSubjectFields,
	// The erasure tombstone — durable proof of what was shredded, and from where.
	pii_erasure: piiErasureFields,
	run_checkpoint: runCheckpointFields,
	// The run inbox. CORE, not the engine's: the drain lives inside the runtime loop, and two
	// plugin-owned mailboxes would mean two drains at one site.
	run_message: runMessageFields,
	// The tool registry is PRODUCT (rows), not a plugin — siblings of approvals/run_checkpoint.
	spec_registration: specRegistrationFields,
	registered_tool: registeredToolFields,
	facts_overlay: factsOverlayFields,
	// Slice 6b: customer policy slices + the append-only authz change log (its count keys the router).
	policy_slice: policySliceFields,
	authz_change: authzChangeFields,
	// Slice 5: the generic shareable-resource ACL — one table for every kind (claw/thread/skill/…).
	access_grant: accessGrantFields,
};

/**
 * The extra fields contributed to each model — every plugin's `schema[model].fields`, then the host's
 * `schema[model].additionalFields` (default < plugin < host, last wins). Keyed by model name; a runtime
 * store reads its own slice from here (e.g. the claw store takes `["claw"]`).
 */
export function collectModelFields(
	plugins: readonly BusyclawPlugin[],
	schema: ClawSchemaConfig | undefined,
	redaction?: RedactionConfig,
): Record<string, Record<string, EntityField>> {
	const byModel: Record<string, Record<string, EntityField>> = {};
	for (const plugin of plugins) {
		for (const [model, decl] of Object.entries(plugin.schema ?? {})) {
			byModel[model] = { ...byModel[model], ...decl.fields };
		}
	}
	for (const [model, decl] of Object.entries(schema ?? {})) {
		byModel[model] = { ...byModel[model], ...decl.additionalFields };
	}
	// Per-claw posture rides an assembly-owned claw column — folded here so migrations (this same
	// collection feeds the generate CLI) and the entity-validating adapter see one declaration.
	if (normalizeRedactionConfig(redaction)?.posture === "per-claw") {
		const claw = byModel["claw"] ?? {};
		if ("redaction" in claw) {
			throw configurationError(
				'the "redaction" claw column is assembly-owned (redaction posture "per-claw") and cannot be redeclared',
				{ column: "redaction", model: "claw" },
			);
		}
		byModel["claw"] = { ...claw, ...clawRedactionFields };
	}
	return byModel;
}

/**
 * The full MODEL map (merged fields per model) — core models plus every field a plugin or the host
 * registers. A model key matching a core model extends it (adds columns); a new key becomes its own
 * model. Redefining a core column throws — schema is additive, never a rewrite. This is what the
 * assembly wraps the adapter with (entityAdapter derives both the storage projection and the
 * per-model record validators from it).
 */
export function getBusyclawModels(config: {
	plugins?: readonly BusyclawPlugin[];
	schema?: ClawSchemaConfig;
	redaction?: RedactionConfig;
}): EntityModelMap {
	const extra = collectModelFields(
		config.plugins ?? [],
		config.schema,
		config.redaction,
	);
	const merged: Record<string, Record<string, EntityField>> = {
		...CORE_MODELS,
	};
	for (const [model, fields] of Object.entries(extra)) {
		if (Object.keys(fields).length === 0) continue;
		const core = CORE_MODELS[model];
		if (!core) {
			merged[model] = fields;
			continue;
		}
		for (const column of Object.keys(fields)) {
			if (column in core) {
				throw configurationError(
					`schema for model "${model}" redefines core column "${column}"`,
					{ column, model },
				);
			}
		}
		merged[model] = { ...core, ...fields };
	}
	return Object.fromEntries(
		Object.entries(merged).map(([model, fields]) => {
			const uniques = CORE_UNIQUES[model];
			assertUniquesRepresentable(model, fields, uniques);
			return [
				model,
				{ fields, ...(uniques && uniques.length > 0 ? { uniques } : {}) },
			];
		}),
	);
}

/**
 * The full table set for the `generate` CLI — the storage projection of the merged model map (the
 * same fields the entity-validating adapter derives its validators from, so migration and
 * persistence share one source).
 */
export function getBusyclawTables(config: {
	plugins?: readonly BusyclawPlugin[];
	schema?: ClawSchemaConfig;
	redaction?: RedactionConfig;
}): SchemaDeclaration {
	const tables: SchemaDeclaration = {};
	for (const [model, decl] of Object.entries(getBusyclawModels(config))) {
		// The options go through. Rebuilding the entity from fields ALONE is what dropped every
		// table-level constraint on the way to the generators, which all read `table.uniques` and were
		// simply never given any.
		Object.assign(
			tables,
			entity(
				model,
				decl.fields,
				decl.uniques ? { uniques: decl.uniques } : undefined,
			).storage,
		);
	}
	return tables;
}
