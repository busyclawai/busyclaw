import type { Adapter, Where } from "@euroclaw/contracts";
import {
	type AppendMessageInput,
	appendMessageInput,
	type CheckpointRecord,
	type ClawRecord,
	type ClawsStore,
	type ConversationBindingRecord,
	type CreateCheckpointInput,
	type CreateConversationBindingInput,
	type CreateThreadInput,
	type CreateToolCallInput,
	type CreateToolResultInput,
	checkpointRecord,
	clawFields,
	clawsSchema,
	configurationError,
	conversationBindingRecord,
	createCheckpointInput,
	createClawInputOptions,
	createConversationBindingInput,
	createThreadInput,
	createToolCallInput,
	createToolResultInput,
	type EntityField,
	entity,
	type MessageRecord,
	messageRecord,
	stateError,
	type ThreadRecord,
	type ToolCallRecord,
	type ToolResultRecord,
	threadRecord,
	toolCallRecord,
	toolResultRecord,
	validationError,
} from "@euroclaw/contracts";
import { schemaAdapter } from "@euroclaw/storage-core";
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

function assertThreadRecord(input: unknown): ThreadRecord {
	const valid = threadRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("thread record invalid", valid.summary);
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

function assertMessageRecord(input: unknown): MessageRecord {
	const valid = messageRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("message record invalid", valid.summary);
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

function assertToolCallRecord(input: unknown): ToolCallRecord {
	const valid = toolCallRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("tool call record invalid", valid.summary);
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

function assertToolResultRecord(input: unknown): ToolResultRecord {
	const valid = toolResultRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("tool result record invalid", valid.summary);
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

function assertCheckpointRecord(input: unknown): CheckpointRecord {
	const valid = checkpointRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("checkpoint record invalid", valid.summary);
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

function assertConversationBindingRecord(
	input: unknown,
): ConversationBindingRecord {
	const valid = conversationBindingRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("conversation binding record invalid", valid.summary);
	}
	return valid;
}

export function createClawsStore(
	adapter: Adapter,
	options: ClawsStoreOptions = {},
): ClawsStore {
	const now = options.now ?? (() => new Date().toISOString());

	// Merge host/plugin extra fields onto the claw model and rebuild its validators + storage schema,
	// so the extra columns round-trip. With no extras this is exactly the default claw entity. Other
	// models keep their fixed schema until they're opened up too.
	const clawEntityMerged = entity("claw", {
		...clawFields,
		...(options.additionalFields?.claw ?? {}),
	});
	const db = schemaAdapter(adapter, {
		...clawsSchema,
		...clawEntityMerged.storage,
	});
	const createClawInputMerged = clawEntityMerged.schema(createClawInputOptions);
	const assertClawRecord = (input: unknown) => {
		const valid = clawEntityMerged.record(input);
		if (valid instanceof type.errors) {
			throw validationError("claw record invalid", valid.summary);
		}
		return valid;
	};
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
				const record = assertClawRecord({
					...valid,
					id: valid.id ?? newId(),
					// A claw is personal to its creator until re-shared (scope is mutable).
					scope: valid.scope ?? "personal",
					scopeId: valid.scopeId ?? valid.createdBy,
					status: "active",
					context: valid.context ?? {},
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "claw", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ClawRecord>({
					model: "claw",
					where: [{ field: "id", value: id }],
				});
			},

			async update(id, patch) {
				// schemaAdapter drops undefined fields, so the patch flows straight through; the store
				// owns updatedAt (the caller can't set it — it's input:false).
				const row = await db.update<ClawRecord>({
					model: "claw",
					where: [{ field: "id", value: id }],
					update: { ...patch, updatedAt: now() },
				});
				return row ? assertClawRecord(row) : null;
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
				const record = assertThreadRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					title: valid.title,
					status: "active",
					currentSequence: 0,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "thread", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ThreadRecord>({
					model: "thread",
					where: [{ field: "id", value: id }],
				});
			},

			listForClaw(clawId) {
				return db.findMany<ThreadRecord>({
					model: "thread",
					where: [{ field: "clawId", value: clawId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			archive(id) {
				return db.update<ThreadRecord>({
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
					const txDb = schemaAdapter(tx, clawsSchema);
					const thread = await txDb.findOne<ThreadRecord>({
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
					const record = assertMessageRecord({
						id: valid.id ?? newId(),
						clawId: valid.clawId,
						threadId: valid.threadId,
						runId: valid.runId,
						parentMessageId: valid.parentMessageId ?? thread.currentMessageId,
						sequence,
						role: valid.role,
						content: valid.content,
						visibility: valid.visibility ?? "user",
						createdAt: ts,
					});

					await txDb.create({ model: "message", data: record });
					const updatedThread = await txDb.update<ThreadRecord>({
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
				return db.findOne<MessageRecord>({
					model: "message",
					where: [{ field: "id", value: id }],
				});
			},

			listForThread(input) {
				const where: Where[] = [{ field: "threadId", value: input.threadId }];
				if (input.afterSequence !== undefined) {
					where.push({
						field: "sequence",
						operator: "gt",
						value: input.afterSequence,
						connector: "AND",
					});
				}
				return db.findMany<MessageRecord>({
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
				const record = assertToolCallRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					threadId: valid.threadId,
					runId: valid.runId,
					assistantMessageId: valid.assistantMessageId,
					toolCallId: valid.toolCallId,
					toolName: valid.toolName,
					args: valid.args,
					status: valid.status ?? "proposed",
					approvalId: valid.approvalId,
					effectId: valid.effectId,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "tool_call", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ToolCallRecord>({
					model: "tool_call",
					where: [{ field: "id", value: id }],
				});
			},

			getByToolCallId(input) {
				return db.findOne<ToolCallRecord>({
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
				const row = await db.update<ToolCallRecord>({
					model: "tool_call",
					where: [{ field: "id", value: id }],
					update: { ...patch, updatedAt: now() },
				});
				return row ? assertToolCallRecord(row) : null;
			},
		},

		toolResults: {
			async create(input) {
				const valid = assertCreateToolResultInput(input);
				const record = assertToolResultRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					threadId: valid.threadId,
					runId: valid.runId,
					toolCallId: valid.toolCallId,
					status: valid.status,
					output: valid.output,
					error: valid.error,
					outputMode: valid.outputMode,
					createdAt: now(),
				});
				await db.create({ model: "tool_result", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ToolResultRecord>({
					model: "tool_result",
					where: [{ field: "id", value: id }],
				});
			},

			listForToolCall(input) {
				return db.findMany<ToolResultRecord>({
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
				const record = assertCheckpointRecord({
					id: valid.id ?? newId(),
					runId: valid.runId,
					clawId: valid.clawId,
					threadId: valid.threadId,
					parentCheckpointId: valid.parentCheckpointId,
					kind: valid.kind,
					step: valid.step,
					state: valid.state,
					messageCursor: valid.messageCursor,
					toolCallId: valid.toolCallId,
					createdAt: now(),
				});
				await db.create({ model: "checkpoint", data: record });
				return record;
			},

			get(id) {
				return db.findOne<CheckpointRecord>({
					model: "checkpoint",
					where: [{ field: "id", value: id }],
				});
			},

			async latestForRun(runId) {
				const [latest] = await db.findMany<CheckpointRecord>({
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
				const record = assertConversationBindingRecord({
					id: valid.id ?? newId(),
					provider: valid.provider,
					endpointKey: valid.endpointKey,
					externalConversationId: valid.externalConversationId,
					externalActorId: valid.externalActorId,
					clawId: valid.clawId,
					threadId: valid.threadId,
					metadata: valid.metadata,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "conversation_binding", data: record });
				return record;
			},

			get(id) {
				return db.findOne<ConversationBindingRecord>({
					model: "conversation_binding",
					where: [{ field: "id", value: id }],
				});
			},

			getByExternal(input) {
				return db.findOne<ConversationBindingRecord>({
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
				return db.findMany<ConversationBindingRecord>({
					model: "conversation_binding",
					where: [{ field: "threadId", value: threadId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},
	};
}
