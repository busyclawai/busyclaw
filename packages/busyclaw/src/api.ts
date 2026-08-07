import type {
	AccessGrantPermission,
	AccessGrantRecord,
	AccessGrantStore,
	AppendMessageInput,
	ApprovalRecord,
	ApprovalStatus,
	AuthzContext,
	AuthzTarget,
	BindConversationInput,
	BindConversationResult,
	BusyclawPlugin,
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
	EngineControlRunResult,
	EngineDeliverMessageResult,
	EngineNotDrivenReason,
	EngineProceed,
	EngineRunEvent,
	EngineRunHandle,
	EngineRunRecord,
	EngineStartRunInput,
	EngineStartRunResult,
	EngineWorkResult,
	JsonObject,
	MessageRecord,
	MessageVisibility,
	PolicySliceRecord,
	Principal,
	RegisteredToolRecord,
	RouteAuthz,
	RouteLevel,
	RunControlIntent,
	RunMessageMode,
	RunStreamPage,
	RunStreamPort,
	ScopeRef,
	SecondaryStorage,
	SecretDeclaration,
	Secrets,
	ThreadRecord,
	ToolCallRecord,
	ToolCallStatusPatch,
	ToolResultRecord,
	UpdateClawInput,
} from "@busyclaw/contracts";
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
	errorMessage,
	isTerminalRunStatus,
	isTerminalRunStreamLifecycle,
	jsonObject,
	parsePrincipal,
	RESERVED_CONTEXT_PREFIX,
	runStreamKey,
	SYSTEM_ANONYMOUS,
	stateError,
	threadStreamKey,
	toKebabCase,
	toolCallEntity,
	unsupportedOperationError,
	validationError,
} from "@busyclaw/contracts";
import {
	createDeltaChannel,
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
	RuntimeResult as RuntimeResultSchema,
	type RuntimeStream,
	recordingFromRuntimeApprovalMetadata,
	runtimeRunOptionsWithCaller,
	runtimeRunOptionsWithRecording,
	type SpecRegistrationReport,
} from "@busyclaw/runtime";
import { pollingWatch } from "@busyclaw/storage-core";
import type { RegistryStores } from "@busyclaw/storage-durable";
import { type as ark } from "arktype";
import type { ClawRecordOf, CreateClawInputOf } from "./models";
import type { ClawRedactionHandle } from "./redaction";
import { type ActionView, assembleOrgActions } from "./registry";

/** How a read presents stored message content: `"redacted"` (default) returns it as persisted —
 *  tokens; `"original"` re-identifies for an authorized viewer (read-side only, audited). */
export type MessageView = "redacted" | "original";

/**
 * What a prune removed, per table.
 *
 * Per table because the numbers answer different questions: `runs` is how many finished turns were
 * swept — what a host schedules against — while the rest is how much exhaust each of them left. One
 * total would hide a claw whose runs are cheap and whose events are not.
 */
export type ClawPruneResult = {
	runs: number;
	events: number;
	tasks: number;
	messages: number;
	checkpoints: number;
};

/** What `claw.api.getRun` answers with: the governance record minus its `input`. */
export type ClawRunView = Omit<EngineRunRecord, "input">;

/**
 * The keys of a `run_event` payload a control plane may read, and nothing else.
 *
 * An allowlist rather than a denylist, because the failure this prevents is a payload gaining a
 * content-bearing key that nobody remembers to exclude — `run.completed` already carries the whole
 * terminal result, which is the assistant's answer, into a column no `view` gate and no audit line
 * covers (P2). A new operational key has to be added here to be visible, which is the direction that
 * fails safe.
 */
const OPERATIONAL_EVENT_KEYS = [
	"taskId",
	"checkpointId",
	"steps",
	"intent",
	"requestedBy",
	"reason",
	"attempt",
	"status",
	"workerId",
	"approvalIds",
] as const;

function operationalPayload(payload: JsonObject): JsonObject {
	const out: JsonObject = {};
	for (const key of OPERATIONAL_EVENT_KEYS) {
		const value = payload[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** The out-of-band caller context every governed `claw.api` method takes as its 2nd argument. Defined
 *  in `@busyclaw/contracts` (the shared protocol home, beside `Principal`) so busyclaw's api surface and
 *  the HTTP adapter's `resolveCaller` seam name ONE caller type; re-exported here for `from "busyclaw"`
 *  consumers and the `WithCaller` transform. */
export type { ClawApiCaller };

export type ClawSendInput<Config extends RuntimeConfig = RuntimeConfig> = {
	clawId: string;
	threadId: string;
	message: string;
	ctx?: RunContext<Config>;
	// No `runId` (D1). It named the run's redaction container and its authz anchor, so a caller who
	// could pin it could pin somebody else's. The server mints it; read it back off the result.
	view?: MessageView;
} /** `model` names the pool entry that answers this message — REQUIRED when the pool has ≥2 entries
 *  and no default, optional when a default exists, and absent for a single-`model` claw. */ & ModelSelection<Config>;

/**
 * What `sendMessage` hands back — a UNION, because once a turn is a durable run there are outcomes
 * that are neither a result nor an error.
 *
 * `runId` is on both arms: it is the handle for `getRun`, for `controlRun` from a second tab, and for
 * watching the turn from anywhere else. A caller cannot supply it (D1) precisely so that the server
 * can mint it, so handing it back is the only way anyone learns it.
 *
 * The `accepted` arm means **the words landed and somebody else is finishing them**: a concurrent
 * replica took the task, or this driver lost its lease mid-slice and cannot honestly say how the run
 * ended. Both are 200, not errors — the user's message is in the transcript and the reply will appear
 * in the thread. Reporting a failure there would be a lie about durable state, and reporting a result
 * would be a guess.
 */
export type ClawSendResult =
	| {
			driven: true;
			runId: string;
			result: RuntimeResult;
			userMessage: MessageRecord;
	  }
	| {
			driven: false;
			runId: string;
			userMessage: MessageRecord;
			/**
			 * WHY this invocation has no answer, passed through from the engine unchanged. Worth
			 * surfacing rather than flattening: "somebody else is still working on it" and "that run
			 * was already stopped" are different things to show a person, and only the engine knows
			 * which happened.
			 */
			reason: EngineNotDrivenReason;
	  };

/**
 * What `sendMessageAndStream` hands back: a `RuntimeStream` — so it drops straight into the AI SDK
 * response bridges, which accept any `{ textStream }` — plus the user message persisted before the
 * run started, because a chat UI has to render that beside the reply it is streaming.
 */
export type ClawStreamResult = Omit<RuntimeStream, "result"> & {
	userMessage: MessageRecord;
	/**
	 * The run these deltas belong to. Without it a caller who streams her own turn has no way to tell
	 * anyone else what to watch, so multiplayer streaming would be unreachable from the streaming
	 * method — and a client whose connection drops has nothing to reconnect against.
	 */
	runId: string;
	/**
	 * Resolves to the same union `sendMessage` returns, for the same reason: a driver that lost its
	 * claim has no result to give. On that arm `textStream` closes EMPTY — no deltas, because this
	 * invocation produced none, not because the answer was empty.
	 */
	result: Promise<ClawSendResult>;
};

export const clawCronHandlerSecretConfig = ark({
	"headerName?": ark("string | undefined").configure({
		busyclaw: {
			doc: "The request header the cron trigger presents the shared secret in; defaults to `x-busyclaw-cron-secret` when omitted.",
		},
	}),
	"limit?": ark("number | undefined").configure({
		busyclaw: {
			doc: "Caps how many due claws are processed per cron tick; unset processes every due claw.",
		},
	}),
	secret: ark("string").configure({
		busyclaw: {
			doc: "The shared secret the incoming `/cron` request must present (in `headerName`) — this is the authenticated cron variant; a mismatch is rejected 401.",
		},
	}),
});
export type ClawCronHandlerSecretConfig =
	typeof clawCronHandlerSecretConfig.infer;

export const clawCronHandlerUnsafeConfig = ark({
	"headerName?": ark("string | undefined").configure({
		busyclaw: {
			doc: "Inert in the unauthenticated variant — no secret is compared, so this header is never read.",
		},
	}),
	"limit?": ark("number | undefined").configure({
		busyclaw: {
			doc: "Caps due claws processed per cron tick, the same throttle as the authenticated variant.",
		},
	}),
	unsafeAllowUnauthenticated: ark("true").configure({
		busyclaw: {
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
	readonly plugins?: readonly BusyclawPlugin[];
	readonly registry?: RegistryStores;
	/** The one-door reader (the full provider chain) — exposed so hosts and plugin api namespaces
	 *  resolve credentials the same way the runtime does. */
	readonly secrets?: Secrets;
	/** The fast expiring KV, when the host configured one. A BUFFER — see `ClawConfig`. */
	readonly secondaryStorage?: SecondaryStorage;
	/** Where live deltas go, when live watching is configured at all. Absent ⇒ `watchThread` refuses
	 *  rather than returning an empty stream that reads like a quiet conversation. */
	readonly runStream?: RunStreamPort;
	/** The host's post-response execution grant, if it has one — see `ClawConfig.waitUntil`. The
	 *  streaming door hands its drive promise here so a serverless isolate is not torn down while the
	 *  answer is still being written. */
	readonly waitUntil?: (work: Promise<unknown>) => void;
	/** The collected required-secret-name declarations across plugins (feeds boot coverage). */
	readonly secretDeclarations?: readonly SecretDeclaration[];
	/** The governed redaction read-path (original view + erasure) — present when a `redaction`
	 *  group is configured. */
	readonly redaction?: ClawRedactionHandle;
};

/** The lineage a direct write carries beside its row — see `appendMessage`. */
export type WithSubjectLineage = { subjectIds?: readonly string[] };

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
	/**
	 * Delete the operational exhaust of this claw's FINISHED runs — retention, on the host's schedule.
	 *
	 * Not a job this library runs. A retention window is host policy — 30 days is wrong for a
	 * regulated tenant and seven years is wrong for a chat toy — so the window is an argument, and the
	 * host's own cron decides how often to call this. Bounded per call: loop until `runs` is 0.
	 *
	 * WHAT GOES: run events, scheduling tasks, inbox rows, checkpoints. WHAT STAYS: the run rows
	 * themselves (`message.runId` points at them), the transcript, approvals, effects and the audit.
	 * So this frees space without changing what any product api can answer, except `listRunEvents`,
	 * whose whole subject is the history being pruned.
	 */
	pruneRuns: (input: {
		clawId: string;
		before: string;
		limit?: number;
	}) => Promise<ClawPruneResult>;

	createThread: (input: CreateThreadInput) => Promise<ThreadRecord>;
	getThread: (input: { id: string }) => Promise<ThreadRecord | null>;
	listThreads: (input: { clawId: string }) => Promise<ThreadRecord[]>;
	archiveThread: (input: { id: string }) => Promise<ThreadRecord | null>;

	/** `subjectIds` is LINEAGE, not a column (R-M03): it tells the PII mappings minted while tokenizing
	 *  this content whose data it is, so a later `forgetSubject` can reach them. Host-supplied, because
	 *  busyclaw cannot infer it and neither the caller's identity nor the model's claim is trustworthy
	 *  for it. Omitted ⇒ the mappings are linked to nobody and erasure cannot find them. */
	appendMessage: (
		input: AppendMessageInput & WithSubjectLineage,
	) => Promise<MessageRecord>;
	getMessage: (input: { id: string }) => Promise<MessageRecord | null>;
	listMessages: (input: {
		threadId: string;
		afterSequence?: number;
		limit?: number;
		/** Narrow to one TURN — what did this run say. A filter, not a cursor. */
		runId?: string;
		/** Omit for the whole transcript; `["user"]` for what a chat UI should render. Run notices are
		 *  written `internal`, so this is how a client stops seeing them. */
		visibility?: readonly MessageVisibility[];
		view?: MessageView;
	}) => Promise<MessageRecord[]>;
	sendMessage: (input: ClawSendInput<Config>) => Promise<ClawSendResult>;
	/**
	 * `sendMessage`, with the reply streamed as it is written — same input, same transcript, same
	 * persistence. In-process only (a live stream has no RPC envelope); needs a streaming vendor.
	 *
	 * Named for both halves because it does both, and the sending is the part that outlives the
	 * reader. Contrast `stream`, which is ad-hoc: no claw, no thread, nothing persisted, so a reader
	 * who walks away takes the only copy of the answer with them and the run is aborted. Here the run
	 * is recorded, so a closed tab costs nothing — it detaches, finishes, and the reply is waiting in
	 * the thread. Reading the stream is how you WATCH the answer; it is not how the answer survives.
	 *
	 * A PROMISE of the stream, for the same reason `stream` is: the PEP wraps every method here and
	 * authorizing is asynchronous, so a denial hands back nothing rather than a live-looking object.
	 */
	sendMessageAndStream: (
		input: ClawSendInput<Config>,
	) => Promise<ClawStreamResult>;

	/**
	 * WATCH A CONVERSATION happen — every run in it, whoever is driving, as it arrives.
	 *
	 * Keyed by THREAD rather than run, because a watcher does not know run ids: they are looking at a
	 * conversation, and the run they want was created a moment ago by somebody else. "A run started"
	 * is simply a chunk in the log they are already reading, so discovery costs no second mechanism.
	 *
	 * `since` is an opaque cursor — the one this returns, which an SSE bridge puts in `id:` and gets
	 * back as `Last-Event-ID`. It belongs to the core rather than to a transport, which is what lets a
	 * client start on one transport, lose it, and resume on another without losing its place.
	 *
	 * IN-PROCESS, like the other streaming methods, and authorized exactly like `listMessages`:
	 * `read` on the thread. If you can read the conversation, you can watch it happen.
	 *
	 * A page whose `stale` is set means the cursor points past the end of the log — the buffer's
	 * window expired while the client was away. Reload the transcript; do NOT keep reading, because
	 * the offsets no longer mean what the cursor thinks they do.
	 */
	watchThread: (input: {
		threadId: string;
		since?: string;
	}) => Promise<AsyncIterable<RunStreamPage>>;

	/**
	 * Watch ONE run — the case `watchThread` cannot serve, and the narrower view when it could.
	 *
	 * A run with no thread has no conversation to subscribe to: cron work, a subagent. Nobody is
	 * looking at a chat window, so the run is its own subscription and this is the only way to see it
	 * happen. An ops view watching a scheduled job is the shape.
	 *
	 * For a run that DOES have a thread it reads that thread's log and returns only this run's
	 * chunks. Not a privilege boundary — a conversational run and its thread both climb to the same
	 * claw, so anyone who can watch one can watch the other — but it is what the method's name
	 * promises, and a caller asking for one turn should not have to filter a whole conversation.
	 *
	 * Authorized `read` on the RUN, whose loader climbs to the claw exactly as `getRun`'s does.
	 */
	watchRun: (input: {
		runId: string;
		since?: string;
	}) => Promise<AsyncIterable<RunStreamPage>>;

	/** Crypto-shred every PII mapping this data-subject appears on — audited ("pii.erasure").
	 *  Fails loud when the deployment cannot honor erasure (posture "raw", custom redactor, or
	 *  no redaction configured): a no-op "success" would be false comfort. */
	forgetSubject: (input: {
		subjectId: string;
		containerKind: string;
		containerId: string;
	}) => Promise<{ erased: number }>;

	createToolCall: (
		input: CreateToolCallInput & WithSubjectLineage,
	) => Promise<ToolCallRecord>;
	getToolCall: (input: { id: string }) => Promise<ToolCallRecord | null>;
	getToolCallByProviderId: (input: {
		runId: string;
		toolCallId: string;
	}) => Promise<ToolCallRecord | null>;
	updateToolCallStatus: (input: {
		id: string;
		patch: ToolCallStatusPatch;
	}) => Promise<ToolCallRecord | null>;

	createToolResult: (
		input: CreateToolResultInput & WithSubjectLineage,
	) => Promise<ToolResultRecord>;
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
	// router rebuilds on the next decision. busyclaw stays engine-agnostic — it stores the slices; the
	// host composes createOrgPolicyRouter with a cedar engineFor (see the policy-slice E2E).
	// `updatedBy` is SERVER-STAMPED from `{ principal }` (docs/plans/stamped-fields.md); the boundary is
	// named by the request and authorized by membership, as above.
	putPolicySlice: (input: {
		scope: string;
		scopeId: string;
		name: string;
		cedar: string;
		mode: "enforce" | "shadow" | "off";
		plane: "tool" | "api" | "both";
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
	/** Advance a parked run. `manage` on the RUN, because this is the verb that makes it act again —
	 *  `use` is for verbs that reduce or inform. The caller names both the run and the record; the
	 *  handler refuses if the record does not belong to that run. */
	proceedRun: (input: {
		runId: string;
		proceed: EngineProceed;
		ctx?: JsonObject;
	}) => Promise<EngineRunHandle>;
	/** Put a message in a run's inbox. `use`, not `manage`: this INFORMS a run, it does not make it
	 *  act — the run decides what to do with it at its next control point. */
	deliverMessage: (input: {
		toRunId: string;
		body: JsonObject;
		mode: RunMessageMode;
		idempotencyKey: string;
	}) => Promise<EngineDeliverMessageResult>;
	/** Ask a run in flight to stop. `use`, not `manage`: this strictly REDUCES what the run may do,
	 *  and the requester is stamped from the caller — never read from the body. */
	controlRun: (input: {
		runId: string;
		intent: RunControlIntent;
		reason?: string;
	}) => Promise<EngineControlRunResult>;
	/** The run WITHOUT its input — see the handler. Status, scope, wait reason and timestamps; never
	 *  content, which `listMessages` serves under a `view` gate and an audit line. */
	getRun: (input: { id: string }) => Promise<ClawRunView | null>;
	/**
	 * The unfinished runs on one conversation, newest first.
	 *
	 * "Is somebody already answering this?" — the question a router has to ask before starting a
	 * second turn beside a live one, and the question a UI asks to show "still working". Several is a
	 * legitimate answer: two people sending into one thread is two runs (G8), which is why every
	 * stream chunk carries a `runId`.
	 */
	listActiveRuns: (input: { threadId: string }) => Promise<ClawRunView[]>;
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

/** The FLAT, ROUTABLE api methods — the ones the method→route machinery maps. The two streaming
 *  methods are excluded: a live `{ textStream, result }` isn't serializable into an RPC envelope, so
 *  they are in-process methods with no HTTP route (a wire version needs SSE, a separate transport —
 *  `@busyclaw/vendors` bridges either of them into one). Leaving the route table does NOT excuse them
 *  from authorization: {@link NON_ROUTED_API_AUTHZ} derives its keys from this very exclusion, so
 *  adding a name here fails the build until that name is declared there. */
export type ClawApiMethod = Exclude<
	keyof ClawApi,
	"stream" | "sendMessageAndStream" | "watchThread" | "watchRun"
>;
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
		busyclaw: {
			doc: "The provider-assigned tool-call id (not the internal record id); tool-call ids are unique only within a run, so `runId` scopes the lookup.",
		},
	}),
});
const jsonObjectOrUndefined = jsonObject.or("undefined").configure({
	busyclaw: {
		doc: "Opaque JSON run context threaded to the run; any key using the reserved context prefix is rejected — those are host-injected, not caller-supplied.",
	},
});
const runtimeAbortSignalInput = ark({
	aborted: ark("boolean").configure({
		busyclaw: {
			doc: "The serialized `AbortSignal`, reduced to its `aborted` boolean to cross the api boundary.",
		},
	}),
});
const runtimeRunOptionsInput = ark({
	"abortSignal?": runtimeAbortSignalInput.or("undefined").configure({
		busyclaw: {
			doc: "A run option accepted over the wire; the schema drops `runMode`/recording, which are set server-side.",
		},
	}),
	"model?": ark("string | undefined").configure({
		busyclaw: {
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
		busyclaw: {
			doc: "Pins the durable run id (idempotency / correlation) instead of letting the engine mint one.",
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
} from "@busyclaw/contracts";
// The bindConversation protocol (schemas + types) lives in @busyclaw/contracts next to the entities
// it derives from — channel plugins validate against it without depending on this assembly package.
// Re-exported here because it is part of the product api surface.
export {
	bindConversationClawInput,
	bindConversationInput,
	bindConversationResult,
	bindConversationThreadInput,
} from "@busyclaw/contracts";

const listMessagesInput = ark({
	"afterSequence?": ark("number | undefined").configure({
		busyclaw: {
			doc: "Keyset cursor — returns only messages whose `sequence` is greater than this, not an offset.",
		},
	}),
	"limit?": "number | undefined",
	"runId?": ark("string | undefined").configure({
		busyclaw: {
			doc: "Narrow to ONE TURN's messages. A thread outlives every run on it, so asking what a given run answered without this reads the whole transcript to reach the last two rows.",
		},
	}),
	threadId: ark("string").configure({
		busyclaw: {
			doc: "The thread to list; also resolves the claw scope when `view: 'original'` re-identifies the returned rows.",
		},
	}),
	"visibility?": ark(
		"('user' | 'internal' | 'audit-only')[] | undefined",
	).configure({
		busyclaw: {
			doc: "Which visibilities to return; omit for the whole transcript. A chat UI wants `['user']` — run notices (parked, waiting on approval, denied) are written `internal`, and filtering here rather than after the call is what keeps `limit` paging honest.",
		},
	}),
	"view?": ark("'redacted' | 'original' | undefined").configure({
		busyclaw: {
			doc: "`'original'` re-identifies ONLY the returned copies (rows at rest stay tokenized) and is audited as `pii.reidentification`; defaults to `'redacted'` and is a silent no-op when no redaction is configured.",
		},
	}),
});
const pruneRunsInput = ark({
	clawId: ark("string").configure({
		busyclaw: {
			doc: "The claw whose finished runs are swept. REQUIRED — a deployment-wide prune is not something a request gets to ask for, the same rule forgetSubject follows (R-H01).",
		},
	}),
	before: ark("string").configure({
		busyclaw: {
			doc: "ISO timestamp. Runs that reached a terminal status strictly before this are swept; the window is the caller's policy, not a default this library picks.",
		},
	}),
	"limit?": ark("number | undefined").configure({
		busyclaw: {
			doc: "How many finished runs to sweep in this call (default 500). Loop until `runs` comes back 0.",
		},
	}),
}).onUndeclaredKey("reject");
const listActiveRunsInput = ark({
	threadId: ark("string").configure({
		busyclaw: {
			doc: "The conversation to ask about. Answers with every run on it that has not finished, newest first — several is legitimate, not an error.",
		},
	}),
}).onUndeclaredKey("reject");
const sendMessageInput = ark({
	clawId: ark("string").configure({
		busyclaw: {
			doc: "The claw whose transcript the user message is appended to; also the redaction scope id used to tokenize the persisted message.",
		},
	}),
	"ctx?": jsonObjectOrUndefined,
	message: ark("string").configure({
		busyclaw: {
			doc: "Persisted tokenized as a `role: 'user'` message before the run, then passed verbatim to the runtime as the prompt.",
		},
	}),
	// `runId` REMOVED (D1). A chat turn is a durable run now, so a caller-chosen id is a
	// caller-chosen REDACTION CONTAINER and a caller-chosen AUTHZ ANCHOR — pin a stranger's run id
	// and your write attaches to their container. The server mints it and hands it back on
	// `ClawSendResult.runId`, which is the only place anyone learns it.
	threadId: ark("string").configure({
		busyclaw: {
			doc: "The thread the message belongs to; recorded on the run recording metadata.",
		},
	}),
	"view?": ark("'redacted' | 'original' | undefined").configure({
		busyclaw: {
			doc: "Like `listMessages`, `'original'` re-identifies only the returned result object and is audited; a no-op without redaction.",
		},
	}),
	"model?": ark("string | undefined").configure({
		busyclaw: {
			doc: "Which model from the `models` pool answers this message (by name); omit → the pool default. TYPE-narrowed to the config's pool keys for in-process callers.",
		},
	}),
});
const forgetSubjectInput = ark({
	subjectId: ark("string").configure({
		busyclaw: {
			doc: "The data-subject key crypto-shredded across this container's PII mappings; fails loud (not a silent success) when the deployment cannot honor erasure, and is audited as `pii.erasure`.",
		},
	}),
	containerKind: ark("string").configure({
		busyclaw: {
			doc: "The PII CONTAINER KIND to erase within ('claw', 'run', or a plugin's) — an entity kind, never a tenancy scope. Resolved as a resource of that kind and authorized at `manage`, so naming a container you have no claim on denies.",
		},
	}),
	containerId: ark("string").configure({
		busyclaw: {
			doc: "The container's id — with `containerKind` it names exactly which mappings are in range. Erasure across EVERY container is a trusted in-process call on the redaction handle, never a request.",
		},
	}),
});
const generateInput = ark({
	"ctx?": jsonObjectOrUndefined,
	"options?": runtimeRunOptionsOrUndefined,
	prompt: ark("string").configure({
		busyclaw: {
			doc: "Passed straight to the runtime as the prompt; unlike `sendMessage` this does NOT persist a transcript message.",
		},
	}),
});
const continueRunInput = ark({
	approvalId: ark("string").configure({
		busyclaw: {
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
		busyclaw: {
			doc: "Optional principal filter; the wire type is a plain string here even though the api models it as `Principal`.",
		},
	}),
	"status?": approvalStatus.or("undefined"),
});
// THE FIRST DOOR IN THE REPO THAT REJECTS UNDECLARED KEYS, and the reason is specific to this one.
// Everywhere else an unknown field is forwarded into a handler that ignores it. Here the handler
// forwards its input to `ClawEngineHandle.startRun`, whose type grows as the engine grows — so a
// field added to `EngineStartRunInput` becomes wire-reachable the moment it exists unless something
// says otherwise. `recording` is exactly that field: it names the run's authz parent, its redaction
// containerKind, and the thread its answers are appended to.
const startRunInput = ark({
	"ctx?": jsonObjectOrUndefined,
	prompt: ark("string").configure({
		busyclaw: {
			doc: "The prompt for the durable engine run — distinct from the runtime `run` path.",
		},
	}),
	"run?": engineRunMetadataOrUndefined,
}).onUndeclaredKey("reject");
const continueEngineRunInput = ark({
	approvalId: ark("string").configure({
		busyclaw: {
			doc: "The approval whose grant resumes the durable engine run.",
		},
	}),
	"ctx?": jsonObjectOrUndefined,
	"run?": engineRunMetadataOrUndefined,
});
const proceedRunInput = ark({
	runId: ark("string").configure({
		busyclaw: {
			doc: "The run to advance. Authorized against THIS id, then verified against the named record's own runId — a disagreement is refused, never resolved in either direction.",
		},
	}),
	proceed: ark({
		kind: "'approval'",
		approvalId: "string",
	})
		.or({ kind: "'checkpoint'", checkpointId: "string" })
		.configure({
			busyclaw: {
				doc: "WHAT advances the run: a granted approval, or the checkpoint a suspended run parked on. Each names a durable record that knows its own runId.",
			},
		}),
	"ctx?": jsonObjectOrUndefined,
});
const deliverMessageInput = ark({
	toRunId: ark("string").configure({
		busyclaw: {
			doc: "The run to deliver into. Addressed by RUN, never by thread — which run owns a conversation is the router's question, and two consumers answer it differently.",
		},
	}),
	body: jsonObject.configure({
		busyclaw: {
			doc: "The message. Tokenized at admit into the RECEIVING run's containerKind; the drain never re-redacts.",
		},
	}),
	mode: ark("'at_turn_end' | 'next_step' | 'interrupt'").configure({
		busyclaw: {
			doc: "WHEN it enters the run's context: `next_step` at the run's next control point; `at_turn_end` never in this run (wake fuel for the next one); `interrupt` cancels the current model call.",
		},
	}),
	idempotencyKey: ark("string").configure({
		busyclaw: {
			doc: "Makes admission exactly-once. The row id is derived from it, so a redelivery loses the insert rather than appearing twice in a context window.",
		},
	}),
});
const controlRunInput = ark({
	runId: ark("string").configure({
		busyclaw: { doc: "The durable engine run to control." },
	}),
	intent: ark("'suspend' | 'stop' | 'abort'").configure({
		busyclaw: {
			doc: "What to ask of the run, as a monotone ladder (`suspend` < `stop` < `abort`). The latch may only ever be RAISED. Only `suspend` is honoured today.",
		},
	}),
	"reason?": ark("string | undefined").configure({
		busyclaw: {
			doc: "An operator's explanation, read back by a human. There is deliberately no `requestedBy` — the requester is stamped from the authenticated caller.",
		},
	}),
});
const shareResourceInput = ark({
	resourceKind: ark("string").configure({
		busyclaw: {
			doc: "The OPAQUE kind label of the resource being shared (`claw`/`thread`/`skill`/…); the PEP loads it via the loader registry and requires the caller MANAGE it before the grant is written.",
		},
	}),
	resourceId: "string",
	principalRef: accessGrantPrincipalRef.configure({
		busyclaw: {
			doc: "The grantee — `public`, or a tagged `<authority>:<id>` (`user:<id>` for a principal; `betterauth:<orgId>` / `workday:<deptId>` / … for a scope some source defines). The authority is OPAQUE; `user:`/`public` grants are LIVE, scope grants land as data but stay dormant until scopes resolve. An untagged ref is REJECTED here rather than stored as a grant that silently reaches nobody.",
		},
	}),
	permission: accessGrantPermission.configure({
		busyclaw: {
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
		busyclaw: {
			doc: "The grantee whose grants on (resourceKind, resourceId) are revoked — removes EVERY level that principalRef held on the resource. Same tagged `<authority>:<id>` | `public` shape the share side takes.",
		},
	}),
});
const registerOpenApiSpecInput = ark({
	document: jsonObject.configure({
		busyclaw: {
			doc: "The full OpenAPI spec as JSON; size-capped and parsed into governed per-tool records (rejected unless OpenAPI 3.x).",
		},
	}),
	scope: ark("string").configure({
		busyclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		busyclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
	// No `registeredBy`: the registrant is stamped from the authenticated caller `{ principal }` in the
	// handler (docs/plans/stamped-fields.md), never caller-supplied.
	source: ark("string").configure({
		busyclaw: {
			doc: "Address prefix grouping the spec's tools (`<source>.<tool>`); must be a dot-free slug, and later filters `listRegisteredTools` by source.",
		},
	}),
});
const listRegisteredToolsInput = ark({
	scope: ark("string").configure({
		busyclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		busyclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
	"source?": ark("string | undefined").configure({
		busyclaw: {
			doc: "Optional source filter — present narrows to that source, absent lists the whole boundary.",
		},
	}),
});
const listActionsInput = ark({
	scope: ark("string").configure({
		busyclaw: {
			doc: "Access-boundary KIND, opaque to core. With scopeId it names the boundary whose assembled action vocabulary is returned — the base register-spec action plus registered tools merged with the facts overlay, i.e. what the policy router compiles against.",
		},
	}),
	scopeId: ark("string").configure({
		busyclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
});
const putPolicySliceInput = ark({
	cedar: ark("string").configure({
		busyclaw: {
			doc: "Raw Cedar policy text, stored verbatim — busyclaw stays engine-agnostic; the host composes the Cedar engine.",
		},
	}),
	mode: ark("'enforce' | 'shadow' | 'off'").configure({
		busyclaw: {
			doc: "`enforce` blocks, `shadow` evaluates without blocking, `off` disables — the slice's effect over the code-owned system posture.",
		},
	}),
	plane: ark("'tool' | 'api' | 'both'").configure({
		busyclaw: {
			doc: "Which policy plane this slice governs: `tool` the agent's tool floor, `api` the product api, `both` written out deliberately. A slice naming no resource type matches everything in whichever engine it is compiled into, so the plane is stated rather than inferred.",
		},
	}),
	name: ark("string").configure({
		busyclaw: {
			doc: "Upsert key within the boundary — `putPolicySlice` upserts by (scope, scopeId, name), not create-only.",
		},
	}),
	scope: ark("string").configure({
		busyclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		busyclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
	// No `updatedBy`: the editor identity is stamped from the authenticated caller `{ principal }` in the
	// handler (docs/plans/stamped-fields.md), never caller-supplied.
});
const listPolicySlicesInput = ark({
	scope: ark("string").configure({
		busyclaw: {
			doc: "Access-boundary KIND, opaque to core ('organization'/'team' mean something to plugins, not here). With scopeId it names the boundary this call acts in — a lookup key the PEP authorizes against verified membership, never authority in itself.",
		},
	}),
	scopeId: ark("string").configure({
		busyclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
});
const deletePolicySliceInput = ark({
	scope: ark("string").configure({
		busyclaw: {
			doc: "Access-boundary KIND, opaque to core. With scopeId it scopes the delete — keyed by (scope, scopeId, id), so a slice is only removable within its owning boundary.",
		},
	}),
	scopeId: ark("string").configure({
		busyclaw: {
			doc: "The access boundary's id. Naming a boundary the caller does not belong to resolves no membership and denies.",
		},
	}),
	id: "string",
});
/**
 * R-M03. WHOSE personal data this write is about — the erasure key every mapping minted while
 * tokenizing it is linked to, so a later `forgetSubject` can find them.
 *
 * On the BOUNDARY, not the entity: it is lineage, not a column. The message row does not record who
 * the message was about; the PII mappings do, and this is what tells them.
 *
 * The host supplies it because only the host knows. busyclaw cannot infer whose data a value is from
 * the value, and the two parties who could claim to know are exactly the two that must not: a caller
 * can misname a subject, and the model can invent one. A support agent writing about a customer is
 * the case that decides it — deriving lineage from the authenticated principal would link the row to
 * the AGENT, and the customer's erasure request would find nothing.
 *
 * Optional, because a deployment that owes nobody erasure should not be made to invent an id — but a
 * write without one mints mappings that erasure cannot reach, which is what the boot warning says.
 */
const subjectLineageInput = {
	"subjectIds?": ark("string[] | undefined").configure({
		busyclaw: {
			doc: "Data subjects this content is about — the erasure keys its PII mappings are linked to. Host-supplied: busyclaw cannot infer whose data a value is, and neither the caller's identity nor the model's claim is trustworthy for it.",
		},
	}),
} as const;

export const clawApiInputSchemas = {
	bindConversation: bindConversationInput,
	appendMessage: appendMessageInput.and(subjectLineageInput),
	archiveClaw: idInput,
	pruneRuns: pruneRunsInput,
	listActiveRuns: listActiveRunsInput,
	archiveThread: idInput,
	controlRun: controlRunInput,
	deliverMessage: deliverMessageInput,
	proceedRun: proceedRunInput,
	continueRun: continueRunInput,
	createCheckpoint: createCheckpointInput,
	createClaw: createClawInput,
	createThread: createThreadInput,
	createToolCall: createToolCallInput.and(subjectLineageInput),
	createToolResult: createToolResultInput.and(subjectLineageInput),
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
			/** A value, or a function of the input when one verb carries two different asks — see
			 *  `RouteAuthz.level` and `proceedRun` below. */
			readonly level: RouteLevel | ((input: Input) => RouteLevel);
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
	// MANAGE, and on the CLAW rather than on each run. It is destructive and it is bulk: `use` is the
	// level at which a guest drives a turn, and a guest must not be able to delete the history of
	// everybody else's.
	pruneRuns: apiRoute("pruneRuns", on("manage", "claw", "clawId")),
	// READ, on the THREAD — the same level and the same resource `listMessages` uses. Seeing which
	// runs are working on a conversation you can already read tells you nothing the transcript will
	// not, and a router needs it before it can avoid starting a second turn.
	listActiveRuns: apiRoute("listActiveRuns", on("read", "thread", "threadId")),
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
	// R-H01. Erasure used to take a bare `subjectId` — no container in the request, nothing to resolve,
	// so the route authorized against the caller alone and any authenticated stranger could shred any
	// subject's mappings everywhere. The rows always carried `(scope, scopeId)`; only the request did
	// not. It does now, and binds exactly like `shareResource`: the caller NAMES a kind and an id, and
	// the generic owner ∪ scope ∪ grant rule decides it at `manage`. A `("claw", clawId)` container
	// therefore asks the claw's own owner rule, and a kind nothing registers resolves nothing and
	// denies. Deployment-wide erasure stays a real DSR need and stays reachable — from trusted
	// in-process code holding the redaction handle, which is not a surface a stranger can reach.
	forgetSubject: apiRoute("forgetSubject", {
		mode: "resource",
		level: "manage",
		// The pair IS a resource reference — which is the clearest evidence that a PII container was
		// never a tenancy scope. `{kind, id}` is what the PEP resolves; the wire now says the same.
		resolve: (input) => ({ kind: input.containerKind, id: input.containerId }),
	}),
	// R-H02. Authorized on the THREAD, not the claw: a thread implies its claw (the loader walks up),
	// and the row carries BOTH ids, so binding the shallower one let a caller who owned any claw hang a
	// row off somebody else's thread. The store refuses a mismatched pair too — the gate denies the
	// caller, the store keeps the row coherent for every other writer.
	createToolCall: apiRoute("createToolCall", on("use", "thread", "threadId")),
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
	createToolResult: apiRoute(
		"createToolResult",
		on("use", "thread", "threadId"),
	),
	getToolResult: apiRoute("getToolResult", on("read", "toolResult", "id")),
	listToolResults: apiRoute("listToolResults", {
		mode: "resource",
		level: "read",
		resolve: (input) => ({
			kind: "providerToolCall",
			id: `${input.runId}${PROVIDER_TOOL_CALL_SEPARATOR}${input.toolCallId}`,
		}),
	}),
	createCheckpoint: apiRoute(
		"createCheckpoint",
		on("use", "thread", "threadId"),
	),
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
	// approval — anchored on the record, at three levels, because viewing, deciding and executing are
	// three different permissions and collapsing them is how "can see it" quietly becomes "can run it".
	//
	//   read   see that it exists and what it parked
	//   use    DECIDE it — grant or deny
	//   manage EXECUTE the approved action, which is strictly more than deciding: the replay bypasses
	//          one gate by id, so resuming is the step that actually performs the parked call.
	//
	// The `userApprover` floor still applies on top of the decide methods (a human decides, a machine
	// never does) — that is a principal check, not an ownership one, and it was never a substitute.
	getApproval: apiRoute("getApproval", on("read", "approval", "id")),
	grantApproval: apiRoute("grantApproval", on("use", "approval", "approvalId")),
	denyApproval: apiRoute("denyApproval", on("use", "approval", "approvalId")),
	listApprovals: apiRoute(
		"listApprovals",
		callerOnly(
			"a LISTING, not a row: it has no id to resolve, so the handler filters to the approvals this caller may read rather than the gate refusing the call",
		),
	),
	// Resumes by approvalId, so it inherits exactly the gap above.
	continueRun: apiRoute("continueRun", on("manage", "approval", "approvalId")),
	// R-H01. The row carries its anchors now — the claw whose run produced it, the tenant it ran in,
	// the principal it ran as — so it resolves like an approval and by the same ladder. It used to
	// resolve against nothing, which made an effect (what a tool DID: input hash, output, compensation)
	// readable by any authenticated caller who could guess an id that is `run:<runId>:tool:<callId>`.
	getEffect: apiRoute("getEffect", on("read", "effect", "id")),
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
	// MANAGE on the run: this resumes durable work executing under the run's own principal, which is
	// the opposite direction from `controlRun`. The approval tag ADDITIONALLY keeps the manage-on-
	// approval floor it has always had, layered in the handler — strictly tighter than before, which
	// required manage on the approval and nothing at all on the run.
	proceedRun: apiRoute("proceedRun", {
		mode: "resource",
		// SPLIT BY TAG. A CHECKPOINT resume is the exact inverse of the stop `controlRun` already
		// grants at `use` — so pinning it at `manage` meant a `use` grantee could park every member's
		// turn and only an owner could un-park it, which is a denial-of-service wearing a permission
		// level. An APPROVAL continuation stays `manage`: it replays a gated call by id, which is the
		// direction that ADDS authority. The route comment on `controlRun` already drew this line.
		level: (input) => (input.proceed.kind === "approval" ? "manage" : "use"),
		resolve: (input) =>
			input.proceed.kind === "approval"
				? { kind: "approval", id: input.proceed.approvalId }
				: { kind: "run", id: input.runId },
	}),
	// USE, not manage: stopping a run reduces its authority, so the permissive level is the safer one
	// — and `manage` on a run is the level that RESUMES work, which is the opposite direction.
	controlRun: apiRoute("controlRun", on("use", "run", "runId")),
	// USE: delivering informs a run, it does not resume durable work. `manage` is the level that
	// makes a run act again, which is `proceedRun`.
	deliverMessage: apiRoute("deliverMessage", on("use", "run", "toRunId")),
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
	// It appends to a claw's transcript, so it is authorized against that claw exactly as
	// `sendMessage` is — NOT caller-only. Anchoring it on the caller would put it in the group the
	// sealed baseline permits for any authenticated principal, which is indistinguishable from
	// having no check at all on a method that writes to a shared row.
	sendMessageAndStream: on("use", "claw", "clawId"),
	// The SAME declaration `listMessages` carries, and deliberately so: watching a conversation
	// happen and reading it back are the same permission over the same resource, one live and one
	// after the fact. The thread loader inherits the claw's grants, so sharing a claw shares the
	// ability to watch its threads — and a stranger is denied here exactly as they are there.
	watchThread: on("read", "thread", "threadId"),
	// `read` on the RUN, the same declaration `getRun` carries. The run loader climbs to `run.clawId`,
	// so a claw's owner and its grantees reach it and a stranger does not — including for a cron run,
	// which has no thread to have been shared through.
	watchRun: on("read", "run", "runId"),
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
 * here (the principal floor denied first); the check is belt-and-suspenders for the unsafeOpen path too.
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

/** Reject a caller-supplied reserved (`busyclaw__`) context key — identity/authz facts are busyclaw's
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

	// ── the one seam between base-typed handlers and the config-shaped runtime ───────────────────
	//
	// The api object below is checked against `ClawApi` — the BASE contract — and re-presented as
	// `ClawApi<Config>` in a single cast at the return. That keeps every handler readable at the cost
	// of one boundary: inside them `ctx` and `options` wear the base types, while `context.runtime`
	// speaks `Config`. They are the same values at runtime; only the plugin-folded context type and
	// the model-name union differ, and no handler inspects either.
	//
	// These two exist because the previous spelling of that boundary was `as never` at each call —
	// and `never` is assignable to ANYTHING, so it did not bridge the seam, it deleted the check:
	// `args.message as never`, a string where a run context belongs, compiled just as quietly.
	//
	// What the named form buys, precisely: the unchecked step is one line in one place instead of
	// eight unexplained ones, and the parameter rejects a value of the wrong SHAPE (that string is
	// now a compile error). What it does NOT buy: `Config` is opaque inside this factory, so the two
	// config-shaped results stay mutually assignable and swapping one for the other still compiles.
	// Note the base ctx type cannot do this job itself — `RunContext<RuntimeConfig>` is
	// `Record<never, never>`, and in TypeScript a string is assignable to an empty object type.

	const forRuntimeCtx = (
		ctx: Record<string, unknown> | undefined,
	): RunContext<Config> | undefined =>
		ctx as unknown as RunContext<Config> | undefined;

	const forRuntimeOptions = (
		options: RunOptionsFor<RuntimeConfig> | undefined,
	): RunOptionsFor<Config> | undefined =>
		options as unknown as RunOptionsFor<Config> | undefined;

	/**
	 * Tokenize one artifact column against its claw's container before it is persisted.
	 *
	 * ONE place names the containerKind, because naming it twice is how the two halves drift: a value
	 * minted under `{claw, X}` and read under anything else comes back as a raw placeholder, and
	 * nothing throws when it does. `undefined` passes through — an absent column is not a value to
	 * redact, and walking it would only invent one.
	 */
	/**
	 * Open a conversational run: persist the user's turn, then build the options that tie the run to
	 * it. Shared by `sendMessage` and its streaming twin so the two cannot drift.
	 *
	 * The recording context is the load-bearing part. It is what puts the answer in the transcript,
	 * and — since the reader-departure rule keys off exactly that — what decides whether a closed tab
	 * finishes the run or aborts it. A streaming twin that quietly omitted it would look correct and
	 * throw away every answer whose reader left.
	 */
	const openConversationalRun = async (
		args: ClawSendInput,
		caller: ClawApiCaller | undefined,
	): Promise<{
		runId: string;
		userMessage: MessageRecord;
		runOptions: RunOptionsFor<RuntimeConfig>;
		/** Everything the engine needs to mint the run, minus `drive` — which each door supplies for
		 *  itself, because only the door knows whether it is streaming. Undefined on a claw with no
		 *  engine, where the door still drives the runtime directly. */
		startInput: EngineStartRunInput;
	}> => {
		assertNoReservedContext(args.ctx);
		// MINTED HERE, not by the engine, because the user's message must be appended BEFORE the run
		// is created (G5) and the append needs the id. Ordering append → create+enqueue+claim leaves
		// exactly one strandable failure — a user message whose run never started — which is visible
		// in the thread. The reverse order strands a run with no visible cause.
		const runId = newId("run");
		// Write-side ingress for the product transcript: the persisted user message is
		// tokenized like everything else durable (posture-aware per claw row).
		const userContent = context.redaction
			? await context.redaction.redact(
					{ text: args.message },
					{ containerKind: "claw", containerId: args.clawId },
				)
			: { text: args.message };
		const userMessage = await store().messages.append({
			clawId: args.clawId,
			content: userContent,
			runId,
			role: "user",
			threadId: args.threadId,
			visibility: "user",
		});
		// A conversational message is a human at the other end → interactive. The chosen model (if
		// any) rides alongside the server-set recording/runMode options. The authenticated caller
		// seeds the run's principal (`busyclaw__principal`) — the run IS the caller.
		const runOptions = {
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
		};
		// The same three facts the options carry, in the shape the ENGINE stores them: columns on the
		// run row rather than options on an invocation. `runMode` is stamped here and is never read
		// from `args` — a caller who could set it would be satisfying the very policy that exists to
		// detect their absence (see the field comment in contracts/src/run.ts).
		const startInput: EngineStartRunInput = {
			// THE TOKENIZED STRING, never `args.message` — this is D13, and it is a privacy fact rather
			// than a preference. The engine writes its prompt into `runtime_task.payload`, a column
			// nothing shreds and no api re-identifies. Handing it raw text made a second, permanent,
			// cleartext copy of every chat message one line after the same words were tokenized into
			// the transcript, and `forgetSubject` — which shreds MAPPINGS — structurally cannot reach
			// text that was never mapped. A completed DSR would have been a false statement (P1).
			//
			// Costs nothing downstream: the runtime's ingress redaction is a no-op on already-tokenized
			// text (the invariant `appendMessage` relies on) and the container is the same
			// `("claw", clawId)` either way, so placeholders stay coherent with the transcript.
			prompt: userContent.text,
			...(args.ctx !== undefined ? { ctx: forRuntimeCtx(args.ctx) } : {}),
			run: {
				id: runId,
				...(caller?.principal !== undefined
					? { principal: caller.principal }
					: {}),
			},
			recording: {
				clawId: args.clawId,
				threadId: args.threadId,
				originMessageId: userMessage.id,
			},
			...(args.model !== undefined ? { model: args.model } : {}),
			runMode: "interactive",
		};
		return { runId, userMessage, runOptions, startInput };
	};

	/**
	 * The invocation budget a driven turn yields against, so a long answer parks a checkpoint instead
	 * of being killed mid-step by the platform. Absent when the engine has no deadline (a daemon
	 * host), in which case nothing yields and nothing needs to.
	 */
	/**
	 * Refuse to resume a run that has already ended.
	 *
	 * A CHECK, NOT A FENCE, and on the engine path it is deliberately the outer of two. This read is
	 * a round trip ahead of the resume, so a concurrent stop can land in between; what actually
	 * settles it is `proceedRun`'s conditional write, in the same transaction that admits the
	 * continuation. This one exists because it refuses precisely — "run is already terminal", with
	 * the status — where the engine's refusal is a lost CAS reported as "somebody else is driving".
	 * On the ENGINE-LESS path it is not the outer guard, it is the only one.
	 *
	 * A SECOND RESUME OF THE SAME APPROVAL THROWS. That is the decision, not an oversight, and it is
	 * written here because this is where somebody would undo it. The first resume drives the run to a
	 * terminal status, so the second meets this. Before the door went through the engine it quietly
	 * re-ran the runtime and handed back the earlier answer — retry-safe, and the same shape that let
	 * a CANCELLED run execute the tool call its stop existed to prevent. Retry-safety was weighed
	 * against that and declined: a resume verb that silently re-runs is a resume verb that cannot be
	 * fenced. A caller that wants the earlier answer reads the transcript, which has it.
	 *
	 * SILENT when there is no run id (an ad-hoc runtime approval with no durable run behind it) or no
	 * run read model — there is nothing to check against, and inventing a refusal there would break
	 * the engine-less path this door also serves.
	 */
	const assertRunContinuable = async (
		runId: string | undefined,
	): Promise<void> => {
		if (runId === undefined || context.runs === undefined) return;
		const run = await context.runs.get(runId);
		if (run && isTerminalRunStatus(run.status)) {
			throw stateError("run is already terminal", {
				runId,
				status: run.status,
			});
		}
	};

	/**
	 * Stop what a revoked principal still has running in the claw they just lost.
	 *
	 * BEST EFFORT, and each run independently: the grant is already gone by the time this runs, so a
	 * failure here must not roll the revocation back or throw at a caller whose access change did
	 * take effect. One run that cannot be stopped must not spare the others either.
	 *
	 * SILENT when the engine cannot enumerate runs — an engine with no `listActiveForClaw` has no way
	 * to answer "which runs did this principal start here", and the honest consequence is that
	 * revocation on that backend removes the grant only. Stated in the port's own doc rather than
	 * warned about per call, which would fire on every unshare of a non-claw resource.
	 */
	const stopRunsOf = async (input: {
		resourceKind: string;
		resourceId: string;
		principalRef: string;
		requestedBy?: Principal;
	}): Promise<void> => {
		if (input.resourceKind !== "claw") return;
		const engine = context.engine;
		const list = context.runs?.listActiveForClaw;
		if (engine === undefined || list === undefined) return;
		const runs = await list({
			clawId: input.resourceId,
			principal: input.principalRef,
		});
		await Promise.all(
			runs.map(async (run) => {
				try {
					await engine.controlRun({
						runId: run.id,
						intent: "stop",
						...(input.requestedBy !== undefined
							? { requestedBy: input.requestedBy }
							: {}),
						reason: "access revoked",
					});
				} catch {
					// The revocation stands regardless; a run that refused the latch is one the reaper
					// or its own terminal transition will settle.
				}
			}),
		);
	};

	const driveDeadline = (): string | undefined => {
		const ms = context.engine?.softDeadlineMs;
		return ms === undefined
			? undefined
			: new Date(Date.now() + ms).toISOString();
	};
	const driveBudget = (): { deadlineAt: string } | Record<string, never> => {
		const at = driveDeadline();
		return at === undefined ? {} : { deadlineAt: at };
	};

	/**
	 * One outcome map for both doors, so the streaming twin cannot drift from `sendMessage`.
	 *
	 * Every arm is a 200. `apiRoutes` hardcodes its envelope with no status field, and both clients
	 * discard a well-formed success body on any non-2xx — so a 202 carrying a runId would be thrown
	 * away by every first-party caller. The distinction lives in the RESPONSE, where a client can
	 * actually read it.
	 */
	/**
	 * NOTHING IN THIS FILE WRITES TO THE RUN STREAM, and that is the design rather than an omission.
	 *
	 * Every chunk is written by the ENGINE, at the one place that knows a slice ended: `driveClaim`,
	 * which both the door and the cron drain go through. The door used to write some of them —
	 * `run.started`, then the text deltas, then the lifecycle event — and each was moved for the same
	 * reason. A door and a drain producing the same chunk from two different result shapes is two
	 * switches to keep in agreement by hand, and the last one drifted: a yield was announced as a
	 * park for months because only one of the two knew the difference.
	 *
	 * What the door keeps is its own in-memory tee to the reader in THIS invocation
	 * (`createDeltaChannel`), which is not the log and is nobody else's business.
	 */
	/**
	 * The one subscription body, shared by `watchThread` and `watchRun` so the two cannot drift on
	 * the things that are easy to get subtly different: when to stop, when to sleep, and what a stale
	 * page means.
	 *
	 * `onlyRun` filters to a single run's chunks — for `watchRun` over a conversational thread, whose
	 * log carries every run in that conversation.
	 */
	const watchStreamKey = (
		key: string,
		since: string | undefined,
		onlyRun?: string,
	): AsyncIterable<RunStreamPage> => {
		const stream = context.runStream;
		if (stream === undefined) {
			// LOUD. An empty stream is indistinguishable from a quiet conversation, so a deployment
			// with no place to put deltas would look like one where nothing is happening — for as
			// long as it took somebody to go and check the transcript.
			//
			// NEARLY UNREACHABLE NOW, and kept anyway. The stream falls back to the claw's own
			// database, so reaching here means a claw with no database at all — which has no threads
			// and no durable runs either, so the PEP denies before this. It stays as the honest
			// answer if that ever stops being true.
			throw configurationError(
				"this deployment has no run stream, so nothing can be watched live",
				{
					reason:
						"pass `runStream`, or a `secondaryStorage` for it to be defaulted from",
				},
			);
		}
		// The subscription itself belongs to the PORT — `pollingWatch` uses `watch` when the backend
		// has one and falls back to asking when it does not, so this door never learns which it got.
		// What is left here is the only part that IS this door's business: showing one run's chunks.
		const pages: AsyncIterable<RunStreamPage> = pollingWatch(stream, key, {
			...(since !== undefined ? { since } : {}),
		});
		if (onlyRun === undefined) return pages;
		return (async function* narrowed() {
			for await (const page of pages) {
				// FILTERED FOR DISPLAY, never for position: the page's own cursor is yielded unchanged,
				// because dropping this run's absence from a page must not stop the reader advancing
				// past it.
				const chunks = page.chunks.filter((c) => c.runId === onlyRun);
				if (chunks.length > 0 || page.stale) yield { ...page, chunks };
			}
		})();
	};

	const sendResultOf = (
		outcome: EngineStartRunResult,
		runId: string,
		userMessage: MessageRecord,
	): ClawSendResult => {
		if (outcome.result === undefined) {
			return {
				driven: false,
				runId,
				userMessage,
				// An engine that drove nothing and said why keeps its word; one that returned neither
				// a result nor a reason is reported as the commonest cause rather than as a gap the
				// caller has to interpret.
				reason: outcome.notDriven ?? "running-elsewhere",
			};
		}
		return {
			driven: true,
			runId,
			result: runtimeResultOf(outcome.result),
			userMessage,
		};
	};

	/**
	 * An engine's opaque work result, as the shape this door promises its callers.
	 *
	 * PARSED, not cast. `EngineWorkResult` is `unknown` on purpose — contracts does not import
	 * `RuntimeResult` — so this is where the boundary is crossed, and an engine returning something
	 * else is a configuration error to say out loud rather than a value to hand onward and let fail
	 * somewhere less obvious.
	 *
	 * ONE parser, because two doors cross this boundary now: a conversational turn and an approval
	 * resume. Writing the second one by hand is how the door and the engine came to disagree about
	 * everything else in this file.
	 */
	const runtimeResultOf = (result: EngineWorkResult): RuntimeResult => {
		const valid = RuntimeResultSchema(result);
		if (valid instanceof ark.errors) {
			throw validationError(
				`engine "${context.engine?.kind ?? "unknown"}" returned a result this door cannot read`,
				valid.summary,
			);
		}
		return valid;
	};

	const redactArtifact = async <T>(
		value: T,
		clawId: string,
		subjectIds?: readonly string[],
	): Promise<T> =>
		value === undefined || context.redaction === undefined
			? value
			: context.redaction.redact(value, {
					containerKind: "claw",
					containerId: clawId,
					// R-M03: the lineage the host supplied rides into the mapping, so erasure can find it.
					// Without it the mapping is minted linked to nobody and `forgetSubject` sweeps for rows
					// that were never written.
					...(subjectIds !== undefined ? { subjectIds: [...subjectIds] } : {}),
				});
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
	/**
	 * Record a human's governance decision — actor, resource, outcome.
	 *
	 * `status` carries the outcome so a reader does not have to parse the name, and `decidedBy` is the
	 * approver read back off the STORED record rather than off the caller: the store decided who won
	 * the transition, and the log should say what the store did, not what this call intended.
	 */
	const auditDecision = async (
		name: "approval.granted" | "approval.denied",
		record: {
			id: string;
			toolName: string;
			decidedBy?: string;
			clawId?: string;
		},
		reason?: string,
	): Promise<void> => {
		await context.runtime.audit?.append({
			ts: new Date().toISOString(),
			boundary: "governance",
			name,
			status: name === "approval.granted" ? "ok" : "denied",
			...(record.decidedBy !== undefined
				? { principal: record.decidedBy, decidedBy: record.decidedBy }
				: {}),
			...(record.clawId !== undefined ? { clawId: record.clawId } : {}),
			...(reason !== undefined ? { reason } : {}),
			payload: { approvalId: record.id, toolName: record.toolName },
		});
	};

	/**
	 * Record a privacy event.
	 *
	 * R-M09. This was ACTORLESS and success-only: no `principal`, and no way to write a failure. A
	 * re-identifying read is the single most accountable thing this api does, and the log said what was
	 * revealed without saying who revealed it — so the entry answered a compliance question only if you
	 * already knew the answer. A refused or failed erasure wrote nothing at all, which is the entry a
	 * regulator most wants: "it was asked for and it did not happen."
	 */
	const auditPrivacy = async (
		name: "pii.reidentification" | "pii.erasure",
		payload: JsonObject,
		options?: { by?: Principal; status?: "ok" | "error"; reason?: string },
	): Promise<void> => {
		await context.runtime.audit?.append({
			ts: new Date().toISOString(),
			boundary: "privacy",
			name,
			status: options?.status ?? "ok",
			...(options?.by !== undefined ? { principal: options.by } : {}),
			...(options?.reason !== undefined ? { reason: options.reason } : {}),
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
		// call (unsafeOpen) stamps system:anonymous rather than crashing; the principal floor already denies an
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

		async pruneRuns({ clawId, before, limit }) {
			const engine = context.engine;
			if (engine?.pruneRuns === undefined) {
				// LOUD, not a silent zero. "Nothing to prune" and "this engine cannot prune" are
				// different facts, and a host scheduling this needs to learn the second one at the first
				// call rather than from a disk graph six months later.
				throw unsupportedOperationError(
					"this engine cannot prune runs",
					engine === undefined
						? { reason: "no engine is configured" }
						: { engine: engine.kind },
				);
			}
			const swept = await engine.pruneRuns({
				clawId,
				before,
				...(limit !== undefined ? { limit } : {}),
			});
			// The checkpoints belong to a DIFFERENT port over the same database, so the engine cannot
			// reach them — it hands back the ids it swept and this joins the two halves. Safe because
			// every id it names is terminal, which is the precondition `deleteForRuns` states and
			// cannot check for itself.
			const checkpoints =
				(await context.runtime.checkpoints?.deleteForRuns?.(swept.runIds)) ?? 0;
			return {
				runs: swept.runs,
				events: swept.events,
				tasks: swept.tasks,
				messages: swept.messages,
				checkpoints,
			};
		},

		createThread: (args) => store().threads.create(args),
		getThread: ({ id }) => store().threads.get(id),
		listThreads: ({ clawId }) => store().threads.listForClaw(clawId),
		archiveThread: ({ id }) => store().threads.archive(id),

		async appendMessage(args) {
			// The api's own write-side ingress: content persists tokenized (posture-aware; a
			// per-claw raw row passes through). Already-tokenized text is a no-op.
			//
			// R-M03: `subjectIds` is lineage, not a column — it tells the mappings whose data this is
			// and does not travel to the message row.
			const { subjectIds, ...row } = args;
			const content = await redactArtifact(
				args.content,
				args.clawId,
				subjectIds,
			);
			return store().messages.append({ ...row, content });
		},
		getMessage: ({ id }) => store().messages.get(id),
		async listMessages(args, caller?: ClawApiCaller) {
			const rows = await store().messages.listForThread(args);
			// Read-side ONLY: the original view re-identifies the RETURNED copies; the rows at
			// rest stay tokens. No redaction configured → nothing was ever mapped → as stored.
			if (args.view !== "original" || context.redaction === undefined) {
				return rows;
			}
			const thread = await store().threads.get(args.threadId);
			if (!thread) return rows;
			const container = { containerKind: "claw", containerId: thread.clawId };
			const revealed = await Promise.all(
				rows.map(async (message) => ({
					...message,
					content: await requireRedaction().original(
						message.content,
						container,
					),
				})),
			);
			await auditPrivacy(
				"pii.reidentification",
				{ ...container, threadId: args.threadId, messages: rows.length },
				caller?.principal ? { by: caller.principal } : {},
			);
			return revealed;
		},

		async sendMessage(args, caller?: ClawApiCaller) {
			const { runId, userMessage, runOptions, startInput } =
				await openConversationalRun(args, caller);
			// ANNOUNCED BEFORE THE WORK, so a watcher already looking at this thread sees the turn
			// begin rather than discovering it when the answer lands. This is also the chunk that
			// makes discovery free: a watcher never has to learn run ids from anywhere else.
			// THROUGH THE ENGINE when there is one, which is every database-backed claw (D14). The
			// turn becomes a durable run: `getRun` answers for it, `controlRun` from a second tab
			// reaches it, and a driver that dies leaves a row a successor can claim — none of which
			// is true of a bare `runtime.generate`.
			//
			// Directly when there is not. A claw configured with `{ model }` and no database has
			// nowhere to put a run row, and refusing to answer would be a worse answer than
			// answering without durability.
			const response: ClawSendResult =
				context.engine === undefined
					? {
							driven: true,
							runId,
							result: await context.runtime.generate(
								args.message,
								forRuntimeCtx(args.ctx),
								runOptions,
							),
							userMessage,
						}
					: sendResultOf(
							await context.engine.startRun({
								...startInput,
								drive: driveBudget(),
							}),
							runId,
							userMessage,
						);
			if (args.view !== "original" || context.redaction === undefined) {
				return response;
			}
			// Same read-side rule as listMessages: only the RETURNED copy is re-identified.
			const container = { containerKind: "claw", containerId: args.clawId };
			const revealed = await requireRedaction().original(response, container);
			await auditPrivacy(
				"pii.reidentification",
				{ ...container, threadId: args.threadId, runId, messages: 1 },
				caller?.principal ? { by: caller.principal } : {},
			);
			return revealed;
		},

		// No `view: "original"` branch, unlike sendMessage. Re-identifying a RESULT is a read of a
		// finished value; there is no finished value here, and re-identifying deltas as they fly past
		// would put raw PII on the wire under a flag meant for one audited read. A caller who wants
		// the original reads the transcript back through `listMessages` once the run has landed.
		async sendMessageAndStream(args, caller?: ClawApiCaller) {
			const { runId, userMessage, runOptions, startInput } =
				await openConversationalRun(args, caller);
			if (context.engine === undefined) {
				const stream = context.runtime.stream(
					args.message,
					forRuntimeCtx(args.ctx),
					runOptions,
				);
				return {
					textStream: stream.textStream,
					result: stream.result.then(
						(result): ClawSendResult => ({
							driven: true,
							runId,
							result,
							userMessage,
						}),
					),
					userMessage,
					runId,
				};
			}
			// WHAT A DEPARTING READER MEANS, and it is not one answer — it is two, and which one is
			// right depends on whether anything will pick the run up again (D6).
			//
			// A reader leaves mid-answer constantly: the tab closes, the transport cancels, the
			// consumer `break`s. What must NEVER happen is losing the answer, because the turn is
			// durable and the reply belongs in the thread whether or not anyone is watching it arrive.
			//
			// WITH a continuation path, departure brings the deadline forward to now: the slice reaches
			// its next control point, writes a checkpoint, enqueues its resume, and the drain finishes
			// the turn. That bounds what this invocation still owes to at most one more model step —
			// which matters because on serverless the invocation is living on borrowed time already.
			//
			// WITHOUT one — `cron: false`, where a pending task is claimed by nobody — the same move
			// would convert a turn that finishes into a turn that never lands. So the run detaches and
			// finishes here, exactly as it does today. The channel discards pushes after cancellation,
			// so a detached run costs nothing to ignore.
			const budgetAt = driveDeadline();
			const handOff = context.engine?.resumesPendingWork === true;
			let departedAt: string | undefined;
			// THE SAME CHANNEL `runtime.stream` uses, not a second one. Its backpressure (a full
			// buffer makes `push` return a promise the engine awaits, which stops the read from the
			// provider) is load-bearing, and a reimplementation here would be a place for it to
			// quietly diverge.
			const channel = createDeltaChannel({
				onCancel: () => {
					if (handOff) departedAt = new Date().toISOString();
				},
			});
			// TWO SINKS, ONE DATA — and only ONE of them is this door's business. The reader in this
			// invocation is served from memory, here; everybody else reads the stream, which the
			// ENGINE writes because it is the thing that holds the lease. This used to write text
			// chunks too, which double-wrote every delta on the one path that has both sinks.
			//
			// NOT awaited — `startRun` resolves when the whole run does, and the deltas have to be
			// readable long before that. The promise is handed back as `result` instead.
			const driven = context.engine
				.startRun({
					...startInput,
					drive: {
						// RE-READ EACH STEP when a handoff is possible, so `departedAt` — set after this
						// object was built, from inside a model call — is visible at all. A scalar could
						// only ever carry the budget this invocation started with.
						...(handOff
							? { deadlineAt: () => departedAt ?? budgetAt }
							: budgetAt !== undefined
								? { deadlineAt: budgetAt }
								: {}),
						onDelta: (text: string) => channel.push(text),
					},
				})
				.finally(() => channel.close());
			// THE TIME THE REST OF THIS RUN NEEDS, asked for from the only party who can grant it. On a
			// daemon this is absent and nothing is lost; on serverless, without it, every branch above
			// is decided correctly and then killed with the isolate the moment the response completes.
			context.waitUntil?.(driven);
			return {
				textStream: channel.iterable,
				result: driven.then((outcome) =>
					sendResultOf(outcome, runId, userMessage),
				),
				userMessage,
				runId,
			};
		},

		async watchThread({ threadId, since }) {
			return watchStreamKey(threadStreamKey(threadId), since);
		},

		async watchRun({ runId, since }) {
			// WHICH LOG this run's chunks are in, answered from the row rather than assumed. A
			// conversational run writes into its THREAD's log — that is what lets a watcher who knows
			// only the conversation see it — so watching one run means reading that log and keeping
			// this run's chunks. A run with no thread has a log of its own and nothing to filter.
			const run = await requireRuns(context.runs).get(runId);
			if (!run) {
				// The PEP already denies an unresolvable run, so reaching here means the row went
				// away between the decision and this read. Say which run rather than returning an
				// empty stream that reads like a quiet one.
				throw stateError("no such run to watch", { runId });
			}
			const threadId = run.threadId;
			const pages =
				threadId !== undefined
					? watchStreamKey(threadStreamKey(threadId), since, runId)
					: watchStreamKey(runStreamKey(runId), since);
			// AND IT ENDS WHEN THE RUN DOES. A terminal run will never produce another chunk, so a
			// subscription that kept polling would hold an HTTP connection open forever for a turn
			// that finished — which `watchThread` must do (more turns may come) and this must not.
			//
			// WHICH EVENTS ARE TERMINAL is read from the contract rather than listed here. Three places
			// branch on it and each carried its own list; the cost of them disagreeing is not
			// symmetric — stopping early truncates an answer, never stopping holds an HTTP connection
			// open forever. `superseded`, `parked` and `yielded` are all non-terminal: a new attempt, a
			// verb somebody has to say, or a continuation already enqueued.
			return (async function* untilTerminal() {
				for await (const page of pages) {
					yield page;
					if (page.stale) return;
					if (
						page.chunks.some(
							(c) =>
								c.kind === "lifecycle" && isTerminalRunStreamLifecycle(c.event),
						)
					) {
						return;
					}
				}
			})();
		},

		async forgetSubject(
			{ subjectId, containerKind, containerId },
			caller?: ClawApiCaller,
		) {
			// A FAILED erasure is the entry a regulator most wants — "it was asked for and it did not
			// happen" — and it used to write nothing at all, because only the success path reached the
			// log. Recorded either way now, and the failure is still raised.
			let erased: number;
			try {
				erased = await requireRedaction().forgetSubject(subjectId, {
					containerKind,
					containerId,
				});
			} catch (error) {
				await auditPrivacy(
					"pii.erasure",
					{ subjectId, containerKind, containerId, erased: 0 },
					{
						status: "error",
						reason: errorMessage(error),
						...(caller?.principal ? { by: caller.principal } : {}),
					},
				);
				throw error;
			}
			// The count rides into the audit too. "Erasure requested and nothing was found" is the
			// answer a regulator asks for, and it is indistinguishable from a completed shred unless
			// somebody wrote the number down at the moment it was true.
			await auditPrivacy(
				"pii.erasure",
				{ subjectId, containerKind, containerId, erased },
				caller?.principal ? { by: caller.principal } : {},
			);
			return { erased };
		},

		// The api's write-side ingress for the runtime's ARTIFACTS — same rule `appendMessage` follows,
		// and for the same reason: these columns are annotated `pii: "redacted"`, and an annotation the
		// write path ignores is a promise the row does not keep. The runtime's own writes are already
		// tokenized; it was only the PUBLIC methods that handed caller data straight to the store, so
		// an authenticated caller could park raw PII inside a claw whose posture is strict — where
		// `forgetSubject` would then report a confident success having shredded mappings for a value
		// that was never behind a placeholder.
		//
		// Posture-aware through the one handle, so a per-claw `raw` row still passes through, and
		// already-tokenized text is a no-op — the runtime's own writes cost a walk and change nothing.
		async createToolCall(args) {
			const { subjectIds, ...row } = args;
			const redacted = await redactArtifact(args.args, args.clawId, subjectIds);
			return store().toolCalls.create({ ...row, args: redacted });
		},
		getToolCall: ({ id }) => store().toolCalls.get(id),
		getToolCallByProviderId: (args) => store().toolCalls.getByToolCallId(args),
		updateToolCallStatus: ({ id, patch }) =>
			store().toolCalls.updateStatus(id, patch),

		async createToolResult(args) {
			// `output` and `error` are separate columns and a result carries one or the other; both are
			// walked so neither can be the unredacted way in.
			const { subjectIds, ...row } = args;
			const [output, error] = await Promise.all([
				redactArtifact(args.output, args.clawId, subjectIds),
				redactArtifact(args.error, args.clawId, subjectIds),
			]);
			return store().toolResults.create({ ...row, output, error });
		},
		getToolResult: ({ id }) => store().toolResults.get(id),
		listToolResults: (args) => store().toolResults.listForToolCall(args),

		async createCheckpoint(args) {
			const state = await redactArtifact(args.state, args.clawId);
			return store().checkpoints.create({ ...args, state });
		},
		getCheckpoint: ({ id }) => store().checkpoints.get(id),
		getLatestCheckpoint: ({ runId }) => store().checkpoints.latestForRun(runId),

		// `forRuntimeCtx` / `forRuntimeOptions` carry the base-`satisfies ClawApi` types across to the
		// runtime's config-shaped ones — see the seam at the top of this factory. The authenticated
		// caller seeds the run's principal (`busyclaw__principal`, via the forge-proof caller option);
		// the PEP already decided the caller may make this call (see authz-pep).
		generate: ({ prompt, ctx, options }, caller?: ClawApiCaller) => {
			assertNoReservedContext(ctx);
			return context.runtime.generate(
				prompt,
				forRuntimeCtx(ctx),
				forRuntimeOptions(
					runtimeRunOptionsWithCaller(options, caller?.principal),
				),
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
				forRuntimeCtx(ctx),
				forRuntimeOptions(
					runtimeRunOptionsWithCaller(options, caller?.principal),
				),
			);
		},
		async continueRun({ approvalId, ctx, options }, caller?: ClawApiCaller) {
			assertNoReservedContext(ctx);
			const approval = await context.runtime.approvals?.get(approvalId);
			const recording = approval
				? recordingFromRuntimeApprovalMetadata(approval.metadata)
				: undefined;
			// A CANCELLED RUN STAYS CANCELLED, and this door is where that was not true.
			//
			// The engine's `proceedRun` refuses a terminal run — it is the whole reason `EngineProceed`
			// verifies the record's own run id. This path goes straight to `runtime.continueRun`, which
			// knows about approvals and nothing about runs, so a granted approval resumed a stopped run
			// and executed the very tool call the stop existed to prevent. G6 makes that reachable
			// deliberately: revoking a member cancels their parked runs, and every one of those runs is
			// parked ON an approval somebody can still grant.
			await assertRunContinuable(recording?.runId);
			// THROUGH THE ENGINE WHEN THERE IS ONE, which is the correction `sendMessage` already took.
			//
			// This used to call `runtime.continueRun` directly, and the runtime knows about approvals
			// and nothing about runs — so an approved turn executed OUTSIDE the durable run it belongs
			// to. Three things followed. Nothing fenced it, which is why the check above had to be
			// bolted on here. Not one chunk of the resumed answer reached a watcher, because every
			// chunk is written by `driveClaim`. And no terminal lifecycle was written either, so
			// `watchRun` waited forever for a turn that had finished — a leaked connection per resumed
			// run.
			//
			// `drive` is what keeps this a RESUME rather than a schedule: the same enqueue-claim-drive
			// `sendMessage` performs, so the caller still awaits the answer.
			const engineRunId = recording?.runId;
			if (context.engine !== undefined && engineRunId !== undefined) {
				const outcome = await context.engine.proceedRun({
					runId: engineRunId,
					proceed: { kind: "approval", approvalId },
					...(ctx !== undefined ? { ctx: forRuntimeCtx(ctx) } : {}),
					drive: driveBudget(),
				});
				if (outcome.result !== undefined)
					return runtimeResultOf(outcome.result);
				// Somebody else is driving it, or the driver lost its lease mid-slice. Either way this
				// caller cannot report an answer it did not produce.
				throw stateError("the approval is being resumed elsewhere", {
					approvalId,
					runId: engineRunId,
					reason: outcome.notDriven ?? "running-elsewhere",
				});
			}
			// NO ENGINE, or an ad-hoc approval with no durable run behind it — the runtime path, which
			// is what this door has always been, fenced by `assertRunContinuable` above.
			//
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
					forRuntimeCtx(ctx),
					continueOptions,
				);
			}
			return context.runtime.continueRun(
				approvalId,
				forRuntimeCtx(ctx),
				runtimeRunOptionsWithRecording(continueOptions, recording),
			);
		},

		// `decidedBy` is stamped from the authenticated caller `{ principal }`, never a caller-supplied `by`
		// (docs/plans/stamped-fields.md, #6) — a forged approver identity is impossible. The runtime store's
		// grant/deny write it as the decision stamp.
		// R-M09. The DECISION is the evidence, and it was the one thing not recorded: the approval row
		// carried `decidedBy` and could be written again, the audit log carried the action that ran
		// afterwards, and nothing carried the judgement that released it. So "who approved this, and
		// did they approve or refuse" was answerable only by trusting mutable state.
		//
		// Recorded AFTER the transition and only when it happened — a null means the approval was not
		// pending, and logging a decision nobody made would be worse than logging none.
		grantApproval: async ({ approvalId }, caller?: ClawApiCaller) => {
			const record =
				(await context.runtime.approvals?.grant(
					approvalId,
					userApprover(caller),
				)) ?? null;
			if (record) await auditDecision("approval.granted", record);
			return record;
		},
		denyApproval: async ({ approvalId, reason }, caller?: ClawApiCaller) => {
			const record =
				(await context.runtime.approvals?.deny(
					approvalId,
					userApprover(caller),
					reason,
				)) ?? null;
			if (record) await auditDecision("approval.denied", record, reason);
			return record;
		},
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
			// Decided as `getApproval` — the single-row read. Asking as `listApprovals` would inherit the
			// caller-only permit that every listing has and pass for everyone, which is the filter quietly
			// doing nothing. `filter` rather than a `check` loop so the caller's scopes and the whole page's
			// grants are each fetched once instead of once per row.
			return ctx.authz.filter(
				"read",
				(await context.runtime.approvals?.list(args)) ?? [],
				(row) => ({ kind: "approval", id: row.id }),
				"getApproval",
			);
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
				// A person came through this door, so the row is theirs — stamped here, exactly like
				// `updatedBy`, and for the same reason: a caller that could set it could tag its own
				// slice `spec:<source>` and have the next registration of that spec silently replace it,
				// or claim a source's tag and never be regenerated again. Writing to a name a generator
				// owns is what DETACHES it: the edit takes, and the registration that would have
				// overwritten it reports the divergence instead of eating it.
				managedBy: "operator",
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
			// ENUMERATED, never spread — and this is a security property, not a style one. arktype
			// PRESERVES undeclared keys and `parseClawApiInput` returns its output verbatim, so
			// `{ ...args }` forwards whatever the caller sent, including fields this input schema has
			// never heard of. Harmless only while `EngineStartRunInput` has nothing worth forging; the
			// moment it gains a `recording` (which names the run's authz parent, its redaction
			// containerKind, and the thread its answers land in) a spread hands all three to the caller
			// with no schema change anywhere and nothing to notice. The schema rejects undeclared keys
			// too, and the two are deliberately redundant: one of them is the door, the other survives
			// somebody adding a field to the engine input without looking here.
			return requireEngine(context.engine).startRun({
				prompt: args.prompt,
				ctx: args.ctx,
				// THE PRODUCT API IS `"core"`. Stamped here, not defaulted in the store, so the two
				// doors that can create a run each say which one they are rather than one of them
				// inheriting the other's answer.
				origin: "core",
				run: {
					id: args.run?.id,
					principal: caller?.principal ?? SYSTEM_ANONYMOUS,
				},
			});
		},
		// The requester is STAMPED, exactly as `startRun` stamps the run's principal. There is no
		// `requestedBy` on the input at all, so "who stopped my run" cannot be answered wrongly — qm's
		// sharpest hole is that its stop signal carries no principal, and its Slack path calls the
		// internal client with no viewer, so anyone in the thread can kill anyone's run.
		// The body is tokenized into the RECEIVING run's container before it is stored, and which
		// container that is now depends on the run rather than being assumed.
		deliverMessage: async (args, caller?: ClawApiCaller) => {
			// THE CONTAINER FOLLOWS THE CLAW, when the run has one.
			//
			// This used to hardcode `("run", toRunId)` and say so: derivable without the run having
			// started, which is what made it safe to admit to a run nobody had claimed. True, and it
			// stops being the right answer the moment a run can be RECORDED — because a recorded run's
			// own placeholders are minted under `("claw", clawId)`, and the failure of a mismatch is
			// silent end to end: the door tokenizes into one namespace, the drain hands the tool a
			// placeholder minted in another, the lookup misses, and the tool receives the literal
			// `{{pii:…}}` string with nothing thrown anywhere.
			//
			// The extra read is not new cost — `admitMessage` already loads this row inside its CAS
			// loop and already refuses an unknown run. A run with no claw keeps the run containerKind,
			// which is still correct for it and still derivable before it starts.
			const target = await context.runs?.get(args.toRunId);
			const container =
				target?.clawId !== undefined
					? { containerKind: "claw", containerId: target.clawId }
					: { containerKind: "run", containerId: args.toRunId };
			const body = context.redaction
				? await context.redaction.redact(args.body, container)
				: args.body;
			return requireEngine(context.engine).deliverMessage({
				toRunId: args.toRunId,
				body,
				mode: args.mode,
				sender: caller?.principal ?? SYSTEM_ANONYMOUS,
				idempotencyKey: args.idempotencyKey,
				containerKind: container.containerKind,
				containerId: container.containerId,
			});
		},
		controlRun: async (args, caller?: ClawApiCaller) =>
			requireEngine(context.engine).controlRun({
				runId: args.runId,
				intent: args.intent,
				requestedBy: caller?.principal ?? SYSTEM_ANONYMOUS,
				...(args.reason !== undefined ? { reason: args.reason } : {}),
			}),
		proceedRun: async (args, caller?: ClawApiCaller) => {
			assertNoReservedContext(args.ctx);
			// R-M10, generalized to every tag. The record that parked the run knows which run that is,
			// and the engine VERIFIES the caller's `runId` against it rather than trusting either side.
			// Taking only the record's id would leave the PEP nothing to authorize against; taking only
			// the caller's would let a continuation be pointed at somebody else's run. Taking both and
			// REFUSING on disagreement is what makes it safe: the PEP has already required `manage` on
			// the record's own anchor (see the route — the approval tag anchors on the approval, the
			// checkpoint tag on the run), so the remaining question is whether the two agree.
			const recordRunId =
				args.proceed.kind === "approval"
					? (await context.runtime.approvals?.get(args.proceed.approvalId))
							?.metadata?.runId
					: (await context.runtime.checkpoints?.get(args.proceed.checkpointId))
							?.runId;
			// FAIL CLOSED on both shapes of wrong. A record that names a different run is the fork
			// R-M10 fixed. A record that cannot be found at all is not "nothing to verify" — it is a
			// resume with no resume state, and admitting it schedules a slice whose only outcome is to
			// discover there was nothing there.
			if (recordRunId === undefined) {
				throw stateError("no such record to proceed from", {
					runId: args.runId,
					proceed: args.proceed.kind,
				});
			}
			if (recordRunId !== args.runId) {
				throw stateError("the record named does not belong to the run named", {
					runId: args.runId,
					recordRunId,
				});
			}
			return requireEngine(context.engine).proceedRun({
				runId: args.runId,
				proceed: args.proceed,
				...(args.ctx ? { ctx: args.ctx } : {}),
			});
		},
		// THE RUN DOOR STOPS BEING A CONTENT DOOR (D13/P2).
		//
		// `listMessages` gates content behind `view` and audits every re-identification as
		// `pii.reidentification`. These two returned the same class of thing at `read` with neither —
		// `run.input` used to carry the prompt, and a `run.completed` event payload carries the whole
		// terminal result including the assistant's answer. An asymmetry like that is not a smaller
		// door, it is a way around the bigger one.
		//
		// Removing the content rather than threading `view` through here is deliberate:
		// `ClawRunReadModel` knows a run id and nothing else, so the claw container a re-identification
		// needs would have to be plumbed in for a feature the control plane does not want. Status,
		// wait reason, scope and timestamps are what "how is my run doing" actually asks.
		listActiveRuns: async ({ threadId }) => {
			const list = context.runs?.listActiveForThread;
			// An engine that cannot index runs by thread answers "none". Honest rather than a throw:
			// the caller's next move — start a turn — is the right one either way, and refusing would
			// take down a channel over a query the backend simply does not have.
			if (list === undefined) return [];
			return (await list({ threadId })).map((run) => {
				const { input: _input, ...view } = run;
				return view;
			});
		},

		getRun: async ({ id }) => {
			const run = await requireRuns(context.runs).get(id);
			if (!run) return null;
			const { input: _input, ...view } = run;
			return view;
		},
		listRunEvents: async ({ runId }) => {
			const events = await requireRuns(context.runs).events(runId);
			return events.map((event) => ({
				...event,
				payload: operationalPayload(event.payload),
			}));
		},

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
		// REVOCATION REACHES THE RUNS IT AUTHORIZED (hazard G6).
		//
		// Deleting the grant used to be the whole operation, and authority is resolved ONCE per slice
		// from `run.principal` — so a member removed from a claw kept executing tool calls in it until
		// their in-flight run finished on its own. Revoking access while the access is still being
		// used is precisely the moment it matters.
		//
		// No new primitive: the same latch `controlRun` already writes. A queued run's task is
		// dead-lettered, a run in flight stops at its next control point, and a run that has already
		// finished answers `accepted: false` and costs one read.
		unshareResource: async (
			{ resourceKind, resourceId, principalRef },
			caller?: ClawApiCaller,
		) => {
			const deleted = await requireGrantStore(context.grantStore).delete({
				resourceKind,
				resourceId,
				principalRef,
			});
			await stopRunsOf({
				resourceKind,
				resourceId,
				principalRef,
				...(caller?.principal !== undefined
					? { requestedBy: caller.principal }
					: {}),
			});
			return deleted;
		},
	} satisfies ClawApi;

	// The claws store is typed against the base claw contract, but at runtime it persists and returns
	// the host/plugin columns merged onto the claw model (see createClawsStore.additionalFields).
	// Re-present those through the config-derived claw types — the single seam between the base-typed
	// store and the config-shaped public api.
	return api as unknown as ClawApi<Config>;
}
