// @busyclaw/contracts — the busyclaw protocol: the governance boundary + plugin contracts, the
// entity schema DSL, and the port/schema definitions every busyclaw package speaks. One explicit
// public surface (no `export *`); the engine that runs these contracts is @busyclaw/core.

export type { BusyclawErrorCode, BusyclawErrorInput } from "@busyclaw/errors";
export {
	authorizationError,
	BusyclawError,
	configurationError,
	conflictError,
	correlationId,
	errorMessage,
	isConflict,
	limitError,
	safeFailureMessage,
	stateError,
	unsupportedOperationError,
	validationError,
} from "@busyclaw/errors";
// ── customer policy slices + the append-only authz change log (slice 6b; durable authz state —
// bundle loader/version key/shadow engine in @busyclaw/authz, stores in @busyclaw/storage-durable) ──
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
// ── authz protocol: the model + policy-engine port (toolkit in @busyclaw/authz, engines in
// @busyclaw/policy-*) ──
export type { AuthzEntity, EntityDirectory } from "./authz/directory";
export type { PolicyEngine, PolicyEngineCapabilities } from "./authz/engine";
// ── the generic shareable-resource ACL (app-authz slice 5): the access_grant entity + store port ──
export type {
	AccessGrant,
	AccessGrantPermission,
	AccessGrantRecord,
	AccessGrantResourceKey,
	AccessGrantStore,
	AccessGrantsByResource,
	GrantScope,
	NewAccessGrant,
} from "./authz/grant";
export {
	accessGrantCreateInput,
	accessGrantFields,
	accessGrantPermission,
	accessGrantPermissionValues,
	accessGrantPrincipalRef,
	accessGrantRecord,
	accessGrantSchema,
	grantLevelSatisfies,
	grantReaches,
} from "./authz/grant";
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
	policySliceEntity,
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
	ClawStoreCreateInput,
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
	assistantReplyEntity,
	assistantReplyFields,
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
	clawStoreCreateInput,
	clawStoreCreateInputOptions,
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
// ── errors ───────────────────────────────────────────────────────────────────
export type {
	ClawClientAtomListener,
	ClawClientError,
	ClawClientFetch,
	ClawClientPlugin,
	ClawClientStore,
	ClawFetchOptions,
	ClawResult,
} from "./client";
// ── primitives: json + the entity schema DSL ─────────────────────────────────
export type { JsonObject, JsonPrimitive, JsonValue } from "./common";
export { jsonObject, jsonValue } from "./common";
// ── cross-cutting ports: effects, events, per-tool governance ────────────────
export type {
	EffectAnchors,
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
// ── sandbox egress: the enforcement port (compiler in @busyclaw/runtime, adapters in plugins) ──
// ── the engine protocol: engine-neutral durable execution (impls in @busyclaw/engine-*) ──────
export type {
	ClawEngineFactory,
	ClawEngineHandle,
	ClawEngineInstance,
	ClawRunReadModel,
	DrainWorkInput,
	DrainWorkResult,
	DrainWorkStatus,
	EngineControlRunInput,
	EngineControlRunResult,
	EngineDeliverMessageInput,
	EngineDeliverMessageResult,
	EngineProceed,
	EngineProceedRunInput,
	EngineRecording,
	EngineRunEvent,
	EngineRunHandle,
	EngineRunMetadata,
	EngineRunRecord,
	EngineStartRunInput,
	EngineWorkResult,
	RunControlIntent,
	RunWaitReason,
} from "./engine";
export {
	drainWork,
	runControlIntentValues,
	runWaitReasonValues,
} from "./engine";
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
// ── governance ports: approval, audit, redaction (impls live in @busyclaw/core) ─
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
	auditActorKind,
	auditEntry,
	auditHead,
	auditInput,
	auditSupervision,
} from "./governance/audit";
// ── governance: the boundary, plugin contract, reason codes, and gate ports ──
export type {
	AbortLifetime,
	AfterGate,
	BoundaryCall,
	BoundaryGate,
	ContextResolver,
	Gate,
	GateDecision,
	GateDemand,
	HandleResult,
	Membership,
	ModelCall,
	ModelMessage,
	ModelRunner,
	Outcome,
	PolicyAnnotations,
	RunMode,
	StampedFacts,
	ToolBoundary,
	ToolCall,
	ToolRunner,
	TurnContext,
} from "./governance/boundary";
export {
	APPROVED_BY_CONTEXT_KEY,
	CLAW_ID_CONTEXT_KEY,
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	gateDecision,
	gateDemand,
	handleResult,
	MEMBERSHIPS_CONTEXT_KEY,
	MODEL_ANNOTATION_MAX_LENGTH,
	membershipRoleRef,
	membershipScopeRef,
	modelCall,
	modelMessage,
	PII_CONTAINER_ID_CONTEXT_KEY,
	PII_CONTAINER_KIND_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	policyAnnotations,
	RESERVED_CONTEXT_PREFIX,
	RUN_ACTIONS_CONTEXT_KEY,
	RUN_ID_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	runActionsOf,
	SUBJECT_CONTEXT_KEY,
	stampedFacts,
	stampRunActions,
	THREAD_ID_CONTEXT_KEY,
	toolCall,
} from "./governance/boundary";
// ── governance: the doc meta channel — the typed ArkEnv augmentation rides this module, so it
// loads with the barrel (server-side consumers) and never with the docless wire subpaths ──
export type { DocSource } from "./governance/doc";
export { docOf } from "./governance/doc";
// ── governance: declared plugin api endpoints (routable namespaces + the one kebab/verb source) ──
export type {
	EndpointDefinition,
	EndpointDefinitions,
	EndpointHttpMethod,
	EndpointInputSchema,
	EndpointOutputSchema,
	EndpointRoute,
	InferEndpoints,
} from "./governance/endpoints";
export {
	ENDPOINTS_METADATA,
	endpointHttpMethod,
	endpointRoutesOf,
	endpoints,
	toKebabCase,
} from "./governance/endpoints";
export type {
	BusyclawCronContext,
	BusyclawCronFlag,
	BusyclawCronResult,
	BusyclawCronStatus,
	BusyclawCronTask,
	BusyclawHttpMethod,
	BusyclawPlugin,
	BusyclawPluginConfigureContext,
	BusyclawPluginRuntime,
	BusyclawRoute,
	BusyclawRouteContext,
	BusyclawRouteRequest,
	BusyclawRouteResult,
	InferContext,
	InferPluginApi,
	InferPluginSchema,
	InferPlugins,
	InferReasonCodes,
	PolicyAnnotationKind,
	PolicySourceSlice,
	RequestBodyStream,
	SecretProviderPlugin,
	ShareableKind,
	ShareableLoaderContext,
	ShareableResource,
	UnionToIntersection,
} from "./governance/plugin";
// ── governance: the Principal vocabulary — the one authorizable identity (the `principal` schema is
// the boundary validator behind field.principal) ──
export type { ClawApiCaller, Principal } from "./governance/principal";
export {
	asPrincipal,
	parsePrincipal,
	principal,
	SYSTEM_ANONYMOUS,
	systemPrincipal,
	userPrincipal,
} from "./governance/principal";
export type { ReasonCode } from "./governance/reason-codes";
export { defineReasonCodes } from "./governance/reason-codes";
export type {
	Detector,
	PiiErasure,
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
	piiContainer,
	piiErasure,
	piiErasureEntity,
	piiErasureFields,
	piiErasureSchema,
	piiKind,
	piiKindValues,
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
// ── governance: the co-located app-authz resource binding (base api route defs + plugin endpoints) ──
export type {
	LooseResourceBinding,
	ResourceBinding,
	ResourceInputKey,
} from "./governance/resource-binding";
// ── governance: the type-gated route builder (.input/.output/.authz/.handler) ──
export type {
	AuthzContext,
	AuthzTarget,
	RouteAuthz,
	RouteBuilder,
	RouteDefinition,
	RouteInputSchema,
	RouteLevel,
	RouteOutputSchema,
} from "./governance/route";
export { route } from "./governance/route";
export type { PiiContainerRef } from "./pii-container";
export { UNCONTAINED } from "./pii-container";
// ── the run itself: the GOVERNANCE record every engine needs, whatever schedules its work ────
export {
	runEntity,
	runEventEntity,
	runEventFields,
	runFields,
	runSchema,
} from "./run";
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
// ── the run inbox: durable messages addressed to a run in flight ─────────────────────────────
export type {
	NewRunMessage,
	RunMessageMode,
	RunMessageRecord,
	RunMessageStatus,
} from "./run-message";
export {
	newRunMessage,
	runMessageEntity,
	runMessageFields,
	runMessageMode,
	runMessageRecord,
	runMessageSchema,
	runMessageStatus,
} from "./run-message";
// ── the opaque access boundary every scope-keyed core row carries ──
export type { ScopeRef } from "./scope";
export {
	assertUnreservedScope,
	isReservedScope,
	namesTenant,
	RESERVED_SCOPE_PREFIX,
	scopeFields,
	UNSCOPED,
} from "./scope";
// ── standard-schema interop: accept any standard-schema library without depending on one ──────
export type {
	JsonSchemaSource,
	StandardIssue,
	StandardResult,
	StandardSchemaV1Like,
} from "./standard-schema";
export { hasToJsonSchema, isStandardSchema } from "./standard-schema";
// ── the storage protocol (implementations live in @busyclaw/storage-*) ────────
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
export {
	isWhereGroup,
	sortByList,
	tableOrder,
	uniqueConstraints,
} from "./storage";
// ── streamed-run protocol shape (bridges live in @busyclaw/vendors) ──────────
export type { TextDeltaStream } from "./stream";
// ── the canonical tool descriptor: the ONE shape a tool has, whatever produced it ──
export type {
	AddressedTool,
	ToolDefinition,
	ToolDefinitionSet,
	ToolDescriptor,
	ToolExecute,
	ToolInvocation,
	ToolPresence,
	ToolTree,
} from "./tools/descriptor";
export {
	BUSYCLAW_TOOL_NAMESPACE,
	flattenToolTree,
	toolDescriptors,
	toolModelName,
} from "./tools/descriptor";
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
	factsOverlayEntity,
	factsOverlayFields,
	factsOverlayRecord,
	factsOverlaySchema,
	factsOverlayUpsert,
	registeredToolCreate,
	registeredToolFields,
	registeredToolPatch,
	registeredToolRecord,
	registeredToolSchema,
	specRegistrationEntity,
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
//    SecretPointer/SecretDeclaration); providers + reader impl live in @busyclaw/secrets ──
export type {
	ResolveContext,
	SecretDeclaration,
	SecretMaterial,
	SecretPointer,
	SecretProvider,
	SecretResolution,
	Secrets,
} from "./tools/secrets";
// ── tool sources: what every extractor produces (impls in @busyclaw/runtime) ──
export type {
	SourceDiagnostic,
	SourceExtraction,
	SourceTool,
} from "./tools/source";
export { sourceDiagnostic } from "./tools/source";
