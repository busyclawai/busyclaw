import { type } from "arktype";
import { jsonObject } from "../common";
import { entity, field } from "../entity";

export const clawStatusValues = ["active", "paused", "archived"] as const;
export const threadStatusValues = ["active", "archived"] as const;
export const messageRoleValues = [
	"system",
	"user",
	"assistant",
	"tool",
	"summary",
] as const;
export const messageVisibilityValues = [
	"user",
	"internal",
	"audit-only",
] as const;
export const toolCallStatusValues = [
	"proposed",
	"waiting_approval",
	"running",
	"completed",
	"denied",
	"failed",
] as const;
export const toolResultStatusValues = ["completed", "failed"] as const;
export const toolResultOutputModeValues = ["none", "redacted", "full"] as const;
export const checkpointKindValues = [
	"step",
	"approval_wait",
	"compaction",
	"replay",
	"fork",
] as const;

export const clawStatus = type("'active' | 'paused' | 'archived'");
export const threadStatus = type("'active' | 'archived'");
export const messageRole = type(
	"'system' | 'user' | 'assistant' | 'tool' | 'summary'",
);
export const messageVisibility = type("'user' | 'internal' | 'audit-only'");
export const toolCallStatus = type(
	"'proposed' | 'waiting_approval' | 'running' | 'completed' | 'denied' | 'failed'",
);
export const toolResultStatus = type("'completed' | 'failed'");
export const toolResultOutputMode = type("'none' | 'redacted' | 'full'");
export const checkpointKind = type(
	"'step' | 'approval_wait' | 'compaction' | 'replay' | 'fork'",
);

export const clawFields = {
	id: field.string({ required: true, unique: true, immutable: true }),
	// A claw is a SHAREABLE agent resource. `createdBy` is immutable — who made it (accountability,
	// erasure attribution). The access boundary `(scope, scopeId)` is MUTABLE — a claw can be re-shared
	// over its life (created personal, promoted org-wide). `scope` is an OPAQUE string the core never
	// interprets ("personal"/"team"/"organization"/"global" mean nothing to core — the org plugin
	// interprets them, keeping core org-blind). Default at create: scope="personal", scopeId=createdBy.
	createdBy: field.principal({ required: true, index: true, immutable: true }),
	scope: field.string({ required: true, index: true }),
	scopeId: field.string({ required: true, index: true }),
	status: field.enum(clawStatusValues, { required: true }),
	name: field.string(),
	instructions: field.string({ pii: "possible" }),
	context: field.jsonObject({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true, input: false }),
} as const;

export const threadFields = {
	// A thread's access is its claw's — transitive via `clawId`, no own scope columns (same as
	// messages/tool_calls are descendants). Identity is fixed at create; only status and the message
	// cursor advance.
	id: field.string({ required: true, unique: true, immutable: true }),
	clawId: field.string({
		required: true,
		index: true,
		immutable: true,
		references: { model: "claw", field: "id" },
	}),
	title: field.string(),
	status: field.enum(threadStatusValues, { required: true }),
	currentMessageId: field.string(),
	currentSequence: field.number({ required: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const messageFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	runId: field.string({ index: true }),
	parentMessageId: field.string({ index: true }),
	sequence: field.number({ required: true, index: true }),
	role: field.enum(messageRoleValues, { required: true }),
	content: field.jsonValue({ required: true, pii: "redacted" }),
	visibility: field.enum(messageVisibilityValues, { required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const toolCallFields = {
	// A tool call's identity and inputs are fixed once proposed; only its progression (status →
	// approval → effect) changes. So everything but status/approvalId/effectId is immutable, and the
	// update patch derives to exactly those three.
	id: field.string({ required: true, unique: true, immutable: true }),
	clawId: field.string({
		required: true,
		index: true,
		immutable: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		immutable: true,
		references: { model: "thread", field: "id" },
	}),
	runId: field.string({ required: true, index: true, immutable: true }),
	assistantMessageId: field.string({ index: true, immutable: true }),
	toolCallId: field.string({ required: true, index: true, immutable: true }),
	toolName: field.string({ required: true, index: true, immutable: true }),
	args: field.jsonObject({ required: true, pii: "redacted", immutable: true }),
	status: field.enum(toolCallStatusValues, { required: true, index: true }),
	approvalId: field.string({ index: true }),
	effectId: field.string({ index: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true, input: false }),
} as const;

export const toolResultFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	runId: field.string({ required: true, index: true }),
	toolCallId: field.string({ required: true, index: true }),
	status: field.enum(toolResultStatusValues, { required: true }),
	output: field.jsonValue({ pii: "redacted" }),
	error: field.jsonObject({ pii: "redacted" }),
	outputMode: field.enum(toolResultOutputModeValues, { required: true }),
	createdAt: field.string({ required: true }),
} as const;

export const checkpointFields = {
	id: field.string({ required: true, unique: true }),
	runId: field.string({ required: true, index: true }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	parentCheckpointId: field.string({ index: true }),
	kind: field.enum(checkpointKindValues, { required: true, index: true }),
	step: field.number(),
	state: field.jsonObject({ required: true, pii: "redacted" }),
	messageCursor: field.number(),
	toolCallId: field.string({ index: true }),
	createdAt: field.string({ required: true }),
} as const;

export const conversationBindingFields = {
	// The account-table analog (better-auth keys accounts by providerId + accountId, with no organization in
	// the key): the BOT scopes external conversation ids — telegram DM chat ids repeat across bots — so
	// the natural key is (provider, endpointKey, externalConversationId). Whose data a conversation is
	// lives on the claw the binding points at (its createdBy/scope), not here.
	id: field.string({ required: true, unique: true }),
	provider: field.string({ required: true, index: true }),
	endpointKey: field.string({ required: true, index: true }),
	// External identifiers are pseudonymous personal data (a chat/user id addresses a person), and
	// metadata carries whatever the ingress adapter stuffs in — so retention/erasure must be able to
	// sweep them. `possible` marks them without transforming the stored value.
	externalConversationId: field.string({
		required: true,
		index: true,
		pii: "possible",
	}),
	externalActorId: field.string({ index: true, pii: "possible" }),
	clawId: field.string({
		required: true,
		index: true,
		references: { model: "claw", field: "id" },
	}),
	threadId: field.string({
		required: true,
		index: true,
		references: { model: "thread", field: "id" },
	}),
	metadata: field.jsonObject({ pii: "possible" }),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const clawEntity = entity("claw", clawFields);
export const threadEntity = entity("thread", threadFields);
export const messageEntity = entity("message", messageFields);
export const toolCallEntity = entity("tool_call", toolCallFields);
export const toolResultEntity = entity("tool_result", toolResultFields);
export const checkpointEntity = entity("checkpoint", checkpointFields);
export const conversationBindingEntity = entity(
	"conversation_binding",
	conversationBindingFields,
);

export const clawRecord = clawEntity.record;
export const threadRecord = threadEntity.record;
export const messageRecord = messageEntity.record;
export const toolCallRecord = toolCallEntity.record;
export const toolResultRecord = toolResultEntity.record;
export const checkpointRecord = checkpointEntity.record;
export const conversationBindingRecord = conversationBindingEntity.record;

export const createClawInputOptions = {
	omit: ["status", "createdAt", "updatedAt"],
	// scope/scopeId default in the store (scope="personal", scopeId=createdBy) — a claw is personal to
	// its creator until re-shared; `createdBy` is required (a claw always has a creator).
	optional: ["id", "context", "scope", "scopeId"],
} as const;
export const createClawInput = clawEntity.schema(createClawInputOptions);

export const createThreadInputOptions = {
	omit: [
		"status",
		"currentMessageId",
		"currentSequence",
		"createdAt",
		"updatedAt",
	],
	optional: ["id"],
} as const;
export const createThreadInput = threadEntity.schema(createThreadInputOptions);

export const appendMessageInputOptions = {
	omit: ["createdAt"],
	optional: ["id", "sequence", "visibility"],
} as const;
export const appendMessageInput = messageEntity.schema(
	appendMessageInputOptions,
);

export const createToolCallInputOptions = {
	omit: ["createdAt", "updatedAt"],
	optional: ["id", "status"],
} as const;
export const createToolCallInput = toolCallEntity.schema(
	createToolCallInputOptions,
);

export const createToolResultInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createToolResultInput = toolResultEntity.schema(
	createToolResultInputOptions,
);

export const createCheckpointInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createCheckpointInput = checkpointEntity.schema(
	createCheckpointInputOptions,
);

export const createConversationBindingInputOptions = {
	omit: ["createdAt", "updatedAt"],
	optional: ["id"],
} as const;
export const createConversationBindingInput = conversationBindingEntity.schema(
	createConversationBindingInputOptions,
);

// ── the bindConversation protocol (the account-linking analog) ───────────────────────────────────
// Protocol, not product: these derive purely from the entities above, so they live here — channel
// plugins validate against them without depending on the euroclaw assembly.

// Claw bind defaults are claw-creation input with `createdBy` OPTIONAL: bindConversation fills the
// creator at bind time — always a real principal, defaulting to system:anonymous for an
// unauthenticated (stranger's) conversation (the external actor + endpoint stay on the binding row,
// never masquerading as the creator) — so endpoint/registration defaults never carry it. They
// describe placement (scope/scopeId) and naming, not who created the claw. Tenancy is optional
// placement data, never part of the binding's identity. (claws.create still REQUIRES createdBy — a
// stored claw always has a creator.)
export const bindConversationClawInputOptions = {
	omit: ["status", "createdAt", "updatedAt"],
	optional: ["id", "context", "scope", "scopeId", "createdBy"],
} as const;
export const bindConversationClawInput = clawEntity.schema(
	bindConversationClawInputOptions,
);

export const bindConversationThreadInputOptions = {
	omit: [
		"clawId",
		"status",
		"currentMessageId",
		"currentSequence",
		"createdAt",
		"updatedAt",
	],
	optional: ["id"],
} as const;
export const bindConversationThreadInput = threadEntity.schema(
	bindConversationThreadInputOptions,
);

export const bindConversationInput = type({
	"claw?": bindConversationClawInput.or("undefined"),
	"clawId?": "string | undefined",
	// Which ingress the conversation arrived on — required and explicit: it is part of the binding's
	// identity, and a silently defaulted key would invite cross-endpoint collisions.
	endpointKey: "string",
	"externalActorId?": "string | undefined",
	externalConversationId: "string",
	"metadata?": jsonObject.or("undefined"),
	provider: "string",
	"thread?": bindConversationThreadInput.or("undefined"),
	"threadId?": "string | undefined",
});

export const bindConversationResult = type({
	binding: conversationBindingRecord,
	claw: clawRecord,
	created: "boolean",
	thread: threadRecord,
});

export const clawsSchema = {
	...clawEntity.storage,
	...threadEntity.storage,
	...messageEntity.storage,
	...toolCallEntity.storage,
	...toolResultEntity.storage,
	...checkpointEntity.storage,
	...conversationBindingEntity.storage,
};
