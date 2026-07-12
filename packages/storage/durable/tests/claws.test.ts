import { field } from "@euroclaw/contracts";
import { type Adapter, memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createClawsStore } from "../src/claws";

function store(adapter: Adapter = memoryAdapter()) {
	return createClawsStore(adapter, {
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

async function seedClawAndThread(adapter: Adapter = memoryAdapter()) {
	const claws = store(adapter);
	const claw = await claws.claws.create({
		id: "claw-1",
		createdBy: "actor-1",
		context: { locale: "en" },
	});
	const thread = await claws.threads.create({
		id: "thread-1",
		clawId: claw.id,
		title: "Inbox",
	});
	return { claw, claws, thread };
}

describe("createClawsStore", () => {
	it("creates claws and threads with domain defaults through schema-aware storage", async () => {
		const adapter = memoryAdapter();
		const { claw, claws, thread } = await seedClawAndThread(adapter);

		expect(claw).toMatchObject({
			context: { locale: "en" },
			id: "claw-1",
			status: "active",
		});
		expect(thread).toMatchObject({
			currentSequence: 0,
			id: "thread-1",
			status: "active",
		});
		expect(await claws.claws.get(claw.id)).toEqual(claw);
		expect(await claws.threads.get(thread.id)).toEqual(thread);

		const rawClaw = (await adapter.findOne({
			model: "claw",
			where: [{ field: "id", value: claw.id }],
		})) as Record<string, unknown> | null;
		expect(rawClaw?.context).toBe(JSON.stringify({ locale: "en" }));
	});

	it("persists, returns, and reads back extra fields merged onto the claw model", async () => {
		const adapter = memoryAdapter();
		const claws = createClawsStore(adapter, {
			now: () => "2026-01-01T00:00:00.000Z",
			additionalFields: {
				claw: { priority: field.number({ required: true }) },
			},
		});

		// A plain variable (not a fresh literal) so the extra `priority` isn't rejected by the base
		// CreateClawInput type — the store's typed contract stays base; extra fields are runtime.
		const input = {
			id: "claw-x",
			createdBy: "actor-1",
			priority: 5,
		};
		const created = await claws.claws.create(input);

		// returned straight from create…
		expect(created).toMatchObject({ id: "claw-x", priority: 5 });
		// …round-trips through get…
		expect(await claws.claws.get("claw-x")).toMatchObject({ priority: 5 });
		// …and is a real persisted column, not dropped on the floor.
		const raw = (await adapter.findOne({
			model: "claw",
			where: [{ field: "id", value: "claw-x" }],
		})) as Record<string, unknown> | null;
		expect(raw?.priority).toBe(5);
	});

	it("rejects a claw whose required extra field is missing", async () => {
		const claws = createClawsStore(memoryAdapter(), {
			additionalFields: {
				claw: { priority: field.number({ required: true }) },
			},
		});
		await expect(
			claws.claws.create({ id: "claw-y", createdBy: "actor-1" }),
		).rejects.toThrow(/create claw input invalid/);
	});

	it("appends messages transactionally and advances the thread cursor", async () => {
		const { claws } = await seedClawAndThread();

		const first = await claws.messages.append({
			id: "message-1",
			clawId: "claw-1",
			threadId: "thread-1",
			role: "user",
			content: { text: "hello" },
		});
		const second = await claws.messages.append({
			id: "message-2",
			clawId: "claw-1",
			threadId: "thread-1",
			role: "assistant",
			content: { text: "hi" },
		});

		expect(first).toMatchObject({ sequence: 1, visibility: "user" });
		expect(second).toMatchObject({
			parentMessageId: first.id,
			sequence: 2,
		});
		expect(await claws.threads.get("thread-1")).toMatchObject({
			currentMessageId: second.id,
			currentSequence: 2,
		});
		expect(
			(await claws.messages.listForThread({ threadId: "thread-1" })).map(
				(message) => message.id,
			),
		).toEqual(["message-1", "message-2"]);
		expect(
			await claws.messages.listForThread({
				afterSequence: 1,
				threadId: "thread-1",
			}),
		).toMatchObject([{ id: "message-2" }]);
	});

	it("rolls back message insert when the append cursor is stale", async () => {
		const adapter = memoryAdapter();
		const { claws } = await seedClawAndThread(adapter);

		await claws.messages.append({
			id: "message-1",
			clawId: "claw-1",
			threadId: "thread-1",
			role: "user",
			content: { text: "hello" },
		});
		await expect(
			claws.messages.append({
				id: "message-stale",
				clawId: "claw-1",
				threadId: "thread-1",
				sequence: 1,
				role: "assistant",
				content: { text: "stale" },
			}),
		).rejects.toThrow(/must append at current thread cursor/);

		expect(await adapter.count({ model: "message" })).toBe(1);
		expect(await claws.threads.get("thread-1")).toMatchObject({
			currentSequence: 1,
		});
	});

	it("requires transactions for message append", async () => {
		const adapter: Adapter = { ...memoryAdapter(), transaction: undefined };
		const claws = store(adapter);

		await expect(
			claws.messages.append({
				clawId: "claw-1",
				threadId: "thread-1",
				role: "user",
				content: { text: "hello" },
			}),
		).rejects.toThrow(/requires a transactional adapter/);
	});

	it("stores tool calls and tool results separately from messages", async () => {
		const { claws } = await seedClawAndThread();
		const call = await claws.toolCalls.create({
			id: "tool-row-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			toolCallId: "call-1",
			toolName: "send_email",
			args: { to: "{{pii:abc}}" },
		});

		expect(call.status).toBe("proposed");
		expect(
			await claws.toolCalls.getByToolCallId({
				runId: "run-1",
				toolCallId: "call-1",
			}),
		).toMatchObject({ id: call.id });
		expect(
			await claws.toolCalls.updateStatus(call.id, {
				approvalId: "approval-1",
				status: "waiting_approval",
			}),
		).toMatchObject({ approvalId: "approval-1", status: "waiting_approval" });

		const result = await claws.toolResults.create({
			id: "tool-result-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			toolCallId: "call-1",
			status: "completed",
			output: { sent: true },
			outputMode: "redacted",
		});

		expect(result.output).toEqual({ sent: true });
		expect(
			await claws.toolResults.listForToolCall({
				runId: "run-1",
				toolCallId: "call-1",
			}),
		).toMatchObject([{ id: result.id }]);
		expect(
			await claws.messages.listForThread({ threadId: "thread-1" }),
		).toEqual([]);
	});

	it("stores checkpoints and reads the latest checkpoint for a run", async () => {
		let tick = 0;
		const claws = createClawsStore(memoryAdapter(), {
			now: () => `2026-01-01T00:00:0${tick++}.000Z`,
		});
		await claws.claws.create({
			id: "claw-1",
			createdBy: "actor-1",
		});
		await claws.threads.create({
			id: "thread-1",
			clawId: "claw-1",
		});

		await claws.checkpoints.create({
			id: "checkpoint-1",
			runId: "run-1",
			clawId: "claw-1",
			threadId: "thread-1",
			kind: "step",
			step: 1,
			state: { step: 1 },
		});
		const second = await claws.checkpoints.create({
			id: "checkpoint-2",
			runId: "run-1",
			clawId: "claw-1",
			threadId: "thread-1",
			kind: "approval_wait",
			step: 2,
			state: { approvalId: "approval-1" },
		});

		expect(await claws.checkpoints.latestForRun("run-1")).toEqual(second);
		expect(await claws.checkpoints.get("checkpoint-1")).toMatchObject({
			kind: "step",
		});
	});

	it("stores external conversation bindings", async () => {
		const { claws, thread } = await seedClawAndThread();
		const binding = await claws.conversationBindings.create({
			id: "binding-1",
			provider: "telegram",
			endpointKey: "default",
			externalConversationId: "chat-1",
			externalActorId: "user-1",
			clawId: "claw-1",
			threadId: thread.id,
			metadata: { source: "webhook" },
		});

		expect(binding).toMatchObject({
			id: "binding-1",
			provider: "telegram",
			endpointKey: "default",
			externalConversationId: "chat-1",
			metadata: { source: "webhook" },
		});
		await expect(
			claws.conversationBindings.getByExternal({
				provider: "telegram",
				endpointKey: "default",
				externalConversationId: "chat-1",
			}),
		).resolves.toEqual(binding);
		await expect(
			claws.conversationBindings.listForThread(thread.id),
		).resolves.toEqual([binding]);
	});
});
