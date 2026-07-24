// @euroclaw/authz — the Cedar decision engine + authz toolkit: the policy-plugin scaffolding, the
// authorization-model builder, the JSON-Schema→Cedar projection, the Cedar renderings of the model,
// AND the cedar-wasm EVAL (engine, floor engine, request mapper, escape-hatch plugin). The protocol
// (PolicyEngine port, PARC contracts, model types) lives in @euroclaw/contracts; hot-path enforcement
// lives in @euroclaw/core; the `cedar()` / `betterAuthPolicy()` policy SOURCES live in
// @euroclaw/policy-* (they contribute policy TEXT, never the engine).

export type {
	AccessGrant,
	ApiCaller,
	ApiMembership,
	ApiPermissionLevel,
	ApiResourceShape,
	DecideApiCallInput,
} from "./api";
export {
	API_ACCESS_BASELINE,
	API_ACCESS_TYPE,
	API_ACTION_GROUP,
	API_ACTION_TYPE,
	API_CREATE_GROUP,
	API_PRINCIPAL_TYPE,
	API_RESOURCE_TYPE,
	decideApiCall,
} from "./api";
export type { AuthzActionInput, BuildAuthzModelOptions } from "./build";
export { buildAuthzModel } from "./build";
export type { CedarEntityJson, CedarSchemaOptions } from "./cedar";
export {
	actionEntitiesFromModel,
	apiActionEntities,
	entitiesToCedarJson,
	modelToCedarSchema,
} from "./cedar";
export { cedarEngine } from "./cedar-engine";
export {
	cedarApiEngine,
	cedarFloorEngine,
	cedarMapCall,
	cedarPolicyPlugin,
} from "./cedar-plugin";
export type {
	CedarContext,
	CedarEngine,
	CedarEngineConfig,
	CedarEntitiesInput,
	CedarMapCallConfig,
	CedarPluginConfig,
} from "./cedar-types";
export type { FactsOverlayEntry } from "./overlay";
export { actionInputsFromRegisteredTools, mergeFactsOverlay } from "./overlay";
export type { PolicyPlugin, PolicyPluginConfig } from "./plugin";
export { createPolicyPlugin } from "./plugin";
export type {
	NamedPolicies,
	PolicyBundle,
	PolicySliceLike,
} from "./policy-bundle";
export { authzBundleKey, loadPolicyBundle } from "./policy-bundle";
export type { ArgsProjection, ProjectedShape } from "./projection";
export { projectArgs, renderCedarType } from "./projection";
export { createOrgPolicyRouter } from "./router";
export type { ShadowDivergence } from "./shadow-engine";
export { createShadowPolicyEngine } from "./shadow-engine";
export { SYSTEM_POSTURE } from "./system-posture";
