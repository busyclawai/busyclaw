// Schema collection — the `getAuthTables` analog. euroclaw owns the core durable tables; plugins and
// the host register extra fields declaratively (a plugin's `schema`, the host's `models`). This module
// merges them at the FIELD level into one model map (default < plugin < host): a model key that names
// a core table adds columns to it (extend), a new key becomes a plugin-owned table (own). Core columns
// can't be rewritten — schema is additive. The merged FIELDS are the single source both projections
// derive from: `getEuroclawTables` projects them to the SchemaDeclaration the `generate` CLI turns
// into migrations, and `getEuroclawModels` feeds the entity-validating adapter the assembly wraps
// once — so a plugin's extra columns are migrated AND validated from one declaration. Nothing here —
// and nothing in storage-durable — imports a plugin; registration is declarative.
import {
	approvalFields,
	authzChangeFields,
	checkpointFields,
	clawFields,
	configurationError,
	conversationBindingFields,
	type EntityField,
	type EuroclawPlugin,
	effectStorageFields,
	entity,
	factsOverlayFields,
	messageFields,
	piiMappingFields,
	piiSubjectFields,
	policySliceFields,
	registeredToolFields,
	runCheckpointFields,
	specRegistrationFields,
	threadFields,
	toolCallFields,
	toolResultFields,
} from "@euroclaw/contracts";
import type { EntityModelMap, SchemaDeclaration } from "@euroclaw/storage-core";
import { teamInviteEntity, teamMemberEntity } from "@euroclaw/storage-durable";
import type { ClawSchemaConfig } from "./models";
import {
	clawRedactionFields,
	normalizeRedactionConfig,
	type RedactionConfig,
} from "./redaction";

/** The models euroclaw's own durable stores own — the base every plugin/host field merges onto. */
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
	run_checkpoint: runCheckpointFields,
	team_member: teamMemberEntity.fields,
	team_invite: teamInviteEntity.fields,
	// The tool registry is PRODUCT (rows), not a plugin — siblings of approvals/run_checkpoint.
	spec_registration: specRegistrationFields,
	registered_tool: registeredToolFields,
	facts_overlay: factsOverlayFields,
	// Slice 6b: customer policy slices + the append-only authz change log (its count keys the router).
	policy_slice: policySliceFields,
	authz_change: authzChangeFields,
};

/**
 * The extra fields contributed to each model — every plugin's `schema[model].fields`, then the host's
 * `schema[model].additionalFields` (default < plugin < host, last wins). Keyed by model name; a runtime
 * store reads its own slice from here (e.g. the claw store takes `["claw"]`).
 */
export function collectModelFields(
	plugins: readonly EuroclawPlugin[],
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
export function getEuroclawModels(config: {
	plugins?: readonly EuroclawPlugin[];
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
		Object.entries(merged).map(([model, fields]) => [model, { fields }]),
	);
}

/**
 * The full table set for the `generate` CLI — the storage projection of the merged model map (the
 * same fields the entity-validating adapter derives its validators from, so migration and
 * persistence share one source).
 */
export function getEuroclawTables(config: {
	plugins?: readonly EuroclawPlugin[];
	schema?: ClawSchemaConfig;
	redaction?: RedactionConfig;
}): SchemaDeclaration {
	const tables: SchemaDeclaration = {};
	for (const [model, decl] of Object.entries(getEuroclawModels(config))) {
		Object.assign(tables, entity(model, decl.fields).storage);
	}
	return tables;
}
