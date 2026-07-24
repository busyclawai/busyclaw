import type {
	AccessGrantPermission,
	AccessGrantRecord,
	AccessGrantStore,
	AppendMessageInput,
	ApprovalRecord,
	ApprovalStatus,
	BindConversationInput,
	BindConversationResult,
	CheckpointRecord,
	ClawApiCaller,
	ClawApiMethodName,
	ClawEngineHandle,
	ClawRecord,
	ClawRunReadModel,
	ClawsStore,
	ConversationBindingRecord,
	CreateCheckpointInput,
	CreateThreadInput,
	CreateToolCallInput,
	CreateToolResultInput,
	EffectStore,
	EngineContinueRunInput,
	EngineRunEvent,
	EngineRunHandle,
	EngineRunRecord,
	EngineStartRunInput,
	EuroclawPlugin,
	JsonObject,
	MessageRecord,
	PolicySliceRecord,
	Principal,
	RegisteredToolRecord,
	ResourceBinding,
	SecretDeclaration,
	Secrets,
	ThreadRecord,
	ToolCallRecord,
	ToolCallStatusPatch,
	ToolResultRecord,
	UpdateClawInput,
} from "@euroclaw/contracts";
import {
	accessGrantPermission,
	appendMessageInput,
	approvalStatus,
	bindConversationInput,
	bindConversationResult,
	CLAW_API_METHOD_NAMES,
	clawEntity,
	configurationError,
	createCheckpointInput,
	createClawInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	endpointHttpMethod,
	jsonObject,
	RESERVED_CONTEXT_PREFIX,
	SYSTEM_ANONYMOUS,
	stateError,
	toKebabCase,
	toolCallEntity,
	validationError,
} from "@euroclaw/contracts";
import {
	createSpecRegistry,
	type ModelName,
	type ModelSelection,
	REGISTER_OPENAPI_SPEC_ACTION,
	type RequiresExplicitModel,
	type RunContext,
	type RunOptionsFor,
	type Runtime,
	type RuntimeConfig,
	type RuntimeResult,
	type RuntimeStream,
	recordingFromRuntimeApprovalMetadata,
	runtimeRunOptionsWithCaller,
	runtimeRunOptionsWithRecording,
	type SpecRegistrationReport,
} from "@euroclaw/runtime";
import type { RegistryStores } from "@euroclaw/storage-durable";
import { type as ark } from "arktype";
import type { ClawRecordOf, CreateClawInputOf } from "./models";
import type { ClawRedactionHandle } from "./redaction";
import { type ActionView, assembleOrgActions } from "./registry";

/** How a read presents stored message content: `"redacted"` (default) returns it as persisted —
 *  tokens; `"original"` re-identifies for an authorized viewer (read-side only, audited). */
export type MessageView = "redacted" | "original";

/** The out-of-band caller context every governed `claw.api` method takes as its 2nd argument. Defined
 *  in `@euroclaw/contracts` (the shared protocol home, beside `Principal`) so euroclaw's api surface and
 *  the HTTP adapter's `resolveCaller` seam name ONE caller type; re-exported here for `from "euroclaw"`
 *  consumers and the `WithCaller` transform. */
export type { ClawApiCaller };

export type ClawSendInput<Config extends RuntimeConfig = RuntimeConfig> = {
	clawId: string;
	threadId: string;
	message: string;
	ctx?: RunContext<Config>;
	runId?: string;
	view?: MessageView;
} /** `model` names the pool entry that answers this message — REQUIRED when the pool has ≥2 entries
 *  and no default, optional when a default exists, and absent for a single-`model` claw. */ & ModelSelection<Config>;

export type ClawSendResult = {
	result: RuntimeResult;
	userMessage: MessageRecord;
};

export const clawCronHandlerSecretConfig = ark({
	"headerName?": ark("string | undefined").configure({
		euroclaw: {
			doc: "The request header the cron trigger presents the shared secret in; defaults to `x-euroclaw-cron-secret` when omitted.",
		},
	}),
	"limit?": ark("number | undefined").configure({
		euroclaw: {
			doc: "Caps how many due claws are processed per cron tick; unset processes every due claw.",
		},
	}),
	secret: ark("string").configure({
		euroclaw: {
			doc: "The shared secret the incoming `/cron` request must present (in `headerName`) — this is the authenticated cron variant; a mismatch is rejected 401.",
		},
	}),
});
export type ClawCronHandlerSecretConfig =
	typeof clawCronHandlerSecretConfig.infer;

export const clawCronHandlerUnsafeConfig = ark({
	"headerName?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Inert in the unauthenticated variant — no secret is compared, so this header is never read.",
		},
	}),
	"limit?": ark("number | undefined").configure({
		euroclaw: {
			doc: "Caps due claws processed per cron tick, the same throttle as the authenticated variant.",
		},
	}),
	unsafeAllowUnauthenticated: ark("true").configure({
		euroclaw: {
			doc: "Must be `true` — an explicit opt-out of cron authentication that exposes `/cron` with no secret check; named to be alarming.",
		},
	}),
});
export type ClawCronHandlerUnsafeConfig =
	typeof clawCronHandlerUnsafeConfig.infer;

export type ClawCronHandlerConfig =
	| false
	| ClawCronHandlerSecretConfig
	| ClawCronHandlerUnsafeConfig;

export type ClawContext<Config extends RuntimeConfig = RuntimeConfig> = {
	readonly runtime: Runtime<Config>;
	readonly clawsStore?: ClawsStore;
	readonly cronHandler?: ClawCronHandlerConfig;
	readonly effects?: EffectStore;
	readonly engine?: ClawEngineHandle;
	readonly runs?: ClawRunReadModel;
	/** The generic shareable-resource ACL store — backs the share/unshare api (slice 5). */
	readonly grantStore?: AccessGrantStore;
	readonly plugins?: readonly EuroclawPlugin[];
	readonly registry?: RegistryStores;
	/** The one-door reader (the full provider chain) — exposed so hosts and plugin api namespaces
	 *  resolve credentials the same way the runtime does. */
	readonly secrets?: Secrets;
	/** The collected required-secret-name declarations across plugins (feeds boot coverage). */
	readonly secretDeclarations?: readonly SecretDeclaration[];
	/** The governed redaction read-path (original view + erasure) — present when a `redaction`
	 *  group is configured. */
	readonly redaction?: ClawRedactionHandle;
};

export type ClawApi<Config extends RuntimeConfig = RuntimeConfig> = {
	bindConversation: (
		input: BindConversationInput,
	) => Promise<BindConversationResult>;

	// Claw records are config-shaped: host `additionalFields` and plugin `schema` widen both the input
	// and the returned record. Extra fields aren't patchable yet, so `updateClaw` keeps the base patch.
	createClaw: (
		input: CreateClawInputOf<Config>,
	) => Promise<ClawRecordOf<Config>>;
	getClaw: (input: { id: string }) => Promise<ClawRecordOf<Config> | null>;
	updateClaw: (input: {
		id: string;
		patch: UpdateClawInput;
	}) => Promise<ClawRecordOf<Config> | null>;
	archiveClaw: (input: { id: string }) => Promise<ClawRecordOf<Config> | null>;

	createThread: (input: CreateThreadInput) => Promise<ThreadRecord>;
	getThread: (input: { id: string }) => Promise<ThreadRecord | null>;
	listThreads: (input: { clawId: string }) => Promise<ThreadRecord[]>;
	archiveThread: (input: { id: string }) => Promise<ThreadRecord | null>;

	appendMessage: (input: AppendMessageInput) => Promise<MessageRecord>;
	getMessage: (input: { id: string }) => Promise<MessageRecord | null>;
	listMessages: (input: {
		threadId: string;
		afterSequence?: number;
		limit?: number;
		view?: MessageView;
	}) => Promise<MessageRecord[]>;
	sendMessage: (input: ClawSendInput<Config>) => Promise<ClawSendResult>;

	/** Crypto-shred every PII mapping this data-subject appears on — audited ("pii.erasure").
	 *  Fails loud when the deployment cannot honor erasure (posture "raw", custom redactor, or
	 *  no redaction configured): a no-op "success" would be false comfort. */
	forgetSubject: (input: { subjectId: string }) => Promise<void>;

	createToolCall: (input: CreateToolCallInput) => Promise<ToolCallRecord>;
	getToolCall: (input: { id: string }) => Promise<ToolCallRecord | null>;
	getToolCallByProviderId: (input: {
		runId: string;
		toolCallId: string;
	}) => Promise<ToolCallRecord | null>;
	updateToolCallStatus: (input: {
		id: string;
		patch: ToolCallStatusPatch;
	}) => Promise<ToolCallRecord | null>;

	createToolResult: (input: CreateToolResultInput) => Promise<ToolResultRecord>;
	getToolResult: (input: { id: string }) => Promise<ToolResultRecord | null>;
	listToolResults: (input: {
		runId: string;
		toolCallId: string;
	}) => Promise<ToolResultRecord[]>;

	createCheckpoint: (input: CreateCheckpointInput) => Promise<CheckpointRecord>;
	getCheckpoint: (input: { id: string }) => Promise<CheckpointRecord | null>;
	getLatestCheckpoint: (input: {
		runId: string;
	}) => Promise<CheckpointRecord | null>;

	// `options` (carrying `model`) is REQUIRED exactly when the pool has ≥2 entries and no default —
	// the compile-time "you must ask" — otherwise optional.
	generate: (
		input: {
			prompt: string;
			ctx?: RunContext<Config>;
		} & (RequiresExplicitModel<Config> extends true
			? { options: RunOptionsFor<Config> & { model: ModelName<Config> } }
			: { options?: RunOptionsFor<Config> }),
	) => Promise<RuntimeResult>;
	/** Streaming counterpart of `generate` — same input, returns a `{ textStream, result }`. In-process
	 *  only (streaming has no HTTP route). Requires a streaming loop vendor. */
	stream: (
		input: {
			prompt: string;
			ctx?: RunContext<Config>;
		} & (RequiresExplicitModel<Config> extends true
			? { options: RunOptionsFor<Config> & { model: ModelName<Config> } }
			: { options?: RunOptionsFor<Config> }),
	) => RuntimeStream;
	continueRun: (input: {
		approvalId: string;
		ctx?: RunContext<Config>;
		options?: RunOptionsFor<Config>;
	}) => Promise<RuntimeResult | null>;

	// The decider identity (`decidedBy`) is SERVER-STAMPED from the authenticated `{ principal }`, never
	// a caller-supplied `by` — a forged approver is a compile error (docs/plans/stamped-fields.md, #6).
	grantApproval: (input: {
		approvalId: string;
	}) => Promise<ApprovalRecord | null>;
	denyApproval: (input: {
		approvalId: string;
		reason?: string;
	}) => Promise<ApprovalRecord | null>;
	getApproval: (input: { id: string }) => Promise<ApprovalRecord | null>;
	listApprovals: (input?: {
		status?: ApprovalStatus;
		principal?: Principal;
	}) => Promise<ApprovalRecord[]>;

	getEffect: (input: { id: string }) => ReturnType<EffectStore["get"]>;

	// Tool registry (product): register an OpenAPI spec as governed tools, and read the assembled
	// per-organization action vocabulary the policy router compiles against.
	// `registeredBy` is SERVER-STAMPED from `{ principal }` (docs/plans/stamped-fields.md, #5-family);
	// `organizationId` stays caller-supplied for now (its stamping needs `organization()`, out of scope).
	registerOpenApiSpec: (input: {
		source: string;
		document: JsonObject;
		organizationId: string;
	}) => Promise<SpecRegistrationReport>;
	listRegisteredTools: (input: {
		organizationId: string;
		source?: string;
	}) => Promise<RegisteredToolRecord[]>;
	listActions: (input: { organizationId: string }) => Promise<ActionView[]>;

	// Customer policy slices (slice 6b): a customer's own Cedar policies, each enforce|shadow|off,
	// merged over the code-owned system posture. Edits append to the authz change log → the org
	// router rebuilds on the next decision. euroclaw stays engine-agnostic — it stores the slices; the
	// host composes createOrgPolicyRouter with a cedar engineFor (see the policy-slice E2E).
	// `updatedBy` is SERVER-STAMPED from `{ principal }` (docs/plans/stamped-fields.md); `organizationId`
	// stays caller-supplied until `organization()` lands (out of scope).
	putPolicySlice: (input: {
		organizationId: string;
		name: string;
		cedar: string;
		mode: "enforce" | "shadow" | "off";
	}) => Promise<PolicySliceRecord>;
	listPolicySlices: (input: {
		organizationId: string;
	}) => Promise<PolicySliceRecord[]>;
	deletePolicySlice: (input: {
		organizationId: string;
		id: string;
	}) => Promise<void>;

	startRun: (input: EngineStartRunInput) => Promise<EngineRunHandle>;
	continueEngineRun: (
		input: EngineContinueRunInput,
	) => Promise<EngineRunHandle>;
	getRun: (input: { id: string }) => Promise<EngineRunRecord | null>;
	listRunEvents: (input: { runId: string }) => Promise<EngineRunEvent[]>;

	// The generic share/unshare api (slice 5) — write/revoke an access_grant on ANY shareable resource.
	// LEVEL manage: the PEP requires the caller MANAGE the target (resourceKind, resourceId) first, so you
	// can only share what you manage. The accountable grantor (`grantedBy`) is SERVER-STAMPED from the
	// authenticated `{ principal }`, never caller-supplied (docs/plans/stamped-fields.md).
	shareResource: (input: {
		resourceKind: string;
		resourceId: string;
		principalRef: string;
		permission: AccessGrantPermission;
	}) => Promise<AccessGrantRecord>;
	unshareResource: (input: {
		resourceKind: string;
		resourceId: string;
		principalRef: string;
	}) => Promise<number>;
};

/** The FLAT, ROUTABLE api methods — the ones the method→route machinery maps. `stream` is excluded:
 *  its `{ textStream, result }` return isn't serializable, so it's an in-process method with no HTTP
 *  route (streaming would need SSE, a separate transport). */
export type ClawApiMethod = Exclude<keyof ClawApi, "stream">;
export type ClawApiHttpMethod = "GET" | "POST";
export type ClawApiInputSchema = (input: unknown) => unknown;
/** A method's DOMAIN input type (the caller's first arg), `undefined`-stripped so an optional-input
 *  method (`listApprovals`) still exposes its keys. The type the co-located `resource` binding checks. */
export type ClawApiMethodInput<Method extends ClawApiMethod> = NonNullable<
	Parameters<ClawApi[Method]>[0]
>;
export type ClawApiRouteDefinition<
	Method extends ClawApiMethod = ClawApiMethod,
> = {
	apiMethod: Method;
	httpMethod: ClawApiHttpMethod;
	path: `/${string}`;
	inputSchema: ClawApiInputSchema;
	/** The CO-LOCATED app-authz resource binding, type-checked against THIS method's input: `idKey`/
	 *  `kindKey` must be keys of {@link ClawApiMethodInput} or it won't compile. Read by the PEP loader
	 *  (`authz-pep.ts`) to resolve the resource; absent ⇒ the method acts within the caller's personal
	 *  scope. This is where the old central `CORE_API_RESOURCES`/`DYNAMIC_KIND_METHODS` maps now live. */
	resource?: ResourceBinding<ClawApiMethodInput<Method>>;
};

const idInput = ark({ id: "string" });
const clawIdInput = ark({ clawId: "string" });
const runIdInput = ark({ runId: "string" });
const runToolCallInput = ark({
	runId: "string",
	toolCallId: ark("string").configure({
		euroclaw: {
			doc: "The provider-assigned tool-call id (not the internal record id); tool-call ids are unique only within a run, so `runId` scopes the lookup.",
		},
	}),
});
const jsonObjectOrUndefined = jsonObject.or("undefined").configure({
	euroclaw: {
		doc: "Opaque JSON run context threaded to the run; any key using the reserved context prefix is rejected — those are host-injected, not caller-supplied.",
	},
});
const runtimeAbortSignalInput = ark({
	aborted: ark("boolean").configure({
		euroclaw: {
			doc: "The serialized `AbortSignal`, reduced to its `aborted` boolean to cross the api boundary.",
		},
	}),
});
const runtimeRunOptionsInput = ark({
	"abortSignal?": runtimeAbortSignalInput.or("undefined").configure({
		euroclaw: {
			doc: "A run option accepted over the wire; the schema drops `runMode`/recording, which are set server-side.",
		},
	}),
	"model?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Which model from the `models` pool runs this turn (by name); omit → the pool default. An unknown name fails closed. The TYPE narrows this to the config's pool keys for in-process callers; over the wire it is a validated string.",
		},
	}),
});
const runtimeRunOptionsOrUndefined = runtimeRunOptionsInput.or("undefined");
const engineRunMetadataInput = ark({
	"principal?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Caller-supplied principal recorded on the durable run for attribution.",
		},
	}),
	"id?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Pins the durable run id (idempotency / correlation) instead of letting the engine mint one.",
		},
	}),
	"team?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Team/tenant tag carried on the durable run for attribution.",
		},
	}),
});
const engineRunMetadataOrUndefined = engineRunMetadataInput.or("undefined");
// Both derive straight from the entities' immutable/input flags — every mutable, caller-facing column,
// all optional. No hand-listed pick/optional (which is also why the updatedAt server column no longer
// leaks into the tool-call patch). `scope`/`scopeId` are storage-mutable but OMITTED from the updateClaw
// patch: re-scoping is a governed sharing transition, never a mass-assignable patch field
// (docs/plans/stamped-fields.md, #5) — a `patch.scope` is a compile error.
const updateClawPatchInput = clawEntity.updateSchema("scope", "scopeId");
const toolCallStatusPatchInput = toolCallEntity.updateSchema();

export type {
	BindConversationClawInput,
	BindConversationInput,
	BindConversationResult,
	BindConversationThreadInput,
} from "@euroclaw/contracts";
// The bindConversation protocol (schemas + types) lives in @euroclaw/contracts next to the entities
// it derives from — channel plugins validate against it without depending on this assembly package.
// Re-exported here because it is part of the product api surface.
export {
	bindConversationClawInput,
	bindConversationInput,
	bindConversationResult,
	bindConversationThreadInput,
} from "@euroclaw/contracts";

const listMessagesInput = ark({
	"afterSequence?": ark("number | undefined").configure({
		euroclaw: {
			doc: "Keyset cursor — returns only messages whose `sequence` is greater than this, not an offset.",
		},
	}),
	"limit?": "number | undefined",
	threadId: ark("string").configure({
		euroclaw: {
			doc: "The thread to list; also resolves the claw scope when `view: 'original'` re-identifies the returned rows.",
		},
	}),
	"view?": ark("'redacted' | 'original' | undefined").configure({
		euroclaw: {
			doc: "`'original'` re-identifies ONLY the returned copies (rows at rest stay tokenized) and is audited as `pii.reidentification`; defaults to `'redacted'` and is a silent no-op when no redaction is configured.",
		},
	}),
});
const sendMessageInput = ark({
	clawId: ark("string").configure({
		euroclaw: {
			doc: "The claw whose transcript the user message is appended to; also the redaction scope id used to tokenize the persisted message.",
		},
	}),
	"ctx?": jsonObjectOrUndefined,
	message: ark("string").configure({
		euroclaw: {
			doc: "Persisted tokenized as a `role: 'user'` message before the run, then passed verbatim to the runtime as the prompt.",
		},
	}),
	"runId?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Optional caller-supplied run id; when omitted a fresh `run`-prefixed id is minted, and it ties the persisted user message to the run recording.",
		},
	}),
	threadId: ark("string").configure({
		euroclaw: {
			doc: "The thread the message belongs to; recorded on the run recording metadata.",
		},
	}),
	"view?": ark("'redacted' | 'original' | undefined").configure({
		euroclaw: {
			doc: "Like `listMessages`, `'original'` re-identifies only the returned result object and is audited; a no-op without redaction.",
		},
	}),
	"model?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Which model from the `models` pool answers this message (by name); omit → the pool default. TYPE-narrowed to the config's pool keys for in-process callers.",
		},
	}),
});
const forgetSubjectInput = ark({
	subjectId: ark("string").configure({
		euroclaw: {
			doc: "The data-subject key crypto-shredded across every PII mapping; fails loud (not a silent success) when the deployment cannot honor erasure, and is audited as `pii.erasure`.",
		},
	}),
});
const generateInput = ark({
	"ctx?": jsonObjectOrUndefined,
	"options?": runtimeRunOptionsOrUndefined,
	prompt: ark("string").configure({
		euroclaw: {
			doc: "Passed straight to the runtime as the prompt; unlike `sendMessage` this does NOT persist a transcript message.",
		},
	}),
});
const continueRunInput = ark({
	approvalId: ark("string").configure({
		euroclaw: {
			doc: "The approval being resumed; the handler loads it and rebuilds the run recording from its metadata to continue the original run.",
		},
	}),
	"ctx?": jsonObjectOrUndefined,
	"options?": runtimeRunOptionsOrUndefined,
});
// No `by`: the decider (`decidedBy`) is stamped from the authenticated caller `{ principal }` in the
// handler, so a forged approver identity is impossible (docs/plans/stamped-fields.md, #6).
const grantApprovalInput = ark({ approvalId: "string" });
const denyApprovalInput = ark({
	approvalId: "string",
	"reason?": "string | undefined",
});
const listApprovalsInput = ark({
	"principal?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Optional principal filter; the wire type is a plain string here even though the api models it as `Principal`.",
		},
	}),
	"status?": approvalStatus.or("undefined"),
});
const startRunInput = ark({
	"ctx?": jsonObjectOrUndefined,
	prompt: ark("string").configure({
		euroclaw: {
			doc: "The prompt for the durable engine run — distinct from the runtime `run` path.",
		},
	}),
	"run?": engineRunMetadataOrUndefined,
});
const continueEngineRunInput = ark({
	approvalId: ark("string").configure({
		euroclaw: {
			doc: "The approval whose grant resumes the durable engine run.",
		},
	}),
	"ctx?": jsonObjectOrUndefined,
	"run?": engineRunMetadataOrUndefined,
});
const shareResourceInput = ark({
	resourceKind: ark("string").configure({
		euroclaw: {
			doc: "The OPAQUE kind label of the resource being shared (`claw`/`thread`/`skill`/…); the PEP loads it via the loader registry and requires the caller MANAGE it before the grant is written.",
		},
	}),
	resourceId: "string",
	principalRef: ark("string").configure({
		euroclaw: {
			doc: "The polymorphic grantee — `user:<id>` | `team:<id>` | `organization:<id>` | `public`. Opaque; `user:`/`public` grants are LIVE, `team:`/`organization:` land as data but stay dormant until memberships resolve.",
		},
	}),
	permission: accessGrantPermission.configure({
		euroclaw: {
			doc: "The level conferred (`read` < `use` < `manage`); `share` folds into `manage`.",
		},
	}),
	// No `grantedBy`: the accountable grantor is stamped from the authenticated caller `{ principal }` in
	// the handler (docs/plans/stamped-fields.md), never caller-supplied.
});
const unshareResourceInput = ark({
	resourceKind: "string",
	resourceId: "string",
	principalRef: ark("string").configure({
		euroclaw: {
			doc: "The grantee whose grants on (resourceKind, resourceId) are revoked — removes EVERY level that principalRef held on the resource.",
		},
	}),
});
const registerOpenApiSpecInput = ark({
	document: jsonObject.configure({
		euroclaw: {
			doc: "The full OpenAPI spec as JSON; size-capped and parsed into governed per-tool records (rejected unless OpenAPI 3.x).",
		},
	}),
	organizationId: "string",
	// No `registeredBy`: the registrant is stamped from the authenticated caller `{ principal }` in the
	// handler (docs/plans/stamped-fields.md), never caller-supplied.
	source: ark("string").configure({
		euroclaw: {
			doc: "Address prefix grouping the spec's tools (`<source>.<tool>`); must be a dot-free slug, and later filters `listRegisteredTools` by source.",
		},
	}),
});
const listRegisteredToolsInput = ark({
	organizationId: "string",
	"source?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Optional source filter — present narrows to that source, absent lists the whole org.",
		},
	}),
});
const listActionsInput = ark({
	organizationId: ark("string").configure({
		euroclaw: {
			doc: "The tenant whose assembled action vocabulary is returned — the base register-spec action plus registered tools merged with the facts overlay, i.e. what the policy router compiles against.",
		},
	}),
});
const putPolicySliceInput = ark({
	cedar: ark("string").configure({
		euroclaw: {
			doc: "Raw Cedar policy text, stored verbatim — euroclaw stays engine-agnostic; the host composes the Cedar engine.",
		},
	}),
	mode: ark("'enforce' | 'shadow' | 'off'").configure({
		euroclaw: {
			doc: "`enforce` blocks, `shadow` evaluates without blocking, `off` disables — the slice's effect over the code-owned system posture.",
		},
	}),
	name: ark("string").configure({
		euroclaw: {
			doc: "Upsert key within the org — `putPolicySlice` upserts by (organization, name), not create-only.",
		},
	}),
	organizationId: "string",
	// No `updatedBy`: the editor identity is stamped from the authenticated caller `{ principal }` in the
	// handler (docs/plans/stamped-fields.md), never caller-supplied.
});
const listPolicySlicesInput = ark({ organizationId: "string" });
const deletePolicySliceInput = ark({
	organizationId: ark("string").configure({
		euroclaw: {
			doc: "Scopes the delete — keyed by (organizationId, id), so a slice is only removable within its owning org.",
		},
	}),
	id: "string",
});
export const clawApiInputSchemas = {
	bindConversation: bindConversationInput,
	appendMessage: appendMessageInput,
	archiveClaw: idInput,
	archiveThread: idInput,
	continueEngineRun: continueEngineRunInput,
	continueRun: continueRunInput,
	createCheckpoint: createCheckpointInput,
	createClaw: createClawInput,
	createThread: createThreadInput,
	createToolCall: createToolCallInput,
	createToolResult: createToolResultInput,
	deletePolicySlice: deletePolicySliceInput,
	denyApproval: denyApprovalInput,
	forgetSubject: forgetSubjectInput,
	getApproval: idInput,
	getCheckpoint: idInput,
	getClaw: idInput,
	getEffect: idInput,
	getLatestCheckpoint: runIdInput,
	getMessage: idInput,
	getRun: idInput,
	getThread: idInput,
	getToolCall: idInput,
	getToolCallByProviderId: runToolCallInput,
	getToolResult: idInput,
	grantApproval: grantApprovalInput,
	listActions: listActionsInput,
	listApprovals: listApprovalsInput,
	listMessages: listMessagesInput,
	listPolicySlices: listPolicySlicesInput,
	listRegisteredTools: listRegisteredToolsInput,
	listRunEvents: runIdInput,
	listThreads: clawIdInput,
	listToolResults: runToolCallInput,
	putPolicySlice: putPolicySliceInput,
	registerOpenApiSpec: registerOpenApiSpecInput,
	generate: generateInput,
	sendMessage: sendMessageInput,
	shareResource: shareResourceInput,
	startRun: startRunInput,
	unshareResource: unshareResourceInput,
	updateClaw: ark({ id: "string", patch: updateClawPatchInput }),
	updateToolCallStatus: ark({ id: "string", patch: toolCallStatusPatchInput }),
	// Keyed by the SHARED name list (contracts), which closes the drift triangle at compile time:
	// this satisfies pins the map's keys to CLAW_API_METHOD_NAMES exactly; apiRoute() below pins the
	// list to ClawApi (each listed name must be an api method to call it, and indexing this map by
	// the full ClawApiMethod union fails if an api method is missing from the list). So list, map,
	// and api keys are provably one set — a drifted name cannot silently lose its route (server) or
	// its call (client).
} satisfies { readonly [Method in ClawApiMethodName]: ClawApiInputSchema };

// Path + verb derive from the ONE shared source in contracts (`toKebabCase` / `endpointHttpMethod`)
// — the same functions plugin `endpoints()` mounts use, so the flat api and plugin namespaces can
// never disagree on the splitter or the read rule.
function apiMethodPath(method: ClawApiMethod): `/${string}` {
	return `/${toKebabCase(method)}`;
}

function apiHttpMethod(method: ClawApiMethod): ClawApiHttpMethod {
	return endpointHttpMethod(method);
}

function apiRoute<Method extends ClawApiMethod>(
	method: Method,
	resource?: ResourceBinding<ClawApiMethodInput<Method>>,
): ClawApiRouteDefinition<Method> {
	return {
		apiMethod: method,
		httpMethod: apiHttpMethod(method),
		path: apiMethodPath(method),
		inputSchema: clawApiInputSchemas[method],
		...(resource !== undefined ? { resource } : {}),
	};
}

// The per-method route table. Each method's app-authz resource binding is CO-LOCATED at its own
// `apiRoute(...)` call and type-checked against that method's input (`idKey`/`kindKey` ∈ keyof input) —
// the "derive from the api itself" principle. A method with no binding is not resource-anchored (the
// PEP falls to the caller's personal scope). This is the home the old central `CORE_API_RESOURCES` +
// `DYNAMIC_KIND_METHODS` maps moved to. `satisfies` pins the keys to `ClawApiMethod` exactly, and the
// list assertion below pins the shared contracts name list to real api methods — together, the server
// route table, the client's call table, and the wire-name list are provably one set.
export const clawApiRoutes = {
	bindConversation: apiRoute("bindConversation"),
	createClaw: apiRoute("createClaw"),
	// claw — the base shared agent resource (its id keys the row directly).
	getClaw: apiRoute("getClaw", { kind: "claw", idKey: "id" }),
	updateClaw: apiRoute("updateClaw", { kind: "claw", idKey: "id" }),
	archiveClaw: apiRoute("archiveClaw", { kind: "claw", idKey: "id" }),
	// thread — a method reaching a claw via one of its threads/messages anchors on that claw (its grants
	// inherit down); a method acting on the thread row itself anchors on the thread.
	createThread: apiRoute("createThread", { kind: "claw", idKey: "clawId" }),
	getThread: apiRoute("getThread", { kind: "thread", idKey: "id" }),
	listThreads: apiRoute("listThreads", { kind: "claw", idKey: "clawId" }),
	archiveThread: apiRoute("archiveThread", { kind: "thread", idKey: "id" }),
	appendMessage: apiRoute("appendMessage", { kind: "claw", idKey: "clawId" }),
	getMessage: apiRoute("getMessage"),
	listMessages: apiRoute("listMessages", { kind: "thread", idKey: "threadId" }),
	sendMessage: apiRoute("sendMessage", { kind: "claw", idKey: "clawId" }),
	forgetSubject: apiRoute("forgetSubject"),
	createToolCall: apiRoute("createToolCall"),
	getToolCall: apiRoute("getToolCall"),
	getToolCallByProviderId: apiRoute("getToolCallByProviderId"),
	updateToolCallStatus: apiRoute("updateToolCallStatus"),
	createToolResult: apiRoute("createToolResult"),
	getToolResult: apiRoute("getToolResult"),
	listToolResults: apiRoute("listToolResults"),
	createCheckpoint: apiRoute("createCheckpoint"),
	getCheckpoint: apiRoute("getCheckpoint"),
	getLatestCheckpoint: apiRoute("getLatestCheckpoint"),
	generate: apiRoute("generate"),
	continueRun: apiRoute("continueRun"),
	grantApproval: apiRoute("grantApproval"),
	denyApproval: apiRoute("denyApproval"),
	getApproval: apiRoute("getApproval"),
	listApprovals: apiRoute("listApprovals"),
	getEffect: apiRoute("getEffect"),
	registerOpenApiSpec: apiRoute("registerOpenApiSpec"),
	listRegisteredTools: apiRoute("listRegisteredTools"),
	listActions: apiRoute("listActions"),
	putPolicySlice: apiRoute("putPolicySlice"),
	listPolicySlices: apiRoute("listPolicySlices"),
	deletePolicySlice: apiRoute("deletePolicySlice"),
	// startRun/continueEngineRun mint/advance the CALLER'S OWN run (no row to load) → personal scope; the
	// run finally isolates getRun/listRunEvents by the durable run's principal.
	startRun: apiRoute("startRun"),
	continueEngineRun: apiRoute("continueEngineRun"),
	getRun: apiRoute("getRun", { kind: "run", idKey: "id" }),
	listRunEvents: apiRoute("listRunEvents", { kind: "run", idKey: "runId" }),
	// The generic share/unshare api — DYNAMIC kind: the target (kind, id) both come from the INPUT, so
	// any registered kind is shareable with zero per-kind code. LEVEL manage (see CORE_API_LEVELS): the
	// PEP requires the caller MANAGE the target before a grant is written. Unregistered kind → fail closed.
	shareResource: apiRoute("shareResource", {
		kindKey: "resourceKind",
		idKey: "resourceId",
	}),
	unshareResource: apiRoute("unshareResource", {
		kindKey: "resourceKind",
		idKey: "resourceId",
	}),
} satisfies {
	readonly [Method in ClawApiMethod]: ClawApiRouteDefinition<Method>;
};

// The route table's keys are `ClawApiMethod` (the `satisfies` above); this pins the shared contracts
// name list to real api methods — the direction the old `.map(CLAW_API_METHOD_NAMES)` used to enforce.
// Together they prove `CLAW_API_METHOD_NAMES` === `ClawApiMethod`, so a drifted wire name cannot ship.
const _apiMethodNamesAreMethods =
	CLAW_API_METHOD_NAMES satisfies readonly ClawApiMethod[];
void _apiMethodNamesAreMethods;

export const clawApiRouteList = Object.values(clawApiRoutes);

export function parseClawApiInput(method: string, input: unknown): unknown {
	const route = (clawApiRoutes as Record<string, ClawApiRouteDefinition>)[
		method
	];
	if (!route) {
		throw validationError("claw.api input", `unknown api method: ${method}`, {
			method,
		});
	}
	const valid = route.inputSchema(input);
	if (valid instanceof ark.errors) {
		throw validationError(`claw.api.${method} input`, valid.summary, {
			method,
		});
	}
	return valid;
}

function requireClawsStore(store: ClawsStore | undefined): ClawsStore {
	if (!store) {
		throw configurationError("claw.api requires a ClawsStore", {
			reason: "pass database or stores.claws to createClaw",
		});
	}
	return store;
}

function requireEngine(engine: ClawEngineHandle | undefined): ClawEngineHandle {
	if (!engine) {
		throw configurationError("claw.api requires an engine", {
			reason: "pass engine to createClaw",
		});
	}
	return engine;
}

function requireRuns(runs: ClawRunReadModel | undefined): ClawRunReadModel {
	if (!runs) {
		throw configurationError("claw.api requires a run read model", {
			reason: "pass an engine that exposes runs to createClaw",
		});
	}
	return runs;
}

function requireEffects(effects: EffectStore | undefined): EffectStore {
	if (!effects) {
		throw configurationError("claw.api requires an EffectStore", {
			reason: "pass database or stores.effects to createClaw",
		});
	}
	return effects;
}

function requireRegistry(registry: RegistryStores | undefined): RegistryStores {
	if (!registry) {
		throw configurationError("claw.api requires the tool registry stores", {
			reason: "pass database to createClaw",
		});
	}
	return registry;
}

function requireGrantStore(
	grantStore: AccessGrantStore | undefined,
): AccessGrantStore {
	if (!grantStore) {
		throw configurationError("claw.api requires the access-grant store", {
			reason: "pass database to createClaw",
		});
	}
	return grantStore;
}

/** Reject a caller-supplied reserved (`euroclaw__`) context key — identity/authz facts are euroclaw's
 *  word, written only by trusted resolution, never a caller claim. Co-located with the ctx-bearing
 *  handlers that call it (the run-context methods): the input schema declaring a `ctx` IS the contract
 *  for who asserts. (The runtime also strips reserved keys defensively; this fails loud at the api.) */
function assertNoReservedContext(ctx: unknown): void {
	if (ctx === undefined || ctx === null || typeof ctx !== "object") return;
	for (const key of Object.keys(ctx)) {
		if (key.startsWith(RESERVED_CONTEXT_PREFIX)) {
			throw validationError(
				"claw.api context invalid",
				`reserved context key is not accepted: ${key}`,
				{ key },
			);
		}
	}
}

async function requireClawRecord(
	store: ClawsStore,
	id: string,
): Promise<ClawRecord> {
	const claw = await store.claws.get(id);
	if (!claw) throw stateError("claw not found", { id });
	return claw;
}

async function requireThreadRecord(
	store: ClawsStore,
	id: string,
): Promise<ThreadRecord> {
	const thread = await store.threads.get(id);
	if (!thread) throw stateError("thread not found", { id });
	return thread;
}

async function conversationBindingResult(input: {
	store: ClawsStore;
	binding: ConversationBindingRecord;
	created: boolean;
}): Promise<BindConversationResult> {
	const claw = await requireClawRecord(input.store, input.binding.clawId);
	const thread = await requireThreadRecord(input.store, input.binding.threadId);
	const result = {
		binding: input.binding,
		claw,
		created: input.created,
		thread,
	} satisfies BindConversationResult;
	const valid = bindConversationResult(result);
	if (valid instanceof ark.errors) {
		throw validationError("bind conversation result invalid", valid.summary);
	}
	return result;
}

export function createClawApi<Config extends RuntimeConfig>(input: {
	context: ClawContext<Config>;
	newId: (prefix: string) => string;
}): ClawApi<Config> {
	const { context, newId } = input;
	const store = () => requireClawsStore(context.clawsStore);
	const registry = () => requireRegistry(context.registry);
	const requireRedaction = () => {
		if (!context.redaction) {
			throw configurationError("this deployment has no redaction configured", {
				reason: "pass redaction to createClaw",
			});
		}
		return context.redaction;
	};
	// The privacy lifecycle is ACCOUNTABLE: every re-identifying read and every erasure lands in
	// the same hash-chained audit log as tool/model calls. Payloads carry identifiers only.
	const auditPrivacy = async (
		name: "pii.reidentification" | "pii.erasure",
		payload: JsonObject,
	): Promise<void> => {
		await context.runtime.audit?.append({
			ts: new Date().toISOString(),
			boundary: "privacy",
			name,
			status: "ok",
			payload,
		});
	};

	const api = {
		async bindConversation(args, caller?: ClawApiCaller) {
			const clawsStore = store();
			const existing = await clawsStore.conversationBindings.getByExternal({
				provider: args.provider,
				endpointKey: args.endpointKey,
				externalConversationId: args.externalConversationId,
			});
			if (existing) {
				return conversationBindingResult({
					binding: existing,
					created: false,
					store: clawsStore,
				});
			}

			const existingThread = args.threadId
				? await requireThreadRecord(clawsStore, args.threadId)
				: undefined;
			// A fresh binding creates a claw; a stranger's (unauthenticated) conversation has no
			// principal of its own, so its creator is system:anonymous. It defaults to personal scope
			// (see claws.create). Binding an existing claw/thread makes that claw the source of truth.
			const claw = args.clawId
				? await requireClawRecord(clawsStore, args.clawId)
				: existingThread
					? await requireClawRecord(clawsStore, existingThread.clawId)
					: await clawsStore.claws.create({
							...args.claw,
							// createdBy is a PRINCIPAL (owner-rule / "my resources" / erasure key), never a
							// telegram id or a bot key, and it is SERVER-STAMPED from the authenticated caller —
							// NEVER from the registration's claw defaults (which no longer carry it). A stranger's
							// (unauthenticated) conversation has no caller, so it is created by system:anonymous.
							// The stranger (externalActorId) and the endpoint (provider/endpointKey) are recorded
							// on the binding row below, so nothing is lost for erasure or routing — they are simply
							// not creators (docs/plans/stamped-fields.md, #14).
							createdBy: caller?.principal ?? SYSTEM_ANONYMOUS,
						});

			const thread = existingThread
				? existingThread
				: await clawsStore.threads.create({
						...(args.thread ?? {}),
						clawId: claw.id,
					});

			if (thread.clawId !== claw.id) {
				throw validationError(
					"bind conversation input invalid",
					"thread does not match conversation claw",
					{ clawId: claw.id, threadClawId: thread.clawId },
				);
			}

			const binding = await clawsStore.conversationBindings.create({
				provider: args.provider,
				endpointKey: args.endpointKey,
				externalConversationId: args.externalConversationId,
				externalActorId: args.externalActorId,
				clawId: claw.id,
				threadId: thread.id,
				metadata: args.metadata,
			});
			return { binding, claw, thread, created: true };
		},

		// The owner and the access boundary are SERVER-STAMPED from the authenticated caller, never caller
		// input (docs/plans/stamped-fields.md, #5): `createdBy` = the caller (the owner-rule + erasure key),
		// and the claw is personal to that caller at create (`scope`/`scopeId`). A caller-less escape-hatch
		// call (unsafeOpen) stamps system:anonymous rather than crashing; the actor floor already denies an
		// absent principal for a governed call, so a normal create stamps exactly the caller it always did.
		createClaw: (args, caller?: ClawApiCaller) => {
			const principal = caller?.principal ?? SYSTEM_ANONYMOUS;
			return store().claws.create({
				...args,
				createdBy: principal,
				scope: "personal",
				scopeId: principal,
			});
		},
		getClaw: ({ id }) => store().claws.get(id),
		updateClaw: ({ id, patch }) => store().claws.update(id, patch),
		archiveClaw: ({ id }) => store().claws.archive(id),

		createThread: (args) => store().threads.create(args),
		getThread: ({ id }) => store().threads.get(id),
		listThreads: ({ clawId }) => store().threads.listForClaw(clawId),
		archiveThread: ({ id }) => store().threads.archive(id),

		async appendMessage(args) {
			// The api's own write-side ingress: content persists tokenized (posture-aware; a
			// per-claw raw row passes through). Already-tokenized text is a no-op.
			const content = context.redaction
				? await context.redaction.redact(args.content, {
						scope: "claw",
						scopeId: args.clawId,
					})
				: args.content;
			return store().messages.append({ ...args, content });
		},
		getMessage: ({ id }) => store().messages.get(id),
		async listMessages(args) {
			const rows = await store().messages.listForThread(args);
			// Read-side ONLY: the original view re-identifies the RETURNED copies; the rows at
			// rest stay tokens. No redaction configured → nothing was ever mapped → as stored.
			if (args.view !== "original" || context.redaction === undefined) {
				return rows;
			}
			const thread = await store().threads.get(args.threadId);
			if (!thread) return rows;
			const container = { scope: "claw", scopeId: thread.clawId };
			const revealed = await Promise.all(
				rows.map(async (message) => ({
					...message,
					content: await requireRedaction().original(
						message.content,
						container,
					),
				})),
			);
			await auditPrivacy("pii.reidentification", {
				...container,
				threadId: args.threadId,
				messages: rows.length,
			});
			return revealed;
		},

		async sendMessage(args, caller?: ClawApiCaller) {
			assertNoReservedContext(args.ctx);
			const clawsStore = store();
			const runId = args.runId ?? newId("run");
			// Write-side ingress for the product transcript: the persisted user message is
			// tokenized like everything else durable (posture-aware per claw row).
			const userContent = context.redaction
				? await context.redaction.redact(
						{ text: args.message },
						{ scope: "claw", scopeId: args.clawId },
					)
				: { text: args.message };
			const userMessage = await clawsStore.messages.append({
				clawId: args.clawId,
				content: userContent,
				runId,
				role: "user",
				threadId: args.threadId,
				visibility: "user",
			});
			const result = await context.runtime.generate(
				args.message,
				args.ctx as never,
				// A conversational message is a human at the other end → interactive. The chosen model
				// (if any) rides alongside the server-set recording/runMode options. The authenticated
				// caller seeds the run's principal (`euroclaw__principal`) — the run IS the caller.
				{
					...runtimeRunOptionsWithCaller(
						runtimeRunOptionsWithRecording(
							{ runMode: "interactive" },
							{
								clawId: args.clawId,
								runId,
								threadId: args.threadId,
								userMessageId: userMessage.id,
							},
						),
						caller?.principal,
					),
					model: args.model,
				},
			);
			const response = { result, userMessage };
			if (args.view !== "original" || context.redaction === undefined) {
				return response;
			}
			// Same read-side rule as listMessages: only the RETURNED copy is re-identified.
			const container = { scope: "claw", scopeId: args.clawId };
			const revealed = await requireRedaction().original(response, container);
			await auditPrivacy("pii.reidentification", {
				...container,
				threadId: args.threadId,
				runId,
				messages: 1,
			});
			return revealed;
		},

		async forgetSubject({ subjectId }) {
			await requireRedaction().forgetSubject(subjectId);
			await auditPrivacy("pii.erasure", { subjectId });
		},

		createToolCall: (args) => store().toolCalls.create(args),
		getToolCall: ({ id }) => store().toolCalls.get(id),
		getToolCallByProviderId: (args) => store().toolCalls.getByToolCallId(args),
		updateToolCallStatus: ({ id, patch }) =>
			store().toolCalls.updateStatus(id, patch),

		createToolResult: (args) => store().toolResults.create(args),
		getToolResult: ({ id }) => store().toolResults.get(id),
		listToolResults: (args) => store().toolResults.listForToolCall(args),

		createCheckpoint: (args) => store().checkpoints.create(args),
		getCheckpoint: ({ id }) => store().checkpoints.get(id),
		getLatestCheckpoint: ({ runId }) => store().checkpoints.latestForRun(runId),

		// `as never` bridges the base-`satisfies ClawApi` ctx type to the runtime's generic
		// `RunContext<Config>` — the same bridge `sendMessage` uses. The authenticated caller seeds the
		// run's principal (`euroclaw__principal`, via the forge-proof caller option); the PEP already
		// decided the caller may make this call (see authz-pep).
		generate: ({ prompt, ctx, options }, caller?: ClawApiCaller) => {
			assertNoReservedContext(ctx);
			return context.runtime.generate(
				prompt,
				ctx as never,
				runtimeRunOptionsWithCaller(options, caller?.principal) as never,
			);
		},
		stream: ({ prompt, ctx, options }, caller?: ClawApiCaller) => {
			assertNoReservedContext(ctx);
			return context.runtime.stream(
				prompt,
				ctx as never,
				runtimeRunOptionsWithCaller(options, caller?.principal) as never,
			);
		},
		async continueRun({ approvalId, ctx, options }, caller?: ClawApiCaller) {
			assertNoReservedContext(ctx);
			const approval = await context.runtime.approvals?.get(approvalId);
			const recording = approval
				? recordingFromRuntimeApprovalMetadata(approval.metadata)
				: undefined;
			// A human just granted the approval → interactive (a caller may override explicitly). The
			// authenticated caller seeds the resumed run's principal (`euroclaw__principal`).
			const continueOptions = runtimeRunOptionsWithCaller(
				{ ...options, runMode: options?.runMode ?? "interactive" },
				caller?.principal,
			);
			if (!recording) {
				return context.runtime.continueRun(
					approvalId,
					ctx as never,
					continueOptions,
				);
			}
			return context.runtime.continueRun(
				approvalId,
				ctx as never,
				runtimeRunOptionsWithRecording(continueOptions, recording),
			);
		},

		// `decidedBy` is stamped from the authenticated caller `{ principal }`, never a caller-supplied `by`
		// (docs/plans/stamped-fields.md, #6) — a forged approver identity is impossible. The runtime store's
		// grant/deny write it as the decision stamp.
		grantApproval: ({ approvalId }, caller?: ClawApiCaller) =>
			context.runtime.approvals?.grant(
				approvalId,
				caller?.principal ?? SYSTEM_ANONYMOUS,
			) ?? Promise.resolve(null),
		denyApproval: ({ approvalId, reason }, caller?: ClawApiCaller) =>
			context.runtime.approvals?.deny(
				approvalId,
				caller?.principal ?? SYSTEM_ANONYMOUS,
				reason,
			) ?? Promise.resolve(null),
		getApproval: ({ id }) =>
			context.runtime.approvals?.get(id) ?? Promise.resolve(null),
		listApprovals: (args) =>
			context.runtime.approvals?.list(args) ?? Promise.resolve([]),

		getEffect: ({ id }) => requireEffects(context.effects).get(id),

		// `registeredBy` is stamped from the authenticated caller `{ principal }`, never caller input
		// (docs/plans/stamped-fields.md). `organizationId` stays caller-supplied until `organization()`.
		registerOpenApiSpec: (args, caller?: ClawApiCaller) =>
			createSpecRegistry(registry()).registerOpenApiSpec({
				...args,
				registeredBy: caller?.principal ?? SYSTEM_ANONYMOUS,
			}),
		listRegisteredTools: ({ organizationId, source }) =>
			source !== undefined
				? registry().registeredTools.listBySource(organizationId, source)
				: registry().registeredTools.listByOrganization(organizationId),
		async listActions({ organizationId }) {
			const stores = registry();
			const [registeredTools, overlay] = await Promise.all([
				stores.registeredTools.listByOrganization(organizationId),
				stores.factsOverlay.listByOrganization(organizationId),
			]);
			return assembleOrgActions({
				base: [REGISTER_OPENAPI_SPEC_ACTION],
				registeredTools,
				overlay,
			}).actions;
		},

		// `updatedBy` is stamped from the authenticated caller `{ principal }`, never caller input
		// (docs/plans/stamped-fields.md). `organizationId` stays caller-supplied until `organization()`.
		putPolicySlice: (args, caller?: ClawApiCaller) =>
			registry().policySlices.upsert({
				...args,
				updatedBy: caller?.principal ?? SYSTEM_ANONYMOUS,
			}),
		listPolicySlices: ({ organizationId }) =>
			registry().policySlices.listByOrganization(organizationId),
		deletePolicySlice: ({ organizationId, id }) =>
			registry().policySlices.delete(organizationId, id),

		startRun: (args) => {
			assertNoReservedContext(args.ctx);
			return requireEngine(context.engine).startRun(args);
		},
		continueEngineRun: (args) => {
			assertNoReservedContext(args.ctx);
			return requireEngine(context.engine).continueRun(args);
		},
		getRun: ({ id }) => requireRuns(context.runs).get(id),
		listRunEvents: ({ runId }) => requireRuns(context.runs).events(runId),

		// The PEP has already required the caller MANAGE (resourceKind, resourceId) — so a write here is a
		// share the caller is entitled to make. The store is org-blind; principalRef stays opaque. The
		// accountable grantor (`grantedBy`) is stamped from the authenticated caller `{ principal }`, never
		// caller input (docs/plans/stamped-fields.md).
		shareResource: (
			{ resourceKind, resourceId, principalRef, permission },
			caller?: ClawApiCaller,
		) =>
			requireGrantStore(context.grantStore).create({
				resourceKind,
				resourceId,
				principalRef,
				permission,
				grantedBy: caller?.principal ?? SYSTEM_ANONYMOUS,
			}),
		unshareResource: ({ resourceKind, resourceId, principalRef }) =>
			requireGrantStore(context.grantStore).delete({
				resourceKind,
				resourceId,
				principalRef,
			}),
	} satisfies ClawApi;

	// The claws store is typed against the base claw contract, but at runtime it persists and returns
	// the host/plugin columns merged onto the claw model (see createClawsStore.additionalFields).
	// Re-present those through the config-derived claw types — the single seam between the base-typed
	// store and the config-shaped public api.
	return api as unknown as ClawApi<Config>;
}
