// The delivery queue's own semantics — the inbox claim and the outbox, tested directly rather than
// through a webhook route. R-H10.
//
// These are the properties the whole at-most-once-in / at-least-once-out story rests on, and every one
// of them used to be a comment rather than a check: a claim that can tell a duplicate from an outage,
// an enqueue that does the same, and a dispatch that treats "this delivery already owes a reply" as an
// answer instead of noise.

import type { Adapter } from "@busyclaw/contracts";
import { entityAdapter, memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { handleInbound } from "../src/core/dispatch";
import {
	channelDeliveryModels,
	channelOutboxModels,
	createDeliveryInbox,
	createDeliveryOutbox,
	type DeliveryOutbox,
	deliveryRowId,
	type OutboundRecord,
} from "../src/core/inbox";
import type { Channel, EndpointContext } from "../src/index";

const db = (): Adapter =>
	entityAdapter(memoryAdapter(), {
		...channelDeliveryModels,
		...channelOutboxModels,
	});

/** An adapter whose writes fail the way an outage does — not the way a duplicate does. */
const brokenWrites = (): Adapter => {
	const inner = db();
	return {
		...inner,
		create: async () => {
			throw new Error("ECONNREFUSED: the database is unreachable");
		},
	};
};

const key = {
	provider: "fake",
	endpointKey: "acme-bot",
	deliveryId: "u-1",
};

const reply: OutboundRecord = {
	externalConversationId: "chat-1",
	text: "the answer",
};

const LEASE_MS = 60_000;

// A storage outage and a duplicate row are opposite facts: one says the write did not happen, the
// other says it already had. Both used to arrive as a bare `catch`, and the caller was told the same
// thing either way — "somebody else has this" — so a delivery nobody held was reported as handled and
// the message went nowhere while the provider was answered 200.
describe("a storage failure is not a duplicate", () => {
	it("rethrows an unreachable database instead of reporting the delivery claimed", async () => {
		const inbox = createDeliveryInbox(brokenWrites());
		await expect(inbox.claim(key, LEASE_MS)).rejects.toThrow(/ECONNREFUSED/);
	});

	it("rethrows an unreachable database instead of reporting the reply already owed", async () => {
		const outbox = createDeliveryOutbox(brokenWrites());
		await expect(outbox.enqueue(key, reply)).rejects.toThrow(/ECONNREFUSED/);
	});

	// …and the recoverable case still recovers: a genuine duplicate is still answered, not thrown.
	it("still reports a genuine duplicate as one", async () => {
		const adapter = db();
		const inbox = createDeliveryInbox(adapter);
		const outbox = createDeliveryOutbox(adapter);

		expect(await inbox.claim(key, LEASE_MS)).toBe(true);
		expect(await inbox.claim(key, LEASE_MS)).toBe(false);

		expect(await outbox.enqueue(key, reply)).toBe(true);
		expect(await outbox.enqueue(key, reply)).toBe(false);
	});
});

// The enqueue's answer was discarded and the send ran regardless. On a recovery re-run — the first
// attempt recorded a reply and died before confirming it — that sent the text THIS run produced and
// then marked the STORED one delivered: one message recorded and never sent, another sent and never
// recorded.
describe("a delivery that already owes a reply is left to the drain", () => {
	const endpoint: EndpointContext = {
		provider: "fake",
		endpointKey: "acme-bot",
		mode: "webhook",
	};

	const claw = (relayed: string[]) => ({
		api: {
			bindConversation: async () => ({
				claw: { id: "claw-1" },
				thread: { id: "thread-1" },
			}),
			sendMessage: async (input: { message: string }) => {
				relayed.push(input.message);
				return { result: { status: "completed", text: "the SECOND answer" } };
			},
		},
	});

	const channel = (sent: string[]): Channel => ({
		provider: "fake",
		supports: { webhook: true, poll: false },
		mode: "webhook",
		verify: () => true,
		parseInbound: () => [],
		send: async ({ message }) => {
			sent.push(message.text);
		},
	});

	it("does not send a second answer over the one already recorded", async () => {
		const adapter = db();
		const outbox = createDeliveryOutbox(adapter);
		// The dead attempt: it recorded its answer and never confirmed the send.
		expect(
			await outbox.enqueue(key, {
				externalConversationId: "chat-1",
				text: "the FIRST answer",
			}),
		).toBe(true);

		const sent: string[] = [];
		const relayed: string[] = [];
		await handleInbound({
			claw: claw(relayed),
			channel: channel(sent),
			endpoint,
			message: {
				deliveryId: "u-1",
				externalConversationId: "chat-1",
				text: "hello",
			},
			outbox,
		});

		// The turn ran — this is a recovery, and the model was asked again…
		expect(relayed).toEqual(["hello"]);
		// …but nothing went out over the recorded answer, and the recorded one is still owed.
		expect(sent).toEqual([]);
		expect(await outbox.pending()).toMatchObject([
			{ deliveryId: "u-1", text: "the FIRST answer" },
		]);
	});

	it("still sends when the reply is this delivery's first", async () => {
		const sent: string[] = [];
		const relayed: string[] = [];
		const outbox = createDeliveryOutbox(db());
		await handleInbound({
			claw: claw(relayed),
			channel: channel(sent),
			endpoint,
			message: {
				deliveryId: "u-1",
				externalConversationId: "chat-1",
				text: "hello",
			},
			outbox,
		});

		expect(sent).toEqual(["the SECOND answer"]);
		// Sent AND marked — nothing left owed.
		expect(await outbox.pending()).toEqual([]);
	});

	// A dispatch with no outbox at all (a claw with no database) is unchanged: send and hope, which is
	// the honest shape of a deployment that has nowhere to record the reply.
	it("sends without an outbox at all", async () => {
		const sent: string[] = [];
		const relayed: string[] = [];
		await handleInbound({
			claw: claw(relayed),
			channel: channel(sent),
			endpoint,
			message: {
				deliveryId: "u-1",
				externalConversationId: "chat-1",
				text: "hello",
			},
		});
		expect(sent).toEqual(["the SECOND answer"]);
	});
});

// A stub outbox is enough to pin the contract itself: whatever the store's reason, `false` means the
// caller must not send.
describe("the enqueue contract", () => {
	it("treats a false enqueue as 'not mine to send', whatever the store's reason", async () => {
		const sent: string[] = [];
		const calls: string[] = [];
		const outbox: DeliveryOutbox = {
			enqueue: async () => {
				calls.push("enqueue");
				return false;
			},
			markSent: async () => {
				calls.push("markSent");
			},
			markFailed: async () => {
				calls.push("markFailed");
			},
			pending: async () => [],
		};

		await handleInbound({
			claw: {
				api: {
					bindConversation: async () => ({
						claw: { id: "claw-1" },
						thread: { id: "thread-1" },
					}),
					sendMessage: async () => ({
						result: { status: "completed", text: "answer" },
					}),
				},
			},
			channel: {
				provider: "fake",
				supports: { webhook: true, poll: false },
				mode: "webhook",
				verify: () => true,
				parseInbound: () => [],
				send: async ({ message }) => {
					sent.push(message.text);
				},
			},
			endpoint: {
				provider: "fake",
				endpointKey: "acme-bot",
				mode: "webhook",
			},
			message: {
				deliveryId: "u-1",
				externalConversationId: "chat-1",
				text: "hello",
			},
			outbox,
		});

		expect(sent).toEqual([]);
		// …and it did not mark somebody else's row sent on the way out.
		expect(calls).toEqual(["enqueue"]);
	});
});

// The key's parts are joined by NUL, which is invisible in a source file and was in fact a raw NUL
// BYTE until R-H10 — so nothing would have noticed it becoming a space, and a space is forgeable: a
// provider-supplied deliveryId containing one makes ("a b", "c") and ("a", "b c") the same row, and
// one of those two deliveries then silently never runs.
describe("the delivery key cannot be forged apart", () => {
	it("keeps two different keys different when a part contains the separator", () => {
		expect(
			deliveryRowId({
				provider: "fake",
				endpointKey: "acme bot",
				deliveryId: "u-1",
			}),
		).not.toBe(
			deliveryRowId({
				provider: "fake",
				endpointKey: "acme",
				deliveryId: "bot u-1",
			}),
		);
	});

	// Pinned: the id is a stored primary key, so changing how it is derived orphans every claim and
	// every owed reply already in a deployment's database.
	it("derives the same id it always has", () => {
		expect(
			deliveryRowId({
				provider: "fake",
				endpointKey: "acme-bot",
				deliveryId: "u-1",
			}),
		).toBe("9717d18829f87f3e107350a6790570dee58e6a4eed4f72e4a11cbe80575618b3");
	});
});
