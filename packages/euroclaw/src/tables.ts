// Schema collection — the `getAuthTables` analog. euroclaw owns the core durable tables; plugins and
// the host register extra fields declaratively (a plugin's `schema`, the host's `models`). This module
// merges them into the one `SchemaDeclaration` the `generate` CLI turns into migrations: a model key
// that names a core table adds columns to it (extend), a new key becomes a plugin-owned table (own).
// Core columns can't be rewritten — schema is additive. The same per-model field merge also feeds the
// runtime stores (the claw store reads its `["claw"]` slice), so migration and persistence share one
// source. Nothing here — and nothing in storage-durable — imports a plugin; registration is declarative.
import {
	approvalSchema,
	authzChangeSchema,
	clawsSchema,
	configurationError,
	type EntityField,
	type EuroclawPlugin,
	effectSchema,
	entity,
	factsOverlaySchema,
	piiMappingSchema,
	piiSubjectSchema,
	policySliceSchema,
	registeredToolSchema,
	runCheckpointSchema,
	secretAliasSchema,
	specRegistrationSchema,
} from "@euroclaw/contracts";
import type { SchemaDeclaration } from "@euroclaw/storage-core";
import { teamSchema } from "@euroclaw/storage-durable";
import type { ClawModelsConfig } from "./models";

/** The tables euroclaw's own durable stores own — the base every plugin/host field merges onto. */
const CORE_TABLES: SchemaDeclaration = {
	...clawsSchema,
	...approvalSchema,
	...effectSchema,
	...piiMappingSchema,
	...piiSubjectSchema,
	...runCheckpointSchema,
	...teamSchema,
	// The tool registry is PRODUCT (rows), not a plugin — siblings of approvals/run_checkpoint.
	...specRegistrationSchema,
	...registeredToolSchema,
	...factsOverlaySchema,
	// Slice 6b: customer policy slices + the append-only authz change log (its count keys the router).
	...policySliceSchema,
	...authzChangeSchema,
};

/**
 * The extra fields contributed to each model — every plugin's `schema[model].fields`, then the host's
 * `models[model].additionalFields` (default < plugin < host, last wins). Keyed by model name; a runtime
 * store reads its own slice from here (e.g. the claw store takes `["claw"]`).
 */
export function collectModelFields(
	plugins: readonly EuroclawPlugin[],
	models: ClawModelsConfig | undefined,
): Record<string, Record<string, EntityField>> {
	const byModel: Record<string, Record<string, EntityField>> = {};
	for (const plugin of plugins) {
		for (const [model, decl] of Object.entries(plugin.schema ?? {})) {
			byModel[model] = { ...byModel[model], ...decl.fields };
		}
	}
	for (const [model, decl] of Object.entries(models ?? {})) {
		byModel[model] = { ...byModel[model], ...decl.additionalFields };
	}
	return byModel;
}

/**
 * The full table set for the `generate` CLI: euroclaw's core tables plus every field a plugin or the
 * host registers. A model key matching a core table extends it (adds columns); a new key becomes its
 * own table. Redefining a core column throws — schema is additive, never a rewrite.
 *
 * `secret_alias` is OPT-IN — included ONLY when `dynamicSecretAliases.enabled` (the better-auth
 * `dynamicAccessControl`/`organizationRole` model). A disabled deployment's generated schema and
 * migrations never mention it, so hosts who don't use DB-backed aliases run no extra migration.
 */
export function getEuroclawTables(config: {
	plugins?: readonly EuroclawPlugin[];
	models?: ClawModelsConfig;
	dynamicSecretAliases?: { enabled?: boolean };
}): SchemaDeclaration {
	const extra = collectModelFields(config.plugins ?? [], config.models);
	const tables: SchemaDeclaration = {
		...CORE_TABLES,
		...(config.dynamicSecretAliases?.enabled ? secretAliasSchema : {}),
	};
	for (const [model, fields] of Object.entries(extra)) {
		if (Object.keys(fields).length === 0) continue;
		// Turn the registered EntityFields into storage FieldAttributes via the entity DSL. The storage
		// map has exactly one entry (this model); iterate it so we never index-access a possibly-undefined.
		for (const [name, table] of Object.entries(entity(model, fields).storage)) {
			const core = CORE_TABLES[name];
			if (!core) {
				tables[name] = table;
				continue;
			}
			for (const column of Object.keys(table.fields)) {
				if (column in core.fields) {
					throw configurationError(
						`schema for model "${name}" redefines core column "${column}"`,
						{ column, model: name },
					);
				}
			}
			tables[name] = { ...core, fields: { ...core.fields, ...table.fields } };
		}
	}
	return tables;
}
