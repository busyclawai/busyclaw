// @euroclaw/contracts — the euroclaw protocol: the governance boundary + plugin contracts, the
// entity schema DSL, and the port/schema definitions every euroclaw package speaks. One explicit
// public surface (no `export *`); the engine that runs these contracts is @euroclaw/core.

// ── errors ───────────────────────────────────────────────────────────────────
export type { EuroclawErrorCode, EuroclawErrorInput } from "@euroclaw/errors";
export {
	configurationError,
	EuroclawError,
	errorMessage,
	stateError,
	unsupportedOperationError,
	validationError,
} from "@euroclaw/errors";
// ── customer policy slices + the append-only authz change log (slice 6b; durable authz state —
// bundle loader/version key/shadow engine in @euroclaw/authz, stores in @euroclaw/storage-durable) ──
export type {
	AuthzChangeAppend,
	AuthzChangeRecord,
} from "./authz/change-log";
export {
	authzChangeAppend,
	authzChangeFields,
	authzChangeRecord,
	authzChangeSchema,
} from "./authz/change-log";
// ── authz protocol: the model + policy-engine port (toolkit in @euroclaw/authz, engines in
// @euroclaw/policy-*) ──
export type { AuthzEntity, EntityDirectory } from "./authz/directory";
export type { PolicyEngine, PolicyEngineCapabilities } from "./authz/engine";
export type {
	ActionAccess,
	ActionDef,
	ActionGroupDef,
	ActionSource,
	AuthzModel,
	EntityTypeDef,
} from "./authz/model";
export type {
	AuthzChangeStore,
	PolicySliceStore,
} from "./authz/policy-ports";
export type {
	PolicySliceRecord,
	PolicySliceUpsert,
} from "./authz/policy-slice";
export {
	policySliceFields,
	policySliceRecord,
	policySliceSchema,
	policySliceUpsert,
} from "./authz/policy-slice";
export type { EntityRef, PolicyRequest, PolicyResult } from "./authz/request";
export { entityRef, policyRequest, policyResult } from "./authz/request";
// ── claw product-api wire protocol (base method-name list + response envelope) ──
export type {
	ClawApiMethodName,
	ClawResponseEnvelope,
} from "./claw-api";
export {
	CLAW_API_METHOD_NAMES,
	clawResponseEnvelope,
	parseClawResponseEnvelope,
} from "./claw-api";
// ── claws (conversational/agent-state domain) ────────────────────────────────
export type {
	AppendMessageInput,
	BindConversationClawInput,
	BindConversationInput,
	BindConversationResult,
	BindConversationThreadInput,
	CheckpointKind,
	CheckpointRecord,
	CheckpointStore,
	ClawRecord,
	ClawStatus,
	ClawStore,
	ClawsStore,
	ConversationBindingLookup,
	ConversationBindingRecord,
	ConversationBindingStore,
	CreateCheckpointInput,
	CreateClawInput,
	CreateConversationBindingInput,
	CreateThreadInput,
	CreateToolCallInput,
	CreateToolResultInput,
	MessageRecord,
	MessageRole,
	MessageStore,
	MessageVisibility,
	ThreadRecord,
	ThreadStatus,
	ThreadStore,
	ToolCallRecord,
	ToolCallStatus,
	ToolCallStatusPatch,
	ToolCallStore,
	ToolResultOutputMode,
	ToolResultRecord,
	ToolResultStatus,
	ToolResultStore,
	UpdateClawInput,
} from "./claws/contracts";
export {
	appendMessageInput,
	bindConversationClawInput,
	bindConversationInput,
	bindConversationResult,
	bindConversationThreadInput,
	checkpointEntity,
	checkpointFields,
	checkpointKind,
	checkpointRecord,
	clawEntity,
	clawFields,
	clawRecord,
	clawStatus,
	clawsSchema,
	conversationBindingEntity,
	conversationBindingFields,
	conversationBindingRecord,
	createCheckpointInput,
	createClawInput,
	createClawInputOptions,
	createConversationBindingInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	messageEntity,
	messageFields,
	messageRecord,
	messageRole,
	messageVisibility,
	threadEntity,
	threadFields,
	threadRecord,
	threadStatus,
	toolCallEntity,
	toolCallFields,
	toolCallRecord,
	toolCallStatus,
	toolResultEntity,
	toolResultFields,
	toolResultOutputMode,
	toolResultRecord,
	toolResultStatus,
} from "./claws/schema";
// ── primitives: json + the entity schema DSL ─────────────────────────────────
export type { JsonObject, JsonPrimitive, JsonValue } from "./common";
export { jsonObject, jsonValue } from "./common";
// ── cross-cutting ports: effects, events, per-tool governance ────────────────
export type {
	EffectClaim,
	EffectCompensation,
	EffectRecord,
	EffectStatus,
	EffectStore,
} from "./effects";
export {
	effectCompensation,
	effectEntity,
	effectFields,
	effectRecord,
	effectSchema,
	effectStatus,
	effectStorageEntity,
	effectStorageFields,
} from "./effects";
// ── sandbox egress: the enforcement port (compiler in @euroclaw/runtime, adapters in plugins) ──
export type {
	EgressCapability,
	EgressPlan,
	EgressTransport,
	GovernedOutbound,
	GovernedSocket,
	OutboundRequest,
	OutboundResponse,
	SandboxEgressAdapter,
	UnenforcedNote,
} from "./egress/port";
// ── the engine protocol: engine-neutral durable execution (impls in @euroclaw/engine-*) ──────
export type {
	ClawEngineFactory,
	ClawEngineHandle,
	ClawEngineInstance,
	ClawRunReadModel,
	DrainWorkInput,
	DrainWorkResult,
	DrainWorkStatus,
	EngineContinueRunInput,
	EngineRunEvent,
	EngineRunHandle,
	EngineRunMetadata,
	EngineRunRecord,
	EngineStartRunInput,
	EngineWorkResult,
} from "./engine";
export { drainWork } from "./engine";
export type {
	EntityField,
	EntityFieldMeta,
	EntityFieldType,
	EntityInput,
	EntityRecord,
	EntitySchemaInput,
	EntitySchemaOptions,
	EntityUpdateInput,
} from "./entity";
export { entity, field } from "./entity";
export type { Event, EventSink } from "./events";
export { event } from "./events";
export type { ToolEffectPolicy, ToolGate, ToolGovernance } from "./govern";
export { govern, toolEffectPolicy, toolGovernance } from "./govern";
// ── governance ports: approval, audit, redaction (impls live in @euroclaw/core) ─
export type {
	ApprovalMetadataResolver,
	ApprovalRecord,
	ApprovalStatus,
	ApprovalStore,
	NewApproval,
} from "./governance/approval";
export {
	approvalEntity,
	approvalFields,
	approvalRecord,
	approvalSchema,
	approvalStatus,
	newApproval,
} from "./governance/approval";
export type {
	AnchorProof,
	AuditChainProblem,
	AuditChainVerification,
	AuditEntry,
	AuditHead,
	AuditInput,
	AuditSink,
} from "./governance/audit";
export {
	anchorProof,
	auditEntry,
	auditHead,
	auditInput,
} from "./governance/audit";
// ── governance: the boundary, plugin contract, reason codes, and gate ports ──
export type {
	AfterGate,
	BoundaryCall,
	BoundaryGate,
	ContextResolver,
	Gate,
	GateDecision,
	HandleResult,
	ModelCall,
	ModelMessage,
	ModelRunner,
	Outcome,
	RunMode,
	StampedFacts,
	ToolBoundary,
	ToolCall,
	ToolRunner,
	TurnContext,
} from "./governance/boundary";
export {
	CLAW_ID_CONTEXT_KEY,
	gateDecision,
	handleResult,
	modelCall,
	modelMessage,
	ORGANIZATION_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	RESERVED_CONTEXT_PREFIX,
	ROLE_CONTEXT_KEY,
	RUN_ID_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	SCOPE_CONTEXT_KEY,
	SCOPE_ID_CONTEXT_KEY,
	SUBJECT_CONTEXT_KEY,
	stampedFacts,
	TEAM_CONTEXT_KEY,
	THREAD_ID_CONTEXT_KEY,
	toolCall,
} from "./governance/boundary";
// ── governance: declared plugin api endpoints (routable namespaces + the one kebab/verb source) ──
export type {
	EndpointDefinition,
	EndpointDefinitions,
	EndpointHttpMethod,
	EndpointInputSchema,
	EndpointOutputSchema,
	EndpointRoute,
	InferEndpoints,
	ValidateEndpointOutputs,
} from "./governance/endpoints";
export {
	ENDPOINTS_METADATA,
	endpointHttpMethod,
	endpointRoutesOf,
	endpoints,
	toKebabCase,
} from "./governance/endpoints";
export type {
	EuroclawCronContext,
	EuroclawCronFlag,
	EuroclawCronResult,
	EuroclawCronStatus,
	EuroclawCronTask,
	EuroclawHttpMethod,
	EuroclawPlugin,
	EuroclawPluginConfigureContext,
	EuroclawPluginRuntime,
	EuroclawRoute,
	EuroclawRouteContext,
	EuroclawRouteRequest,
	EuroclawRouteResult,
	InferContext,
	InferPluginApi,
	InferPluginSchema,
	InferPlugins,
	InferReasonCodes,
	SecretProviderPlugin,
	UnionToIntersection,
} from "./governance/plugin";
// ── governance: the Principal vocabulary — the one authorizable identity (the `principal` schema is
// the boundary validator behind field.principal) ──
export type { Principal } from "./governance/principal";
export {
	asPrincipal,
	parsePrincipal,
	principal,
	SYSTEM_ANONYMOUS,
	SYSTEM_CRON,
	systemPrincipal,
	userPrincipal,
} from "./governance/principal";
export type { ReasonCode } from "./governance/reason-codes";
export { defineReasonCodes } from "./governance/reason-codes";
export type {
	Detector,
	PiiKind,
	PiiMapping,
	PiiMappingStore,
	PiiSpan,
	PiiSpanSource,
	PiiSpans,
	PiiSubject,
	RedactionContext,
	Redactor,
	RehydrationContext,
} from "./governance/redact";
export {
	piiKind,
	piiMapping,
	piiMappingEntity,
	piiMappingFields,
	piiMappingSchema,
	piiSpan,
	piiSpanSource,
	piiSpans,
	piiSubject,
	piiSubjectEntity,
	piiSubjectFields,
	piiSubjectSchema,
	redactionContext,
	redactionContextFrom,
	rehydrationContext,
} from "./governance/redact";
export type {
	NewRunCheckpoint,
	RunCheckpointRecord,
	RunCheckpointStatus,
	RunCheckpointStore,
} from "./run-checkpoint";
export {
	newRunCheckpoint,
	runCheckpointEntity,
	runCheckpointFields,
	runCheckpointRecord,
	runCheckpointSchema,
	runCheckpointStatus,
} from "./run-checkpoint";
// ── standard-schema interop: accept any standard-schema library without depending on one ──────
export type {
	JsonSchemaSource,
	StandardIssue,
	StandardResult,
	StandardSchemaV1Like,
} from "./standard-schema";
export { hasToJsonSchema, isStandardSchema } from "./standard-schema";
// ── the storage protocol (implementations live in @euroclaw/storage-*) ────────
export type {
	Adapter,
	FieldAttribute,
	FieldType,
	SchemaDeclaration,
	SortBy,
	TableSchema,
	Where,
	WhereClause,
	WhereGroup,
	WhereOperator,
} from "./storage";
export { isWhereGroup, sortByList } from "./storage";
// ── tool registry: durable rows for uploaded tool surfaces (impls in storage/runtime) ──
export type {
	FactsOverlayRecord,
	FactsOverlayUpsert,
	RegisteredToolCreate,
	RegisteredToolPatch,
	RegisteredToolRecord,
	SpecRegistrationRecord,
	SpecRegistrationUpsert,
} from "./tools/registry";
export {
	factsOverlayFields,
	factsOverlayRecord,
	factsOverlaySchema,
	factsOverlayUpsert,
	registeredToolCreate,
	registeredToolFields,
	registeredToolPatch,
	registeredToolRecord,
	registeredToolSchema,
	specRegistrationFields,
	specRegistrationRecord,
	specRegistrationReport,
	specRegistrationSchema,
	specRegistrationUpsert,
} from "./tools/registry";
export type {
	FactsOverlayStore,
	RegisteredToolStore,
	SpecRegistrationStore,
} from "./tools/registry-ports";
// ── secret resolution: the one-door reader (Secrets/SecretProvider/ResolveContext/SecretMaterial/
//    SecretPointer/SecretDeclaration); providers + reader impl live in @euroclaw/secrets ──
export type {
	ResolveContext,
	SecretDeclaration,
	SecretMaterial,
	SecretPointer,
	SecretProvider,
	Secrets,
} from "./tools/secrets";
// ── tool sources: what every extractor produces (impls in @euroclaw/runtime) ──
export type {
	SourceDiagnostic,
	SourceExtraction,
	SourceTool,
} from "./tools/source";
export { sourceDiagnostic } from "./tools/source";
