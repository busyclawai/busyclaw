// The tool subsystem's barrel — pure re-exports. Impl lives in the sibling modules:
//   dispatch.ts       — gate registration + the model-facing ToolSet derived from the descriptors
//   discovery.ts      — `presence: "discoverable"`: the search/execute meta-tools
//   sources/openapi/  — the OpenAPI SOURCE (spec → governed tool defs): a pure transformation
//   invoke/           — the invocation concern: the request plan, credential application, the
//                       egress floor, and the provider that synthesizes executable HTTP tools
//   registry.ts       — the governed OpenAPI registration write flow

export type { ToolAccessProbe } from "./discovery";
export {
	DISCOVERY_TOOL_PATHS,
	discoveryTools,
	EXECUTE_TOOL_PATH,
	SEARCH_TOOL_PATH,
} from "./discovery";
export type {
	ModelToolProjection,
	ResolvedToolCall,
	ToolExecutable,
} from "./dispatch";
export {
	modelToolProjection,
	registerToolGates,
	toolExecutor,
} from "./dispatch";
export type { EgressLookup, ResolvedAddress } from "./invoke/egress";
export type { PlanEgressInput, PlanEgressResult } from "./invoke/plan-egress";
export { planEgress } from "./invoke/plan-egress";
export type {
	InvokerResponse,
	RegisteredToolContext,
	RegisteredToolProvider,
	RegisteredToolProviderOptions,
} from "./invoke/provider";
export { createRegisteredToolProvider } from "./invoke/provider";
export {
	declaredOrigin,
	declaredOrigins,
	normalizeOrigin,
} from "./invoke/request-plan";
export type { SpecRegistrationReport, SpecRegistry } from "./registry";
export { createSpecRegistry, REGISTER_OPENAPI_SPEC_ACTION } from "./registry";
export type { OpenApiExtraction, OpenApiTool } from "./sources/openapi";
export { toolsFromOpenApi } from "./sources/openapi";
