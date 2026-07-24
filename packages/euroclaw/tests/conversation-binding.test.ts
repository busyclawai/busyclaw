import { SYSTEM_ANONYMOUS } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { durableRedactor, owned, textModel } from "./fixtures";

describe("createClaw conversation binding", () => {
	it("idempotently binds an external conversation to a durable Claw thread", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
		});

		const first = await claw.api.bindConversation({
			provider: "telegram",
			endpointKey: "default",
			externalConversationId: "chat-1",
			externalActorId: "user-1",
			metadata: { source: "webhook" },
			// the creator is claw-creation data — it rides the claw bind defaults, not the binding key
			claw: { name: "Recruiting assistant", createdBy: "user:actor-1" },
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
		expect(first.claw.createdBy).toBe("user:actor-1");
		// a bound claw defaults to personal scope, keyed to its creator, until re-shared
		expect(first.claw.scope).toBe("personal");
		expect(first.claw.scopeId).toBe("user:actor-1");
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

	it("attributes an unauthenticated conversation to system:anonymous — external id + endpoint stay on the binding", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
		});

		// A stranger's bot conversation carries no principal (no claw.createdBy) — the fresh claw's
		// creator is system:anonymous, NOT the telegram id or the bot endpoint (the bleed the principal
		// standardization closes: createdBy is a principal, read by the owner-rule / erasure).
		const bound = await claw.api.bindConversation({
			provider: "telegram",
			endpointKey: "sales",
			externalConversationId: "chat-9",
			externalActorId: "stranger-9",
			claw: { name: "Sales assistant" },
			thread: { title: "Telegram chat" },
		});

		expect(bound.created).toBe(true);
		expect(bound.claw.createdBy).toBe(SYSTEM_ANONYMOUS);
		// personal scope keyed to the (anonymous) creator, exactly like an authenticated bind
		expect(bound.claw.scope).toBe("personal");
		expect(bound.claw.scopeId).toBe(SYSTEM_ANONYMOUS);
		// nothing is lost: the stranger and the endpoint are still recorded on the binding row for
		// erasure + routing — they are simply no longer masquerading as the creator.
		expect(bound.binding).toMatchObject({
			provider: "telegram",
			endpointKey: "sales",
			externalConversationId: "chat-9",
			externalActorId: "stranger-9",
		});
	});
});
