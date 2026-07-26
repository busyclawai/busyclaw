export type { ToolGovernance } from "@euroclaw/contracts";
export { govern } from "@euroclaw/contracts";
export * from "./catalog";
export * from "./context";
export type {
	PluginEventRedaction,
	RuntimeEvent,
	RuntimeEventBase,
	RuntimeEventError,
	RuntimeEventFanout,
	RuntimeEventPayload,
	RuntimeEventPayloadInput,
	RuntimeEventSink,
	RuntimeModelUsage,
	RuntimeRecordingContext,
} from "./events";
export {
	createRuntimeEvent,
	emitRuntimeEvent,
	pluginEventSink,
	RUNTIME_RECORDING_CONTEXT_KEY,
	RUNTIME_RECORDING_OPTION,
	runtimeEvent,
	runtimeEventError,
	runtimeModelUsage,
	runtimeRecordingContext,
} from "./events";
export type {
	ModelName,
	ModelPool,
	ModelPoolEntry,
	ModelSelection,
	RequiresExplicitModel,
	RunContext,
	RunOptionsFor,
	Runtime,
	RuntimeAbortSignal,
	RuntimeApprovalMetadata,
	RuntimeConfig,
	RuntimeEnvironment,
	RuntimeModel,
	RuntimeRunOptions,
	RuntimeStream,
	RuntimeYieldMetadata,
} from "./runtime";
export {
	createRuntime,
	defaultRuntimeNewId,
	parseRuntimeApprovalMetadata,
	parseRuntimeYieldMetadata,
	RUNTIME_CALLER_OPTION,
	RuntimeCompletedResult,
	RuntimeDeniedResult,
	RuntimeResult,
	RuntimeWaitingApprovalResult,
	RuntimeYieldedResult,
	recordingFromRuntimeApprovalMetadata,
	runtimeApprovalMetadata,
	runtimeRunOptionsWithCaller,
	runtimeRunOptionsWithRecording,
	runtimeYieldMetadata,
} from "./runtime";
export type { SubInvoke } from "./subinvoke";
export { NESTED_APPROVAL_UNSUPPORTED, NESTED_INVOKER_TOOL } from "./subinvoke";
export type {
	EgressLookup,
	InvokerResponse,
	OpenApiExtraction,
	OpenApiTool,
	PlanEgressInput,
	PlanEgressResult,
	RegisteredToolContext,
	RegisteredToolProvider,
	RegisteredToolProviderOptions,
	ResolvedAddress,
	SpecRegistrationReport,
	SpecRegistry,
	ToolExecutable,
} from "./tools";
export {
	createRegisteredToolProvider,
	createSpecRegistry,
	// The runtime's own always-on meta-tools, and the one path the floor must NOT model. Exported so
	// the ASSEMBLY can build its action model from the same set the runtime injects: both feed one
	// chokepoint, and an action the model does not contain is denied — so a model built from host tools
	// alone would refuse discovery itself. `EXECUTE_TOOL_PATH` rides along because excluding it is part
	// of that contract, not an assembly-side opinion (see discovery.ts's header).
	discoveryTools,
	EXECUTE_TOOL_PATH,
	normalizeOrigin,
	planEgress,
	REGISTER_OPENAPI_SPEC_ACTION,
	toolExecutor,
	toolsFromOpenApi,
} from "./tools";
