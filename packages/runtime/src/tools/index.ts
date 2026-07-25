// The tool subsystem's barrel — pure re-exports. Impl lives in the sibling modules:
//   dispatch.ts       — gate registration + the model-facing ToolSet derived from the descriptors
//   sources/openapi/  — the OpenAPI SOURCE (spec → governed tool defs): a pure transformation
//   invoke/           — the invocation concern: the request plan, credential application, the
//                       egress floor, and the provider that synthesizes executable HTTP tools
//   registry.ts       — the governed OpenAPI registration write flow

export type { ToolExecutable } from "./dispatch";
export { modelFacingTools, registerToolGates, toolExecutor } from "./dispatch";
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
export { normalizeOrigin } from "./invoke/request-plan";
export type { SpecRegistrationReport, SpecRegistry } from "./registry";
export { createSpecRegistry, REGISTER_OPENAPI_SPEC_ACTION } from "./registry";
export type { OpenApiExtraction, OpenApiTool } from "./sources/openapi";
export { toolsFromOpenApi } from "./sources/openapi";
