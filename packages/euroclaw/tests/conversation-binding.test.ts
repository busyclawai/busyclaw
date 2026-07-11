import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, textModel } from "./fixtures";

describe("createClaw conversation binding", () => {
	it("idempotently binds an external conversation to a durable Claw thread", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redactor,
		});

		const first = await claw.api.bindConversation({
			provider: "telegram",
			endpointKey: "default",
			externalConversationId: "chat-1",
			externalActorId: "user-1",
			metadata: { source: "webhook" },
			// the creator is claw-creation data — it rides the claw bind defaults, not the binding key
			claw: { name: "Recruiting assistant", createdBy: "actor-1" },
			thread: { title: "Telegram chat" },
		});
		const second = await claw.api.bindConversation({
			provider: "telegram",
			endpointKey: "default",
			externalConversationId: "chat-1",
		});

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.binding.id).toBe(first.binding.id);
		expect(second.claw.id).toBe(first.claw.id);
		expect(second.thread.id).toBe(first.thread.id);
		expect(first.claw.createdBy).toBe("actor-1");
		// a bound claw defaults to personal scope, keyed to its creator, until re-shared
		expect(first.claw.scope).toBe("personal");
		expect(first.claw.scopeId).toBe("actor-1");
		expect(first.binding).toMatchObject({
			provider: "telegram",
			endpointKey: "default",
			externalConversationId: "chat-1",
			externalActorId: "user-1",
			metadata: { source: "webhook" },
		});

		await claw.api.sendMessage({
			clawId: first.claw.id,
			threadId: first.thread.id,
			message: "hello from telegram",
			runId: "run-1",
		});

		await expect(
			claw.api.listMessages({ threadId: first.thread.id }),
		).resolves.toMatchObject([
			{ content: { text: "hello from telegram" }, role: "user" },
			{ content: { text: "done" }, role: "assistant" },
		]);
	});
});
