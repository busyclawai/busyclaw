import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	checkpointRecord,
	clawRecord,
	clawsSchema,
	createClawInput,
	messageRecord,
	threadRecord,
	toolCallRecord,
	toolResultRecord,
} from "../src/index";

describe("euroclaw core — durable Claw contracts", () => {
	it("validates the durable claw/thread/message/tool record shapes", () => {
		const claw = clawRecord({
			id: "claw-1",
			createdBy: "user:actor-1",
			scope: "personal",
			scopeId: "actor-1",
			status: "active",
			context: { locale: "en" },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const thread = threadRecord({
			id: "thread-1",
			clawId: "claw-1",
			status: "active",
			currentSequence: 0,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const message = messageRecord({
			id: "message-1",
			clawId: "claw-1",
			threadId: "thread-1",
			sequence: 1,
			role: "user",
			content: { text: "hello {{pii:abc}}" },
			visibility: "user",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const toolCall = toolCallRecord({
			id: "tool-call-record-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			toolCallId: "c1",
			toolName: "send_email",
			args: { to: "{{pii:abc}}" },
			status: "waiting_approval",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const toolResult = toolResultRecord({
			id: "tool-result-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			toolCallId: "c1",
			status: "completed",
			output: { sent: true },
			outputMode: "redacted",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const checkpoint = checkpointRecord({
			id: "checkpoint-1",
			runId: "run-1",
			clawId: "claw-1",
			threadId: "thread-1",
			kind: "approval_wait",
			state: { toolCallId: "c1" },
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(claw).not.toBeInstanceOf(type.errors);
		expect(thread).not.toBeInstanceOf(type.errors);
		expect(message).not.toBeInstanceOf(type.errors);
		expect(toolCall).not.toBeInstanceOf(type.errors);
		expect(toolResult).not.toBeInstanceOf(type.errors);
		expect(checkpoint).not.toBeInstanceOf(type.errors);
	});

	it("rejects raw non-JSON durable content", () => {
		const invalid = messageRecord({
			id: "message-1",
			clawId: "claw-1",
			threadId: "thread-1",
			sequence: 1,
			role: "user",
			content: { fn: () => "nope" },
			visibility: "user",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	it("keeps tool result messages separate from canonical tool result records", () => {
		const message = messageRecord({
			id: "message-tool-result-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			sequence: 3,
			role: "tool",
			content: {
				type: "tool-result",
				toolCallId: "c1",
				output: { sent: true },
			},
			visibility: "internal",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const result = toolResultRecord({
			id: "tool-result-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			toolCallId: "c1",
			status: "completed",
			output: { sent: true },
			outputMode: "redacted",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(message).toMatchObject({ role: "tool" });
		expect(result).toMatchObject({ toolCallId: "c1", status: "completed" });
	});

	it("derives create input and storage schema from the entity fields", () => {
		const input = createClawInput({
			createdBy: "user:actor-1",
			name: "Recruiting claw",
		});

		expect(input).not.toBeInstanceOf(type.errors);
		expect(clawsSchema.claw.fields.id).toMatchObject({
			type: "string",
			required: true,
			unique: true,
		});
		expect(clawsSchema.claw.fields.context).toMatchObject({
			type: "json",
			required: true,
		});
	});

	it("marks conversation binding external identifiers as PII for erasure sweeps", () => {
		const fields = clawsSchema.conversation_binding.fields;
		expect(fields.externalConversationId.pii).toBe("possible");
		expect(fields.externalActorId.pii).toBe("possible");
		expect(fields.metadata.pii).toBe("possible");
		// the opaque discriminator + internal keys are NOT personal data
		expect(fields.provider.pii).toBeUndefined();
		expect(fields.endpointKey.pii).toBeUndefined();
	});
});
