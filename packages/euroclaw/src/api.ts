import type {
	AppendMessageInput,
	ApprovalRecord,
	ApprovalStatus,
	BindConversationInput,
	BindConversationResult,
	CheckpointRecord,
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
	SecretDeclaration,
	Secrets,
	ThreadRecord,
	ToolCallRecord,
	ToolCallStatusPatch,
	ToolResultRecord,
	UpdateClawInput,
} from "@euroclaw/contracts";
import {
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
	REGISTER_OPENAPI_SPEC_ACTION,
	type RunContext,
	type Runtime,
	type RuntimeConfig,
	type RuntimeResult,
	type RuntimeRunOptions,
	recordingFromRuntimeApprovalMetadata,
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

export type ClawSendInput<Config extends RuntimeConfig = RuntimeConfig> = {
	clawId: string;
	threadId: string;
	message: string;
	ctx?: RunContext<Config>;
	runId?: string;
	view?: MessageView;
};

export type ClawSendResult = {
	result: RuntimeResult;
	userMessage: MessageRecord;
};

export const clawCronHandlerSecretConfig = ark({
	"headerName?": "string | undefined",
	"limit?": "number | undefined",
	secret: "string",
});
export type ClawCronHandlerSecretConfig =
	typeof clawCronHandlerSecretConfig.infer;

export const clawCronHandlerUnsafeConfig = ark({
	"headerName?": "string | undefined",
	"limit?": "number | undefined",
	unsafeAllowUnauthenticated: "true",
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

	run: (input: {
		prompt: string;
		ctx?: RunContext<Config>;
		options?: RuntimeRunOptions;
	}) => Promise<RuntimeResult>;
	continueRun: (input: {
		approvalId: string;
		ctx?: RunContext<Config>;
		options?: RuntimeRunOptions;
	}) => Promise<RuntimeResult | null>;

	grantApproval: (input: {
		approvalId: string;
		by: string;
	}) => Promise<ApprovalRecord | null>;
	denyApproval: (input: {
		approvalId: string;
		by: string;
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
	registerOpenApiSpec: (input: {
		source: string;
		document: JsonObject;
		registeredBy: string;
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
	putPolicySlice: (input: {
		organizationId: string;
		name: string;
		cedar: string;
		mode: "enforce" | "shadow" | "off";
		updatedBy: string;
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
};

/** The FLAT api methods — the ones the method→route machinery maps. */
export type ClawApiMethod = keyof ClawApi;
export type ClawApiHttpMethod = "GET" | "POST";
export type ClawApiInputSchema = (input: unknown) => unknown;
export type ClawApiRouteDefinition<
	Method extends ClawApiMethod = ClawApiMethod,
> = {
	apiMethod: Method;
	httpMethod: ClawApiHttpMethod;
	path: `/${string}`;
	inputSchema: ClawApiInputSchema;
};

const idInput = ark({ id: "string" });
const clawIdInput = ark({ clawId: "string" });
const runIdInput = ark({ runId: "string" });
const runToolCallInput = ark({ runId: "string", toolCallId: "string" });
const jsonObjectOrUndefined = jsonObject.or("undefined");
const runtimeAbortSignalInput = ark({ aborted: "boolean" });
const runtimeRunOptionsInput = ark({
	"abortSignal?": runtimeAbortSignalInput.or("undefined"),
});
const runtimeRunOptionsOrUndefined = runtimeRunOptionsInput.or("undefined");
const engineRunMetadataInput = ark({
	"principal?": "string | undefined",
	"id?": "string | undefined",
	"team?": "string | undefined",
});
const engineRunMetadataOrUndefined = engineRunMetadataInput.or("undefined");
// Both derive straight from the entities' immutable/input flags — every mutable, caller-facing column,
// all optional. No hand-listed pick/optional (which is also why the updatedAt server column no longer
// leaks into the tool-call patch).
const updateClawPatchInput = clawEntity.updateSchema();
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
	"afterSequence?": "number | undefined",
	"limit?": "number | undefined",
	threadId: "string",
	"view?": "'redacted' | 'original' | undefined",
});
const sendMessageInput = ark({
	clawId: "string",
	"ctx?": jsonObjectOrUndefined,
	message: "string",
	"runId?": "string | undefined",
	threadId: "string",
	"view?": "'redacted' | 'original' | undefined",
});
const forgetSubjectInput = ark({ subjectId: "string" });
const runInput = ark({
	"ctx?": jsonObjectOrUndefined,
	"options?": runtimeRunOptionsOrUndefined,
	prompt: "string",
});
const continueRunInput = ark({
	approvalId: "string",
	"ctx?": jsonObjectOrUndefined,
	"options?": runtimeRunOptionsOrUndefined,
});
const grantApprovalInput = ark({ approvalId: "string", by: "string" });
const denyApprovalInput = ark({
	approvalId: "string",
	by: "string",
	"reason?": "string | undefined",
});
const listApprovalsInput = ark({
	"principal?": "string | undefined",
	"status?": approvalStatus.or("undefined"),
});
const startRunInput = ark({
	"ctx?": jsonObjectOrUndefined,
	prompt: "string",
	"run?": engineRunMetadataOrUndefined,
});
const continueEngineRunInput = ark({
	approvalId: "string",
	"ctx?": jsonObjectOrUndefined,
	"run?": engineRunMetadataOrUndefined,
});
const registerOpenApiSpecInput = ark({
	document: jsonObject,
	organizationId: "string",
	registeredBy: "string",
	source: "string",
});
const listRegisteredToolsInput = ark({
	organizationId: "string",
	"source?": "string | undefined",
});
const listActionsInput = ark({ organizationId: "string" });
const putPolicySliceInput = ark({
	cedar: "string",
	mode: "'enforce' | 'shadow' | 'off'",
	name: "string",
	organizationId: "string",
	updatedBy: "string",
});
const listPolicySlicesInput = ark({ organizationId: "string" });
const deletePolicySliceInput = ark({ organizationId: "string", id: "string" });
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
	run: runInput,
	sendMessage: sendMessageInput,
	startRun: startRunInput,
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
): ClawApiRouteDefinition<Method> {
	return {
		apiMethod: method,
		httpMethod: apiHttpMethod(method),
		path: apiMethodPath(method),
		inputSchema: clawApiInputSchemas[method],
	};
}

// Derives from the shared name list (NOT this package's schema-map keys), so the server route
// table and the remote client's call table come from the one contracts source by construction.
export const clawApiRoutes = Object.fromEntries(
	CLAW_API_METHOD_NAMES.map((method) => [method, apiRoute(method)]),
) as { readonly [Method in ClawApiMethod]: ClawApiRouteDefinition<Method> };

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
		async bindConversation(args) {
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
							// telegram id or a bot key: a stranger's conversation is created by
							// system:anonymous. The stranger (externalActorId) and the endpoint (provider/
							// endpointKey) are recorded on the binding row below, so nothing is lost for
							// erasure or routing — they are simply not creators.
							createdBy: args.claw?.createdBy ?? SYSTEM_ANONYMOUS,
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

		createClaw: (args) => store().claws.create(args),
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

		async sendMessage(args) {
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
			const result = await context.runtime.run(
				args.message,
				args.ctx as never,
				// A conversational message is a human at the other end → interactive.
				runtimeRunOptionsWithRecording(
					{ runMode: "interactive" },
					{
						clawId: args.clawId,
						runId,
						threadId: args.threadId,
						userMessageId: userMessage.id,
					},
				),
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

		run: ({ prompt, ctx, options }) => {
			assertNoReservedContext(ctx);
			return context.runtime.run(prompt, ctx as never, options);
		},
		async continueRun({ approvalId, ctx, options }) {
			assertNoReservedContext(ctx);
			const approval = await context.runtime.approvals?.get(approvalId);
			const recording = approval
				? recordingFromRuntimeApprovalMetadata(approval.metadata)
				: undefined;
			// A human just granted the approval → interactive (a caller may override explicitly).
			const continueOptions = {
				...options,
				runMode: options?.runMode ?? "interactive",
			} as const;
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

		grantApproval: ({ approvalId, by }) =>
			context.runtime.approvals?.grant(approvalId, by) ?? Promise.resolve(null),
		denyApproval: ({ approvalId, by, reason }) =>
			context.runtime.approvals?.deny(approvalId, by, reason) ??
			Promise.resolve(null),
		getApproval: ({ id }) =>
			context.runtime.approvals?.get(id) ?? Promise.resolve(null),
		listApprovals: (args) =>
			context.runtime.approvals?.list(args) ?? Promise.resolve([]),

		getEffect: ({ id }) => requireEffects(context.effects).get(id),

		registerOpenApiSpec: (args) =>
			createSpecRegistry(registry()).registerOpenApiSpec(args),
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

		putPolicySlice: (args) => registry().policySlices.upsert(args),
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
	} satisfies ClawApi;

	// The claws store is typed against the base claw contract, but at runtime it persists and returns
	// the host/plugin columns merged onto the claw model (see createClawsStore.additionalFields).
	// Re-present those through the config-derived claw types — the single seam between the base-typed
	// store and the config-shaped public api.
	return api as unknown as ClawApi<Config>;
}
