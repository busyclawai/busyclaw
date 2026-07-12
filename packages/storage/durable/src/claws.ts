import type { Adapter } from "@euroclaw/contracts";
import {
	type AppendMessageInput,
	appendMessageInput,
	type ClawsStore,
	type CreateCheckpointInput,
	type CreateConversationBindingInput,
	type CreateThreadInput,
	type CreateToolCallInput,
	type CreateToolResultInput,
	checkpointFields,
	clawFields,
	configurationError,
	conversationBindingFields,
	createCheckpointInput,
	createClawInputOptions,
	createConversationBindingInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	type EntityField,
	entity,
	messageFields,
	stateError,
	threadFields,
	toolCallFields,
	toolResultFields,
	validationError,
} from "@euroclaw/contracts";
import { type EntityWhere, entityDb } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

export type ClawsStoreOptions = {
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
	/**
	 * Extra fields to merge onto a default model's schema — the host's `additionalFields` plus every
	 * plugin's `schema`. The store rebuilds that model's entity/validators + storage from the merged
	 * field map, so the extra columns are persisted, validated, and returned. Keyed by model name.
	 */
	additionalFields?: { readonly claw?: Record<string, EntityField> };
};

const newId = (): string => bytesToHex(randomBytes(16));

function assertCreateThreadInput(input: unknown): CreateThreadInput {
	const valid = createThreadInput(input);
	if (valid instanceof type.errors) {
		throw validationError("create thread input invalid", valid.summary);
	}
	return valid;
}

function assertAppendMessageInput(input: unknown): AppendMessageInput {
	const valid = appendMessageInput(input);
	if (valid instanceof type.errors) {
		throw validationError("append message input invalid", valid.summary);
	}
	return valid;
}

function assertCreateToolCallInput(input: unknown): CreateToolCallInput {
	const valid = createToolCallInput(input);
	if (valid instanceof type.errors) {
		throw validationError("create tool call input invalid", valid.summary);
	}
	return valid;
}

function assertCreateToolResultInput(input: unknown): CreateToolResultInput {
	const valid = createToolResultInput(input);
	if (valid instanceof type.errors) {
		throw validationError("create tool result input invalid", valid.summary);
	}
	return valid;
}

function assertCreateCheckpointInput(input: unknown): CreateCheckpointInput {
	const valid = createCheckpointInput(input);
	if (valid instanceof type.errors) {
		throw validationError("create checkpoint input invalid", valid.summary);
	}
	return valid;
}

function assertCreateConversationBindingInput(
	input: unknown,
): CreateConversationBindingInput {
	const valid = createConversationBindingInput(input);
	if (valid instanceof type.errors) {
		throw validationError(
			"create conversation binding input invalid",
			valid.summary,
		);
	}
	return valid;
}

export function createClawsStore(
	adapter: Adapter,
	options: ClawsStoreOptions = {},
): ClawsStore {
	const now = options.now ?? (() => new Date().toISOString());

	// Merge host/plugin extra fields onto the claw model — the merged map drives the claw entity's
	// validators + storage inside the entity layer, so extra columns are persisted, validated, and
	// returned. With no extras this is exactly the default claw entity. Other models keep their
	// fixed schema until they're opened up too.
	const clawFieldsMerged = {
		...clawFields,
		...(options.additionalFields?.claw ?? {}),
	};
	// Persistence goes through `entityDb`: the model name drives the row types, and every row
	// crossing the adapter boundary is parsed against its record schema — the store validates
	// INPUTS and lets the entity layer own the rows.
	const db = entityDb(adapter, {
		claw: { fields: clawFieldsMerged },
		thread: { fields: threadFields },
		message: { fields: messageFields },
		tool_call: { fields: toolCallFields },
		tool_result: { fields: toolResultFields },
		checkpoint: { fields: checkpointFields },
		conversation_binding: { fields: conversationBindingFields },
	});
	// The merged create-input schema still validates host/plugin extra fields at the create boundary
	// (the entity layer's write validation covers the assembled record; this covers the caller input).
	const createClawInputMerged = entity("claw", clawFieldsMerged).schema(
		createClawInputOptions,
	);
	const assertCreateClawInput = (input: unknown) => {
		const valid = createClawInputMerged(input);
		if (valid instanceof type.errors) {
			throw validationError("create claw input invalid", valid.summary);
		}
		return valid;
	};

	return {
		claws: {
			async create(input) {
				const valid = assertCreateClawInput(input);
				const ts = now();
				// `...valid` carries the merged input — base fields AND any host/plugin extra fields —
				// then the explicit keys set the server-owned defaults (id, status, timestamps).
				return db.create({
					model: "claw",
					data: {
						...valid,
						id: valid.id ?? newId(),
						// A claw is personal to its creator until re-shared (scope is mutable).
						scope: valid.scope ?? "personal",
						scopeId: valid.scopeId ?? valid.createdBy,
						status: "active",
						context: valid.context ?? {},
						createdAt: ts,
						updatedAt: ts,
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "claw",
					where: [{ field: "id", value: id }],
				});
			},

			async update(id, patch) {
				// The entity layer drops undefined fields and read-validates the result; the store
				// owns updatedAt (the caller can't set it — it's input:false).
				return db.update({
					model: "claw",
					where: [{ field: "id", value: id }],
					update: { ...patch, updatedAt: now() },
				});
			},

			archive(id) {
				return this.update(id, {
					status: "archived",
				});
			},
		},

		threads: {
			async create(input) {
				const valid = assertCreateThreadInput(input);
				const ts = now();
				return db.create({
					model: "thread",
					data: {
						...valid,
						id: valid.id ?? newId(),
						status: "active",
						currentSequence: 0,
						createdAt: ts,
						updatedAt: ts,
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "thread",
					where: [{ field: "id", value: id }],
				});
			},

			listForClaw(clawId) {
				return db.findMany({
					model: "thread",
					where: [{ field: "clawId", value: clawId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			archive(id) {
				return db.update({
					model: "thread",
					where: [{ field: "id", value: id }],
					update: { status: "archived", updatedAt: now() },
				});
			},
		},

		messages: {
			async append(input) {
				const valid = assertAppendMessageInput(input);
				if (!adapter.transaction) {
					throw configurationError(
						"ClawsStore message append requires a transactional adapter",
						{ adapter: adapter.id },
					);
				}

				return adapter.transaction(async (tx) => {
					const txDb = entityDb(tx, {
						thread: { fields: threadFields },
						message: { fields: messageFields },
					});
					const thread = await txDb.findOne({
						model: "thread",
						where: [{ field: "id", value: valid.threadId }],
					});
					if (!thread) {
						throw stateError("thread not found", { threadId: valid.threadId });
					}
					if (thread.clawId !== valid.clawId) {
						throw validationError(
							"append message input invalid",
							"clawId does not match thread",
							{ clawId: valid.clawId, threadClawId: thread.clawId },
						);
					}

					const sequence = valid.sequence ?? thread.currentSequence + 1;
					if (sequence !== thread.currentSequence + 1) {
						throw validationError(
							"append message input invalid",
							"must append at current thread cursor",
							{
								currentSequence: thread.currentSequence,
								sequence,
							},
						);
					}

					const ts = now();
					const record = await txDb.create({
						model: "message",
						data: {
							...valid,
							id: valid.id ?? newId(),
							parentMessageId: valid.parentMessageId ?? thread.currentMessageId,
							sequence,
							visibility: valid.visibility ?? "user",
							createdAt: ts,
						},
					});
					const updatedThread = await txDb.update({
						model: "thread",
						where: [
							{ field: "id", value: valid.threadId },
							{
								field: "currentSequence",
								value: thread.currentSequence,
								connector: "AND",
							},
						],
						update: {
							currentMessageId: record.id,
							currentSequence: sequence,
							updatedAt: ts,
						},
					});
					if (!updatedThread) {
						throw stateError("thread cursor changed during append", {
							threadId: valid.threadId,
						});
					}
					return record;
				});
			},

			get(id) {
				return db.findOne({
					model: "message",
					where: [{ field: "id", value: id }],
				});
			},

			listForThread(input) {
				const where: EntityWhere<typeof messageFields>[] = [
					{ field: "threadId", value: input.threadId },
				];
				if (input.afterSequence !== undefined) {
					where.push({
						field: "sequence",
						operator: "gt",
						value: input.afterSequence,
						connector: "AND",
					});
				}
				return db.findMany({
					model: "message",
					where,
					limit: input.limit,
					sortBy: { field: "sequence", direction: "asc" },
				});
			},
		},

		toolCalls: {
			async create(input) {
				const valid = assertCreateToolCallInput(input);
				const ts = now();
				return db.create({
					model: "tool_call",
					data: {
						...valid,
						id: valid.id ?? newId(),
						status: valid.status ?? "proposed",
						createdAt: ts,
						updatedAt: ts,
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "tool_call",
					where: [{ field: "id", value: id }],
				});
			},

			getByToolCallId(input) {
				return db.findOne({
					model: "tool_call",
					where: [
						{ field: "runId", value: input.runId },
						{
							field: "toolCallId",
							value: input.toolCallId,
							connector: "AND",
						},
					],
				});
			},

			async updateStatus(id, patch) {
				return db.update({
					model: "tool_call",
					where: [{ field: "id", value: id }],
					update: { ...patch, updatedAt: now() },
				});
			},
		},

		toolResults: {
			async create(input) {
				const valid = assertCreateToolResultInput(input);
				return db.create({
					model: "tool_result",
					data: {
						...valid,
						id: valid.id ?? newId(),
						createdAt: now(),
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "tool_result",
					where: [{ field: "id", value: id }],
				});
			},

			listForToolCall(input) {
				return db.findMany({
					model: "tool_result",
					where: [
						{ field: "runId", value: input.runId },
						{
							field: "toolCallId",
							value: input.toolCallId,
							connector: "AND",
						},
					],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},

		checkpoints: {
			async create(input) {
				const valid = assertCreateCheckpointInput(input);
				return db.create({
					model: "checkpoint",
					data: {
						...valid,
						id: valid.id ?? newId(),
						createdAt: now(),
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "checkpoint",
					where: [{ field: "id", value: id }],
				});
			},

			async latestForRun(runId) {
				const [latest] = await db.findMany({
					model: "checkpoint",
					where: [{ field: "runId", value: runId }],
					limit: 1,
					sortBy: { field: "createdAt", direction: "desc" },
				});
				return latest ?? null;
			},
		},

		conversationBindings: {
			async create(input) {
				const valid = assertCreateConversationBindingInput(input);
				const ts = now();
				return db.create({
					model: "conversation_binding",
					data: {
						...valid,
						id: valid.id ?? newId(),
						createdAt: ts,
						updatedAt: ts,
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "conversation_binding",
					where: [{ field: "id", value: id }],
				});
			},

			getByExternal(input) {
				return db.findOne({
					model: "conversation_binding",
					where: [
						{ field: "provider", value: input.provider },
						{
							field: "endpointKey",
							value: input.endpointKey,
							connector: "AND",
						},
						{
							field: "externalConversationId",
							value: input.externalConversationId,
							connector: "AND",
						},
					],
				});
			},

			listForThread(threadId) {
				return db.findMany({
					model: "conversation_binding",
					where: [{ field: "threadId", value: threadId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},
	};
}
