import type {
	AccessGrantPermission,
	AccessGrantRecord,
	AccessGrantStore,
	AppendMessageInput,
	ApprovalRecord,
	ApprovalStatus,
	AuthzTarget,
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
	EndpointHttpMethod,
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
	RouteAuthz,
	RouteLevel,
	ScopeRef,
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
	accessGrantPrincipalRef,
	appendMessageInput,
	approvalStatus,
	authorizationError,
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
	parsePrincipal,
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
	/**
	 * Streaming counterpart of `generate` — same input, resolving to `{ textStream, result }`.
	 * In-process only (streaming has no HTTP route). Requires a streaming loop vendor.
	 *
	 * A PROMISE of the stream, not the stream. The runtime's own `stream` returns synchronously, but
	 * every method on this surface is wrapped by the app-authz PEP, and authorizing is asynchronous —
	 * it evaluates policy and may load the resource being acted on. Returning the stream synchronously
	 * would mean handing back a live-looking object before knowing whether the call is allowed; a
	 * rejected promise hands back nothing at all, which is the honest shape for a denial.
	 */
	stream: (
		input: {
			prompt: string;
			ctx?: RunContext<Config>;
		} & (RequiresExplicitModel<Config> extends true
			? { options: RunOptionsFor<Config> & { model: ModelName<Config> } }
			: { options?: RunOptionsFor<Config> }),
	) => Promise<RuntimeStream>;
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
	// per-SCOPE action vocabulary the policy router compiles against.
	// `registeredBy` is SERVER-STAMPED from `{ principal }` (docs/plans/stamped-fields.md, #5-family).
	//
	// The boundary is the opaque `(scope, scopeId)` pair, NOT an `organizationId`: an organization is a
	// PLUGIN, so core cannot have a column named for one kind of boundary. The request NAMES the
	// boundary it wants to act in; the PEP authorizes that against verified membership before the
	// handler runs, so naming one you do not belong to resolves nothing and denies. That is what makes
	// a caller-supplied boundary key safe here — it is a lookup key, never authority.
	registerOpenApiSpec: (input: {
		source: string;
		document: JsonObject;
		scope: string;
		scopeId: string;
	}) => Promise<SpecRegistrationReport>;
	listRegisteredTools: (input: {
		scope: string;
		scopeId: string;
		source?: string;
	}) => Promise<RegisteredToolRecord[]>;
	listActions: (input: {
		scope: string;
		scopeId: string;
	}) => Promise<ActionView[]>;

	// Customer policy slices (slice 6b): a customer's own Cedar policies, each enforce|shadow|off,
	// merged over the code-owned system posture. Edits append to the authz change log → the policy
	// router rebuilds on the next decision. euroclaw stays engine-agnostic — it stores the slices; the
	// host composes createOrgPolicyRouter with a cedar engineFor (see the policy-slice E2E).
	// `updatedBy` is SERVER-STAMPED from `{ principal }` (docs/plans/stamped-fields.md); the boundary is
	// named by the request and authorized by membership, as above.
	putPolicySlice: (input: {
		scope: string;
		scopeId: string;
		name: string;
		cedar: string;
		mode: "enforce" | "shadow" | "off";
	}) => Promise<PolicySliceRecord>;
	listPolicySlices: (input: {
		scope: string;
		scopeId: string;
	}) => Promise<PolicySliceRecord[]>;
	deletePolicySlice: (input: {
		scope: string;
		scopeId: string;
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
/** Alias of the shared {@link EndpointHttpMethod} so the flat api and plugin namespaces cannot
 *  disagree on what a verb may be. */
export type ClawApiHttpMethod = EndpointHttpMethod;
export type ClawApiInputSchema = (input: unknown) => unknown;
/** Joins `(runId, toolCallId)` into one resource-registry id. A NUL byte: no identifier can contain one,
 *  so the split is unambiguous — a slash or colon could appear inside either half and silently
 *  mis-resolve to another run's row. Lives here rather than in the PEP because the PEP already imports
 *  from this module, and the reverse would be a cycle. */
export const PROVIDER_TOOL_CALL_SEPARATOR = "\u0000";

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
	/** The CO-LOCATED app-authz declaration — MANDATORY. Says what this method authorizes against and at
	 *  what level, with a resolver typed against {@link ClawApiMethodInput} so reading a field the method
	 *  does not have will not compile. Read by the PEP (`authz-pep.ts`) before the handler runs. Required
	 *  because optional meant "unbound" meant "the caller owns it": every method nobody had bound
	 *  authorized itself. This is where the old `CORE_API_RESOURCES` / `DYNAMIC_KIND_METHODS` /
	 *  `CORE_API_LEVELS` maps collapsed to. */
	authz: RouteAuthz;
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
// `principal` is NOT here. It used to be, documented as "caller-supplied principal recorded on the
// durable run for attribution" — a forgeable identity field of exactly the kind stamped-fields removed
// everywhere else, missed because the engine landed later and the column read as attribution only.
//
// It is not attribution any more. The SQL worker authorizes a resumed slice's tool calls AS the run's
// principal, so a body that could set it would be choosing the identity its durable work executes
// under — privilege escalation with an audit trail that agrees with the forgery. Stamped from the
// authenticated caller in the handler instead.
const engineRunMetadataInput = ark({
	"id?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Pins the durable run id (idempotency / correlation) instead of letting the engine mint one.",
		},
	}),
	"team?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Team/boundary tag carried on the durable run for attribution.",
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
	principalRef: accessGrantPrincipalRef.configure({
		euroclaw: {
			doc: "The grantee — `public`, or a tagged `<authority>:<id>` (`user:<id>` for a principal; `betterauth:<orgId>` / `workday:<deptId>` / … for a scope some source defines). The authority is OPAQUE; `user:`/`public` grants are LIVE, scope grants land as data but stay dormant until scopes resolve. An untagged ref is REJECTED here rather than stored as a grant that silently reaches nobody.",
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
	principalRef: accessGrantPrincipalRef.configure({
		euroclaw: {
			doc: "The grantee whose grants on (resourceKind, resourceId) are revoked — removes EVERY level that principalRef held on the resource. Same tagged `<authority>:<id>` | `public` shape the share side takes.",
		},
	}),
});
const registerOpenApiSpecInput = ark({
	document: jsonObject.configure({
		euroclaw: {
			doc: "The full OpenAPI spec as JSON; size-capped and parsed into governed per-tool records (rejected unless OpenAPI 3.x).",
		},
	}),
	scope: ark("string").configure({
		euroclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		euroclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
	// No `registeredBy`: the registrant is stamped from the authenticated caller `{ principal }` in the
	// handler (docs/plans/stamped-fields.md), never caller-supplied.
	source: ark("string").configure({
		euroclaw: {
			doc: "Address prefix grouping the spec's tools (`<source>.<tool>`); must be a dot-free slug, and later filters `listRegisteredTools` by source.",
		},
	}),
});
const listRegisteredToolsInput = ark({
	scope: ark("string").configure({
		euroclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		euroclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
	"source?": ark("string | undefined").configure({
		euroclaw: {
			doc: "Optional source filter — present narrows to that source, absent lists the whole boundary.",
		},
	}),
});
const listActionsInput = ark({
	scope: ark("string").configure({
		euroclaw: {
			doc: "Access-boundary KIND, opaque to core. With scopeId it names the boundary whose assembled action vocabulary is returned — the base register-spec action plus registered tools merged with the facts overlay, i.e. what the policy router compiles against.",
		},
	}),
	scopeId: ark("string").configure({
		euroclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
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
			doc: "Upsert key within the boundary — `putPolicySlice` upserts by (scope, scopeId, name), not create-only.",
		},
	}),
	scope: ark("string").configure({
		euroclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		euroclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
	// No `updatedBy`: the editor identity is stamped from the authenticated caller `{ principal }` in the
	// handler (docs/plans/stamped-fields.md), never caller-supplied.
});
const listPolicySlicesInput = ark({
	scope: ark("string").configure({
		euroclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		euroclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
});
const deletePolicySliceInput = ark({
	scope: ark("string").configure({
		euroclaw: {
			doc: "Access-boundary KIND, opaque to core. With scopeId it scopes the delete — keyed by (scope, scopeId, id), so a slice is only removable within its owning boundary.",
		},
	}),
	scopeId: ark("string").configure({
		euroclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
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

/** A core method's authz declaration, typed against THAT method's input: the resolver's parameter is
 *  the validated input, so reading a field the method does not have is a compile error. The same shape
 *  a plugin route builds with `route.…​.authz(…)`, expressed as data because the core table is STATIC —
 *  it exists without an assembled claw (the adapter and the client read it), and a resolver only ever
 *  reads its input, so nothing about it needs the instance. */
type ApiRouteAuthz<Input> =
	| {
			readonly mode: "resource";
			readonly level: RouteLevel;
			readonly resolve: (input: Input) => AuthzTarget | Promise<AuthzTarget>;
	  }
	| { readonly mode: "caller"; readonly reason: string };

function apiRoute<Method extends ClawApiMethod>(
	method: Method,
	authz: ApiRouteAuthz<ClawApiMethodInput<Method>>,
): ClawApiRouteDefinition<Method> {
	return {
		apiMethod: method,
		httpMethod: apiHttpMethod(method),
		path: apiMethodPath(method),
		inputSchema: clawApiInputSchemas[method],
		authz: authz as RouteAuthz,
	};
}

/**
 * Anchor on the row named by one input KEY. The resolver takes `Record<Key, string>`, so assigning it
 * to a method whose input has no such string field fails to compile — the same guarantee the old
 * `idKey ∈ keyof input` binding gave, now carried by an ordinary function parameter.
 */
const on = <const Key extends string>(
	level: RouteLevel,
	kind: string,
	idKey: Key,
): ApiRouteAuthz<Record<Key, string>> => ({
	mode: "resource",
	level,
	resolve: (input) => ({ kind, id: input[idKey] }),
});

/** Anchor on the opaque `(scope, scopeId)` boundary the input names — verified membership decides. */
const inScope = (level: RouteLevel): ApiRouteAuthz<ScopeRef> => ({
	mode: "resource",
	level,
	resolve: (input) => ({ scope: input.scope, scopeId: input.scopeId }),
});

/** Authorizes against NOTHING shared — a genuine create, or a row keyed to the caller. The reason is
 *  required and rides into the route metadata, so the set of these is enumerable rather than implied. */
const callerOnly = (reason: string): ApiRouteAuthz<unknown> => ({
	mode: "caller",
	reason,
});

// Reasons reused across several methods — written once so the gap they describe is stated once.
const CREATES =
	"mints a new row; its owner is stamped from the authenticated caller";
const APPROVAL_GAP =
	"KNOWN GAP: an approval row carries no claw, run, or scope to resolve, and needs-approval exists for autonomous runs with no user-owner — so there is nothing to anchor on until the record gains immutable organization/resource/requester/approver facts. Any authenticated human can currently reach any approval";

// The per-method route table. Each method's authz is CO-LOCATED at its own `apiRoute(...)` call and
// type-checked against that method's input, so a resolver reading a field the method does not have is a
// compile error. It is MANDATORY — the `satisfies` below makes a missing one fail to compile, which is
// what closes the original hole: an unbound method used to fall through to a resource whose owner WAS
// the caller, so the check asked "does the caller own this?" about something defined as caller-owned.
// The declaration also carries the required LEVEL, which used to live in a parallel `CORE_API_LEVELS`
// map — one method, one place, no second table to drift.
export const clawApiRoutes = {
	bindConversation: apiRoute(
		"bindConversation",
		callerOnly(
			"binds a stranger's conversation: there is no prior row, and the claw it creates is owned by system:anonymous",
		),
	),
	createClaw: apiRoute("createClaw", callerOnly(CREATES)),
	// claw — the base shared agent resource (its id keys the row directly).
	getClaw: apiRoute("getClaw", on("read", "claw", "id")),
	updateClaw: apiRoute("updateClaw", on("manage", "claw", "id")),
	archiveClaw: apiRoute("archiveClaw", on("manage", "claw", "id")),
	// thread — a method reaching a claw via one of its threads/messages anchors on that claw (its grants
	// inherit down); a method acting on the thread row itself anchors on the thread.
	createThread: apiRoute("createThread", on("use", "claw", "clawId")),
	getThread: apiRoute("getThread", on("read", "thread", "id")),
	listThreads: apiRoute("listThreads", on("read", "claw", "clawId")),
	archiveThread: apiRoute("archiveThread", on("manage", "thread", "id")),
	appendMessage: apiRoute("appendMessage", on("use", "claw", "clawId")),
	// Every transcript descendant carries a REQUIRED `clawId` referencing its claw, so each resolves to
	// that claw's owner/scope/grants. These were the unbound methods that let a caller read another
	// scope's transcript by guessing or learning an id.
	getMessage: apiRoute("getMessage", on("read", "message", "id")),
	listMessages: apiRoute("listMessages", on("read", "thread", "threadId")),
	sendMessage: apiRoute("sendMessage", on("use", "claw", "clawId")),
	// forgetSubject erases by bare `subjectId` with no container in its input and no anchor in the data
	// model, so over HTTP it was an unbounded delete of any subject's mappings. `deleteForSubject` is not
	// container-scoped at the port yet, so there is nothing honest to resolve — this states the gap
	// rather than dressing it as personal scope. Re-anchor it on `(scope, scopeId)` with the per-run PII
	// container work.
	forgetSubject: apiRoute(
		"forgetSubject",
		callerOnly(
			"KNOWN GAP: erasure takes only a subjectId — no container in the input and none at the store port — so there is no boundary to resolve and any caller can erase any subject's mappings",
		),
	),
	createToolCall: apiRoute("createToolCall", on("use", "claw", "clawId")),
	getToolCall: apiRoute("getToolCall", on("read", "toolCall", "id")),
	// Keyed by (runId, provider tool-call id): tool-call ids are unique only WITHIN a run, so the pair is
	// the natural key and the row it finds carries the claw to authorize against. Anchoring on the `run`
	// kind instead would have denied in every deployment without a durable engine, where these are plain
	// claws-store reads that work fine.
	getToolCallByProviderId: apiRoute("getToolCallByProviderId", {
		mode: "resource",
		level: "read",
		resolve: (input) => ({
			kind: "providerToolCall",
			id: `${input.runId}${PROVIDER_TOOL_CALL_SEPARATOR}${input.toolCallId}`,
		}),
	}),
	updateToolCallStatus: apiRoute(
		"updateToolCallStatus",
		on("use", "toolCall", "id"),
	),
	createToolResult: apiRoute("createToolResult", on("use", "claw", "clawId")),
	getToolResult: apiRoute("getToolResult", on("read", "toolResult", "id")),
	listToolResults: apiRoute("listToolResults", {
		mode: "resource",
		level: "read",
		resolve: (input) => ({
			kind: "providerToolCall",
			id: `${input.runId}${PROVIDER_TOOL_CALL_SEPARATOR}${input.toolCallId}`,
		}),
	}),
	createCheckpoint: apiRoute("createCheckpoint", on("use", "claw", "clawId")),
	getCheckpoint: apiRoute("getCheckpoint", on("read", "checkpoint", "id")),
	// Anchors on the run's latest checkpoint row, which carries the claw — again so this works without a
	// durable engine. No checkpoint yet ⇒ nothing resolves ⇒ deny, which is also "nothing to read".
	getLatestCheckpoint: apiRoute(
		"getLatestCheckpoint",
		on("read", "runCheckpoint", "runId"),
	),
	// An ad-hoc generate mints nothing durable to anchor on and runs as the caller.
	generate: apiRoute(
		"generate",
		callerOnly(
			"an ad-hoc generate mints no durable row and runs as the caller",
		),
	),
	// approval — the built-in gate is the user-principal floor (a human may decide, a machine may not,
	// see `userApprover`), which is NOT an ownership check. Closing this needs a schema change.
	grantApproval: apiRoute("grantApproval", callerOnly(APPROVAL_GAP)),
	denyApproval: apiRoute("denyApproval", callerOnly(APPROVAL_GAP)),
	getApproval: apiRoute("getApproval", callerOnly(APPROVAL_GAP)),
	listApprovals: apiRoute("listApprovals", callerOnly(APPROVAL_GAP)),
	// Resumes by approvalId, so it inherits exactly the gap above.
	continueRun: apiRoute("continueRun", callerOnly(APPROVAL_GAP)),
	getEffect: apiRoute(
		"getEffect",
		callerOnly(
			"KNOWN GAP: an effect row carries no claw or run reference, so there is nothing to resolve it against",
		),
	),
	// Scope-keyed administration. The input NAMES a `(scope, scopeId)` boundary; verified membership
	// AUTHORIZES it. These were the sharpest instance of the unbound hole: `putPolicySlice` took its
	// boundary key straight from the request body and got a caller-owned resource back, so any
	// authenticated caller could rewrite any scope's Cedar policy — an authorization bypass on the
	// authorization system itself.
	registerOpenApiSpec: apiRoute("registerOpenApiSpec", inScope("manage")),
	listRegisteredTools: apiRoute("listRegisteredTools", inScope("read")),
	listActions: apiRoute("listActions", inScope("read")),
	putPolicySlice: apiRoute("putPolicySlice", inScope("manage")),
	listPolicySlices: apiRoute("listPolicySlices", inScope("read")),
	deletePolicySlice: apiRoute("deletePolicySlice", inScope("manage")),
	// startRun mints the CALLER'S OWN run (no row to load yet); continueEngineRun resumes by approvalId
	// and inherits the approval gap. getRun/listRunEvents isolate by the durable run's own principal.
	startRun: apiRoute(
		"startRun",
		callerOnly("mints the caller's own run; there is no prior row to resolve"),
	),
	continueEngineRun: apiRoute("continueEngineRun", callerOnly(APPROVAL_GAP)),
	getRun: apiRoute("getRun", on("read", "run", "id")),
	listRunEvents: apiRoute("listRunEvents", on("read", "run", "runId")),
	// The generic share/unshare api — the target kind AND id both come from the INPUT, so any registered
	// kind is shareable with zero per-kind code. LEVEL manage: the caller must MANAGE the target before a
	// grant is written, i.e. you can only share what you manage. An unregistered kind fails closed.
	shareResource: apiRoute("shareResource", {
		mode: "resource",
		level: "manage",
		resolve: (input) => ({ kind: input.resourceKind, id: input.resourceId }),
	}),
	unshareResource: apiRoute("unshareResource", {
		mode: "resource",
		level: "manage",
		resolve: (input) => ({ kind: input.resourceKind, id: input.resourceId }),
	}),
} satisfies {
	readonly [Method in ClawApiMethod]: ClawApiRouteDefinition<Method>;
};

/**
 * Authz for the api methods that are NOT wire routes. `stream` is the only one: it returns a live
 * stream rather than an RPC envelope, so it is `Exclude`d from `ClawApiMethod` and therefore invisible
 * to the route table's `satisfies` — which is exactly how it ended up with no declaration at all, and
 * silently authorized itself through the old caller-owned fallback.
 *
 * The mapped type below is the fix: its keys are DERIVED as `keyof ClawApi` minus the routed methods,
 * so excluding another method from the wire surface makes this map fail to compile until it is
 * declared here too. A method can leave the route table; it cannot leave the authz model.
 */
export const NON_ROUTED_API_AUTHZ = {
	// The streaming twin of `generate` — ad-hoc, mints no durable row, runs as the caller.
	stream: callerOnly(
		"an ad-hoc stream mints no durable row and runs as the caller — the streaming twin of generate",
	),
} satisfies {
	readonly [Method in Exclude<keyof ClawApi, ClawApiMethod>]: ApiRouteAuthz<
		ClawApiMethodInput<Method & ClawApiMethod>
	>;
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

/**
 * The approver floor: only a real `user:` principal may DECIDE an approval, never a `system:` one. The PEP
 * already gated WHO may approve (the approval's owner ∪ a manage grant, via the `approval` resource); this
 * floors WHAT KIND — a machine may not approve the very action approval exists to put a human in front of
 * (a system principal that owned the approval would otherwise self-approve). Absent principal can't reach
 * here (the actor floor denied first); the check is belt-and-suspenders for the unsafeOpen path too.
 */
function userApprover(caller: ClawApiCaller | undefined): Principal {
	const principal = caller?.principal;
	if (principal === undefined || parsePrincipal(principal).kind !== "user") {
		throw authorizationError("only a user principal may decide an approval", {
			approver: principal ?? null,
		});
	}
	return principal;
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
		// `async` even though `runtime.stream` returns synchronously: one type describes both this raw
		// surface and the governed one the PEP wraps around it, and the wrapper is necessarily async
		// (authorizing evaluates policy and may load a resource). Declaring the honest shape in one
		// place and quietly returning another from the other is what let the two drift apart.
		stream: async ({ prompt, ctx, options }, caller?: ClawApiCaller) => {
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
			// caller AUTHORIZES this resume (the PEP decides the call) but does NOT choose the executing
			// identity: the approved action runs under the authority the IMMUTABLE approval record fixes
			// — the requester, or the approver under `approvalAuthority: "approver"` (the escalation
			// semantic; runtime.ts). The caller rides along so the option shape stays uniform with
			// generate/sendMessage; the resume path overrides it from the record.
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
			context.runtime.approvals?.grant(approvalId, userApprover(caller)) ??
			Promise.resolve(null),
		denyApproval: ({ approvalId, reason }, caller?: ClawApiCaller) =>
			context.runtime.approvals?.deny(
				approvalId,
				userApprover(caller),
				reason,
			) ?? Promise.resolve(null),
		getApproval: ({ id }) =>
			context.runtime.approvals?.get(id) ?? Promise.resolve(null),
		// A LISTING has no id for the gate to resolve, so the filtering happens here: every row is put
		// through the same `read` decision `getApproval` would make, and the ones that fail drop out.
		// Refusing the whole call instead would be wrong in both directions — it would deny a reviewer
		// with access to some approvals, and it would leak the existence of the rest by their absence
		// being a permission error rather than an empty list.
		//
		// One decision per row. Approval lists are short and a decision is in-memory Cedar over an
		// already-loaded record; if that stops being true, the answer is a store-level predicate, not a
		// cheaper check here.
		listApprovals: async (
			args?: { status?: ApprovalStatus; principal?: Principal },
			ctx?: AuthzContext,
		) => {
			// The PEP always supplies the context (the unsafeOpen hatch supplies a permissive one), so
			// absence means the raw handler was reached around the one door. Empty, not everything.
			if (!ctx) return [];
			const rows = (await context.runtime.approvals?.list(args)) ?? [];
			const visible = await Promise.all(
				rows.map(async (row) => {
					try {
						// Decided as `getApproval` — the single-row read. Asking as `listApprovals`
						// would inherit the caller-only permit that every listing has and pass for
						// everyone, which is the filter quietly doing nothing.
						await ctx.check(
							"read",
							{ kind: "approval", id: row.id },
							"getApproval",
						);
						return row;
					} catch {
						return undefined;
					}
				}),
			);
			return visible.filter((row) => row !== undefined);
		},

		getEffect: ({ id }) => requireEffects(context.effects).get(id),

		// `registeredBy` is stamped from the authenticated caller `{ principal }`, never caller input
		// (docs/plans/stamped-fields.md). The `(scope, scopeId)` pair IS caller-supplied, and safely so:
		// it only NAMES which boundary to act in, and the PEP authorizes it against verified membership
		// before the handler runs. Naming a boundary you do not belong to resolves nothing and denies.
		registerOpenApiSpec: (args, caller?: ClawApiCaller) =>
			createSpecRegistry(registry()).registerOpenApiSpec({
				...args,
				registeredBy: caller?.principal ?? SYSTEM_ANONYMOUS,
			}),
		listRegisteredTools: ({ scope, scopeId, source }) =>
			source !== undefined
				? registry().registeredTools.listBySource({ scope, scopeId }, source)
				: registry().registeredTools.listForScope({ scope, scopeId }),
		async listActions({ scope, scopeId }) {
			const stores = registry();
			const [registeredTools, overlay] = await Promise.all([
				stores.registeredTools.listForScope({ scope, scopeId }),
				stores.factsOverlay.listForScope({ scope, scopeId }),
			]);
			return assembleOrgActions({
				base: [REGISTER_OPENAPI_SPEC_ACTION],
				registeredTools,
				overlay,
			}).actions;
		},

		// `updatedBy` is stamped from the authenticated caller `{ principal }`, never caller input
		// (docs/plans/stamped-fields.md); the boundary is named by the request and authorized by
		// membership, as above.
		putPolicySlice: (args, caller?: ClawApiCaller) =>
			registry().policySlices.upsert({
				...args,
				updatedBy: caller?.principal ?? SYSTEM_ANONYMOUS,
			}),
		listPolicySlices: ({ scope, scopeId }) =>
			registry().policySlices.listForScope({ scope, scopeId }),
		deletePolicySlice: ({ scope, scopeId, id }) =>
			registry().policySlices.delete({ scope, scopeId }, id),

		// The durable run's principal is STAMPED from the authenticated caller — never read from the
		// body — because the worker executes the run's tool calls under it. An unauthenticated start
		// records SYSTEM_ANONYMOUS, which the floor refuses at the first tool: work nobody can be shown
		// to have asked for does not get to act.
		startRun: (args, caller?: ClawApiCaller) => {
			assertNoReservedContext(args.ctx);
			return requireEngine(context.engine).startRun({
				...args,
				run: {
					...args.run,
					principal: caller?.principal ?? SYSTEM_ANONYMOUS,
				},
			});
		},
		continueEngineRun: (args, caller?: ClawApiCaller) => {
			assertNoReservedContext(args.ctx);
			return requireEngine(context.engine).continueRun({
				...args,
				run: {
					...args.run,
					principal: caller?.principal ?? SYSTEM_ANONYMOUS,
				},
			});
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
