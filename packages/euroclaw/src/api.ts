import type {
	AppendMessageInput,
	ApprovalRecord,
	ApprovalStatus,
	BindConversationInput,
	BindConversationResult,
	CheckpointRecord,
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
	RegisteredToolRecord,
	SecretAliasRecord,
	SecretAliasStore,
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
	clawEntity,
	configurationError,
	createCheckpointInput,
	createClawInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	jsonObject,
	RESERVED_CONTEXT_PREFIX,
	stateError,
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
import { type ActionView, assembleOrgActions } from "./registry";

export type ClawSendInput<Config extends RuntimeConfig = RuntimeConfig> = {
	clawId: string;
	threadId: string;
	message: string;
	ctx?: RunContext<Config>;
	runId?: string;
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
	/** The one-door reader (env + inline chain + DB-wins layer) — `claw.api.secrets.list` reads it to
	 *  tell "inline" from "missing". */
	readonly secrets?: Secrets;
	/** The per-org alias store — present ONLY when `dynamicSecretAliases.enabled` (backs
	 *  `claw.api.secrets`; absent ⇒ the admin methods fail loud). */
	readonly secretAliases?: SecretAliasStore;
	/** The collected required-secret-name declarations across plugins (`claw.api.secrets.list`). */
	readonly secretDeclarations?: readonly SecretDeclaration[];
};

/** One required-secret row `claw.api.secrets.list()` returns. `status`: `configured` = a per-org DB
 *  alias points at it; `inline` = resolvable via an inline provider alias or a direct provider value;
 *  `missing` = resolves nowhere (set an alias or the env var). */
export type SecretStatus = "configured" | "inline" | "missing";
export type SecretListEntry = {
	name: string;
	description?: string;
	status: SecretStatus;
	alias?: { provider: string; ref: string };
};

/** The `claw.api.secrets` admin namespace — available ONLY when `dynamicSecretAliases.enabled` (the
 *  methods fail loud otherwise). Org-scoped; the host authorizes WHO may call it (the `secret_alias`
 *  row is pointer-only, so it carries no actor column). */
export type ClawSecretsApi = {
	list: (input: { organizationId: string }) => Promise<SecretListEntry[]>;
	setAlias: (input: {
		organizationId: string;
		name: string;
		provider: string;
		ref: string;
	}) => Promise<SecretAliasRecord>;
	deleteAlias: (input: {
		organizationId: string;
		name: string;
	}) => Promise<void>;
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
	}) => Promise<MessageRecord[]>;
	sendMessage: (input: ClawSendInput<Config>) => Promise<ClawSendResult>;

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
		actor?: string;
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

	// Per-org secret aliases (opt-in): list the required names + their status, and manage the
	// pointer-only `(org, name) → { provider, ref }` alias rows. A NESTED namespace (`claw.api.secrets.
	// list()`), so it is excluded from the flat method→route machinery below (ClawApiMethod); the host
	// wires it to its own frontend HTTP layer. Fails loud unless `dynamicSecretAliases.enabled`.
	readonly secrets: ClawSecretsApi;
};

/** The FLAT api methods — the ones the method→route machinery maps. Excludes the nested `secrets`
 *  namespace (it is not a single callable route). */
export type ClawApiMethod = keyof Omit<ClawApi, "secrets">;
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
	"actor?": "string | undefined",
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
});
const sendMessageInput = ark({
	clawId: "string",
	"ctx?": jsonObjectOrUndefined,
	message: "string",
	"runId?": "string | undefined",
	threadId: "string",
});
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
	"actor?": "string | undefined",
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
} satisfies { readonly [Method in ClawApiMethod]: ClawApiInputSchema };

function apiMethodPath(method: ClawApiMethod): `/${string}` {
	return `/${method.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

function apiHttpMethod(method: ClawApiMethod): ClawApiHttpMethod {
	return method.startsWith("get") || method.startsWith("list") ? "GET" : "POST";
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

export const clawApiRoutes = Object.fromEntries(
	(Object.keys(clawApiInputSchemas) as ClawApiMethod[]).map((method) => [
		method,
		apiRoute(method),
	]),
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

function requireSecretAliases(
	store: SecretAliasStore | undefined,
): SecretAliasStore {
	if (!store) {
		throw configurationError(
			"claw.api.secrets requires dynamicSecretAliases enabled with a database",
			{
				reason:
					"set dynamicSecretAliases: { enabled: true } and pass a database to createClaw, then run the migration",
			},
		);
	}
	return store;
}

/** A registered spec needs a credential (named after its registration `source` — how the invoker
 *  keys tool credentials) iff some operation declares a non-empty security requirement. The binding
 *  is opaque JSON, so we peek `.security` structurally (a `[{}]`/`[]` alternative means public). */
function bindingNeedsCredential(binding: unknown): boolean {
	if (binding === null || typeof binding !== "object") return false;
	const security = (binding as { security?: unknown }).security;
	if (!Array.isArray(security)) return false;
	return security.some(
		(requirement) =>
			requirement !== null &&
			typeof requirement === "object" &&
			Object.keys(requirement).length > 0,
	);
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
			// A fresh binding creates a claw whose creator is the external actor; it defaults to
			// personal scope (see claws.create). Binding an existing claw/thread makes that claw the
			// source of truth.
			const claw = args.clawId
				? await requireClawRecord(clawsStore, args.clawId)
				: existingThread
					? await requireClawRecord(clawsStore, existingThread.clawId)
					: await clawsStore.claws.create({
							...args.claw,
							// The external user is the creator; fall back to the bot endpoint when the
							// conversation carries no actor (createdBy is required — a claw has a creator).
							createdBy:
								args.claw?.createdBy ??
								args.externalActorId ??
								args.endpointKey,
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

		appendMessage: (args) => store().messages.append(args),
		getMessage: ({ id }) => store().messages.get(id),
		listMessages: (args) => store().messages.listForThread(args),

		async sendMessage(args) {
			assertNoReservedContext(args.ctx);
			const clawsStore = store();
			const runId = args.runId ?? newId("run");
			const userMessage = await clawsStore.messages.append({
				clawId: args.clawId,
				content: { text: args.message },
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
			return { result, userMessage };
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

		secrets: {
			async list({ organizationId }) {
				const store = requireSecretAliases(context.secretAliases);
				// Required names = plugin declarations (with descriptions) ∪ the org's registered-spec
				// credential names (sources of secured specs). First-seen wins the description.
				const required = new Map<string, string | undefined>();
				for (const declaration of context.secretDeclarations ?? []) {
					if (!required.has(declaration.name)) {
						required.set(declaration.name, declaration.description);
					}
				}
				if (context.registry) {
					const rows =
						await context.registry.registeredTools.listByOrganization(
							organizationId,
						);
					for (const row of rows) {
						if (
							bindingNeedsCredential(row.binding) &&
							!required.has(row.source)
						) {
							required.set(row.source, undefined);
						}
					}
				}
				const entries: SecretListEntry[] = [];
				for (const [name, description] of required) {
					const alias = await store.get(organizationId, name);
					// "inline" is probed WITHOUT org (DB layer skipped) — a DB alias is the "configured"
					// case above; here we only ask whether the inline chain / direct provider resolves it.
					const status: SecretStatus = alias
						? "configured"
						: (await context.secrets?.has(name))
							? "inline"
							: "missing";
					entries.push({
						name,
						...(description !== undefined ? { description } : {}),
						status,
						...(alias
							? { alias: { provider: alias.provider, ref: alias.ref } }
							: {}),
					});
				}
				return entries;
			},
			// async so the disabled-guard configurationError is a REJECTION (not a sync throw), uniform
			// with `list` above.
			async setAlias({ organizationId, name, provider, ref }) {
				return requireSecretAliases(context.secretAliases).set(
					organizationId,
					name,
					{ provider, ref },
				);
			},
			async deleteAlias({ organizationId, name }) {
				return requireSecretAliases(context.secretAliases).delete(
					organizationId,
					name,
				);
			},
		},
	} satisfies ClawApi;

	// The claws store is typed against the base claw contract, but at runtime it persists and returns
	// the host/plugin columns merged onto the claw model (see createClawsStore.additionalFields).
	// Re-present those through the config-derived claw types — the single seam between the base-typed
	// store and the config-shaped public api.
	return api as unknown as ClawApi<Config>;
}
