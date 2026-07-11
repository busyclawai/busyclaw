import type {
	EntityRecord,
	EntitySchemaInput,
	EntityUpdateInput,
} from "../entity";
import type {
	appendMessageInputOptions,
	bindConversationInput,
	bindConversationResult,
	bindConversationClawInputOptions,
	bindConversationThreadInputOptions,
	checkpointFields,
	checkpointKindValues,
	clawFields,
	clawStatusValues,
	conversationBindingFields,
	createCheckpointInputOptions,
	createClawInputOptions,
	createConversationBindingInputOptions,
	createThreadInputOptions,
	createToolCallInputOptions,
	createToolResultInputOptions,
	messageFields,
	messageRoleValues,
	messageVisibilityValues,
	threadFields,
	threadStatusValues,
	toolCallFields,
	toolCallStatusValues,
	toolResultFields,
	toolResultOutputModeValues,
	toolResultStatusValues,
} from "./schema";

export type ClawStatus = (typeof clawStatusValues)[number];
export type ThreadStatus = (typeof threadStatusValues)[number];
export type MessageRole = (typeof messageRoleValues)[number];
export type MessageVisibility = (typeof messageVisibilityValues)[number];
export type ToolCallStatus = (typeof toolCallStatusValues)[number];
export type ToolResultStatus = (typeof toolResultStatusValues)[number];
export type ToolResultOutputMode = (typeof toolResultOutputModeValues)[number];
export type CheckpointKind = (typeof checkpointKindValues)[number];

export type ClawRecord = EntityRecord<typeof clawFields>;
export type ThreadRecord = EntityRecord<typeof threadFields>;
export type MessageRecord = EntityRecord<typeof messageFields>;
export type ToolCallRecord = EntityRecord<typeof toolCallFields>;
export type ToolResultRecord = EntityRecord<typeof toolResultFields>;
export type CheckpointRecord = EntityRecord<typeof checkpointFields>;
export type ConversationBindingRecord = EntityRecord<
	typeof conversationBindingFields
>;

export type CreateClawInput = EntitySchemaInput<
	typeof clawFields,
	typeof createClawInputOptions
>;
export type CreateThreadInput = EntitySchemaInput<
	typeof threadFields,
	typeof createThreadInputOptions
>;
export type AppendMessageInput = EntitySchemaInput<
	typeof messageFields,
	typeof appendMessageInputOptions
>;
export type CreateToolCallInput = EntitySchemaInput<
	typeof toolCallFields,
	typeof createToolCallInputOptions
>;
export type CreateToolResultInput = EntitySchemaInput<
	typeof toolResultFields,
	typeof createToolResultInputOptions
>;
export type CreateCheckpointInput = EntitySchemaInput<
	typeof checkpointFields,
	typeof createCheckpointInputOptions
>;
export type CreateConversationBindingInput = EntitySchemaInput<
	typeof conversationBindingFields,
	typeof createConversationBindingInputOptions
>;

export type UpdateClawInput = EntityUpdateInput<typeof clawFields>;

export type ToolCallStatusPatch = EntityUpdateInput<typeof toolCallFields>;

export type ClawStore = {
	create: (input: CreateClawInput) => Promise<ClawRecord>;
	get: (id: string) => Promise<ClawRecord | null>;
	update: (id: string, patch: UpdateClawInput) => Promise<ClawRecord | null>;
	archive: (id: string) => Promise<ClawRecord | null>;
};

export type ThreadStore = {
	create: (input: CreateThreadInput) => Promise<ThreadRecord>;
	get: (id: string) => Promise<ThreadRecord | null>;
	listForClaw: (clawId: string) => Promise<ThreadRecord[]>;
	archive: (id: string) => Promise<ThreadRecord | null>;
};

export type MessageStore = {
	append: (input: AppendMessageInput) => Promise<MessageRecord>;
	get: (id: string) => Promise<MessageRecord | null>;
	listForThread: (input: {
		threadId: string;
		afterSequence?: number;
		limit?: number;
	}) => Promise<MessageRecord[]>;
};

export type ToolCallStore = {
	create: (input: CreateToolCallInput) => Promise<ToolCallRecord>;
	get: (id: string) => Promise<ToolCallRecord | null>;
	getByToolCallId: (input: {
		runId: string;
		toolCallId: string;
	}) => Promise<ToolCallRecord | null>;
	updateStatus: (
		id: string,
		patch: ToolCallStatusPatch,
	) => Promise<ToolCallRecord | null>;
};

export type ToolResultStore = {
	create: (input: CreateToolResultInput) => Promise<ToolResultRecord>;
	get: (id: string) => Promise<ToolResultRecord | null>;
	listForToolCall: (input: {
		runId: string;
		toolCallId: string;
	}) => Promise<ToolResultRecord[]>;
};

export type CheckpointStore = {
	create: (input: CreateCheckpointInput) => Promise<CheckpointRecord>;
	get: (id: string) => Promise<CheckpointRecord | null>;
	latestForRun: (runId: string) => Promise<CheckpointRecord | null>;
};

export type ConversationBindingLookup = {
	provider: string;
	endpointKey: string;
	externalConversationId: string;
};

// ── bindConversation protocol types ───────────────────────────────────────────────────────────────
/** Claw bind defaults are claw-creation input with `createdBy` optional — see bindConversationClawInput in schema. */
export type BindConversationClawInput = EntitySchemaInput<
	typeof clawFields,
	typeof bindConversationClawInputOptions
>;
export type BindConversationThreadInput = EntitySchemaInput<
	typeof threadFields,
	typeof bindConversationThreadInputOptions
>;

type BindConversationInputFromSchema = typeof bindConversationInput.infer;
export type BindConversationInput = Omit<
	BindConversationInputFromSchema,
	"claw" | "thread"
> & {
	claw?: BindConversationClawInput;
	thread?: BindConversationThreadInput;
};

type BindConversationResultFromSchema = typeof bindConversationResult.infer;
export type BindConversationResult = Omit<
	BindConversationResultFromSchema,
	"binding" | "claw" | "thread"
> & {
	binding: ConversationBindingRecord;
	claw: ClawRecord;
	thread: ThreadRecord;
};

export type ConversationBindingStore = {
	create: (
		input: CreateConversationBindingInput,
	) => Promise<ConversationBindingRecord>;
	get: (id: string) => Promise<ConversationBindingRecord | null>;
	getByExternal: (
		input: ConversationBindingLookup,
	) => Promise<ConversationBindingRecord | null>;
	listForThread: (threadId: string) => Promise<ConversationBindingRecord[]>;
};

export type ClawsStore = {
	claws: ClawStore;
	threads: ThreadStore;
	messages: MessageStore;
	toolCalls: ToolCallStore;
	toolResults: ToolResultStore;
	checkpoints: CheckpointStore;
	conversationBindings: ConversationBindingStore;
};
