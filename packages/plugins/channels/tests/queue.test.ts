// The delivery queue's own semantics — the inbox claim and the outbox, tested directly rather than
// through a webhook route. R-H10.
//
// These are the properties the whole at-most-once-in / at-least-once-out story rests on, and every one
// of them used to be a comment rather than a check: a claim that can tell a duplicate from an outage,
// an enqueue that does the same, and a dispatch that treats "this delivery already owes a reply" as an
// answer instead of noise.

import type { Adapter } from "@busyclaw/contracts";
import { entityAdapter, memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it, vi } from "vitest";
import { dispatchWebhook, handleInbound } from "../src/core/dispatch";
import {
	channelDeliveryModels,
	channelOutboxModels,
	createDeliveryInbox,
	createDeliveryOutbox,
	type DeliveryInbox,
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

const admitted = async (
	inbox: DeliveryInbox,
	overrides: { text?: string } = {},
) =>
	inbox.admit(key, {
		payload: {
			externalConversationId: "chat-1",
			text: overrides.text ?? "hello",
		},
		clawId: "claw-1",
		threadId: "thread-1",
	});

const LEASE_MS = 60_000;

// A storage outage and a duplicate row are opposite facts: one says the write did not happen, the
// other says it already had. Both used to arrive as a bare `catch`, and the caller was told the same
// thing either way — "somebody else has this" — so a delivery nobody held was reported as handled and
// the message went nowhere while the provider was answered 200.
describe("a storage failure is not a duplicate", () => {
	it("rethrows an unreachable database instead of reporting the delivery admitted", async () => {
		const inbox = createDeliveryInbox(brokenWrites());
		await expect(admitted(inbox)).rejects.toThrow(/ECONNREFUSED/);
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

		expect(await admitted(inbox)).toBe(true);
		// A second arrival of the same delivery is a retry, not new work.
		expect(await admitted(inbox)).toBe(false);

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

// The claim used to record only WHEN it went stale, which answers "has the holder gone away?" and
// cannot answer "am I still the holder?". So a turn whose lease lapsed and was re-taken went on to
// call complete and marked the delivery finished while its successor was still running it — and the
// successor's work then looked like a second, unclaimed turn against a row it no longer owned.
describe("a displaced holder cannot finish over its successor", () => {
	// A clock the test drives, so a lapse is a fact rather than a wait.
	const clock = (start = "2026-01-01T00:00:00.000Z") => {
		let t = Date.parse(start);
		return {
			now: () => new Date(t).toISOString(),
			advance: (ms: number) => {
				t += ms;
			},
		};
	};

	it("refuses a completion from a lease that was re-taken", async () => {
		const time = clock();
		const adapter = db();
		const inbox = createDeliveryInbox(adapter, { now: time.now });
		await admitted(inbox);

		const first = await inbox.claim(key, 1000);
		expect(first).not.toBeNull();
		if (!first) throw new Error("expected the first claim to succeed");

		// It dies. The lease lapses and a recovery takes over.
		time.advance(2000);
		const second = await inbox.claim(key, 1000);
		expect(second).not.toBeNull();
		if (!second) throw new Error("expected the recovery to take the delivery");
		expect(second.leaseId).not.toBe(first.leaseId);

		// The corpse comes back to life and tries to finish. It must not.
		expect(await inbox.complete(key, first.leaseId)).toBe(false);
		// …and the row is still the successor's to finish, not marked done behind its back.
		expect(await inbox.complete(key, second.leaseId)).toBe(true);
	});

	it("tells a displaced holder its lease is gone", async () => {
		const time = clock();
		const inbox = createDeliveryInbox(db(), { now: time.now });
		await admitted(inbox);

		const first = await inbox.claim(key, 1000);
		if (!first) throw new Error("expected the first claim to succeed");
		// While it still holds the lease, saying "still here" works.
		expect(await inbox.heartbeat(key, first.leaseId, 1000)).toBe(true);

		time.advance(2000);
		const second = await inbox.claim(key, 1000);
		if (!second) throw new Error("expected the recovery to take the delivery");

		expect(await inbox.heartbeat(key, first.leaseId, 1000)).toBe(false);
		expect(await inbox.heartbeat(key, second.leaseId, 1000)).toBe(true);
	});

	// The point of the heartbeat: a turn that is SLOW is not a turn that is DEAD, and only the second
	// should be recoverable. Without it, a long tool chain lost its delivery to a recovery that then
	// ran the same message a second time.
	it("keeps a live but slow turn from being reclaimed", async () => {
		const time = clock();
		const inbox = createDeliveryInbox(db(), { now: time.now });
		await admitted(inbox);

		const held = await inbox.claim(key, 1000);
		if (!held) throw new Error("expected the claim to succeed");

		// The turn outlives its original window, but says so.
		time.advance(800);
		expect(await inbox.heartbeat(key, held.leaseId, 1000)).toBe(true);
		time.advance(800);
		expect(await inbox.heartbeat(key, held.leaseId, 1000)).toBe(true);

		// A recovery arriving now finds a live lease and leaves it alone.
		expect(await inbox.claim(key, 1000)).toBeNull();
		// …and the holder still finishes its own work.
		expect(await inbox.complete(key, held.leaseId)).toBe(true);
	});

	// Two recoveries racing the same lapsed lease: the where pins the lease each of them read, so the
	// second matches nothing rather than taking a row the first already took.
	it("lets exactly one recovery take a lapsed lease", async () => {
		const time = clock();
		const inbox = createDeliveryInbox(db(), { now: time.now });
		await admitted(inbox);
		const first = await inbox.claim(key, 1000);
		if (!first) throw new Error("expected the first claim to succeed");

		time.advance(2000);
		const [a, b] = await Promise.all([
			inbox.claim(key, 1000),
			inbox.claim(key, 1000),
		]);
		expect([a, b].filter((claim) => claim !== null)).toHaveLength(1);
	});
});

// A correct store proves nothing if the dispatch never presents the lease. These pin the WIRING: the
// claim's lease id is what reaches complete, a refused completion is reported as not-processed, and
// the heartbeat actually fires while the turn is in flight.
/** What a claimed row hands back: the stored message, already resolved to a claw and thread. */
const stubWork = {
	payload: { externalConversationId: "chat-1", text: "hello" },
	clawId: "claw-1",
	threadId: "thread-1",
	attempts: 0,
};

describe("the dispatch carries the lease it was given", () => {
	const endpoint: EndpointContext = {
		provider: "fake",
		endpointKey: "acme-bot",
		mode: "webhook",
	};

	const channel = (): Channel => ({
		provider: "fake",
		supports: { webhook: true, poll: false },
		mode: "webhook",
		verify: () => true,
		parseInbound: () => [
			{
				deliveryId: "u-1",
				externalConversationId: "chat-1",
				text: "hello",
			},
		],
		send: async () => {},
	});

	const claw = (onTurn?: () => Promise<void>) => ({
		api: {
			bindConversation: async () => ({
				claw: { id: "claw-1" },
				thread: { id: "thread-1" },
			}),
			sendMessage: async () => {
				await onTurn?.();
				return { result: { status: "completed", text: "answer" } };
			},
		},
	});

	const request = { headers: { get: () => null }, rawBody: "u-1" };

	it("presents the claim's own lease id at completion", async () => {
		const completedWith: string[] = [];
		const inbox: DeliveryInbox = {
			claim: async () => ({ leaseId: "lease-A", work: stubWork }),
			admit: async () => true,
			known: async () => false,
			claimDue: async () => [],
			fail: async () => "pending" as const,
			heartbeat: async () => true,
			complete: async (_key, leaseId) => {
				completedWith.push(leaseId);
				return true;
			},
		};

		const result = await dispatchWebhook({
			claw: claw(),
			channel: channel(),
			endpoint,
			request,
			persist: async () => {},
			inbox,
		});

		expect(completedWith).toEqual(["lease-A"]);
		expect(
			(result.body as { data: { processed: number } }).data.processed,
		).toBe(1);
	});

	// A refused completion means this attempt was displaced mid-turn. It did not handle the delivery —
	// the attempt that owns it did — so it must not report that it did.
	it("does not report a delivery it was displaced from as processed", async () => {
		const inbox: DeliveryInbox = {
			claim: async () => ({ leaseId: "lease-A", work: stubWork }),
			admit: async () => true,
			known: async () => false,
			claimDue: async () => [],
			fail: async () => "pending" as const,
			heartbeat: async () => true,
			// The recovery took it while the turn was running.
			complete: async () => false,
		};

		const result = await dispatchWebhook({
			claw: claw(),
			channel: channel(),
			endpoint,
			request,
			persist: async () => {},
			inbox,
		});

		expect(
			(result.body as { data: { processed: number } }).data.processed,
		).toBe(0);
	});

	it("says 'still here' while the turn is in flight", async () => {
		vi.useFakeTimers();
		try {
			const beats: string[] = [];
			const inbox: DeliveryInbox = {
				claim: async () => ({ leaseId: "lease-A", work: stubWork }),
				admit: async () => true,
				known: async () => false,
				claimDue: async () => [],
				fail: async () => "pending" as const,
				heartbeat: async (_key, leaseId) => {
					beats.push(leaseId);
					return true;
				},
				complete: async () => true,
			};

			await dispatchWebhook({
				claw: claw(async () => {
					// The turn outlives a heartbeat interval (a third of the 15-minute lease).
					await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
				}),
				channel: channel(),
				endpoint,
				request,
				persist: async () => {},
				inbox,
			});

			// Two intervals elapsed, and every beat presented the lease this attempt holds.
			expect(beats.length).toBeGreaterThanOrEqual(2);
			expect(new Set(beats)).toEqual(new Set(["lease-A"]));
		} finally {
			vi.useRealTimers();
		}
	});

	// …and the timer does not outlive the turn: a stopped heartbeat stops asking.
	it("stops beating once the turn is done", async () => {
		vi.useFakeTimers();
		try {
			const beats: string[] = [];
			const inbox: DeliveryInbox = {
				claim: async () => ({ leaseId: "lease-A", work: stubWork }),
				admit: async () => true,
				known: async () => false,
				claimDue: async () => [],
				fail: async () => "pending" as const,
				heartbeat: async () => {
					beats.push("beat");
					return true;
				},
				complete: async () => true,
			};

			await dispatchWebhook({
				claw: claw(),
				channel: channel(),
				endpoint,
				request,
				persist: async () => {},
				inbox,
			});

			const afterTurn = beats.length;
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			expect(beats.length).toBe(afterTurn);
		} finally {
			vi.useRealTimers();
		}
	});
});

// The clause the whole finding turns on: "persist the normalized payload before acknowledging".
//
// The row used to be created already `processing`, by the same request that was running the turn, and
// it carried no copy of the message. So a turn that died left a lease over something nobody had
// stored — the provider had been answered 200 and would not send it again, and no worker could
// recover a message it had never been told about.
describe("a delivery survives the process that received it", () => {
	const clock = (start = "2026-01-01T00:00:00.000Z") => {
		let t = Date.parse(start);
		return {
			now: () => new Date(t).toISOString(),
			advance: (ms: number) => {
				t += ms;
			},
		};
	};

	const endpoint: EndpointContext = {
		provider: "fake",
		endpointKey: "acme-bot",
		mode: "webhook",
	};

	const channel = (): Channel => ({
		provider: "fake",
		supports: { webhook: true, poll: false },
		mode: "webhook",
		verify: () => true,
		parseInbound: ({ request }) => [
			{
				deliveryId: request.rawBody,
				externalConversationId: "chat-1",
				text: request.rawBody,
			},
		],
		send: async () => {},
	});

	const clawThatFails = () => ({
		api: {
			bindConversation: async () => ({
				claw: { id: "claw-1" },
				thread: { id: "thread-1" },
			}),
			sendMessage: async () => {
				throw new Error("the model is down");
			},
		},
	});

	it("stores the message before the turn, so a failed turn leaves work to recover", async () => {
		const time = clock();
		const adapter = db();
		const inbox = createDeliveryInbox(adapter, { now: time.now });

		await expect(
			dispatchWebhook({
				claw: clawThatFails(),
				channel: channel(),
				endpoint,
				request: { headers: { get: () => null }, rawBody: "u-1" },
				persist: async () => {},
				inbox,
			}),
		).rejects.toThrow(/the model is down/);

		// The message is IN the queue — not merely a lease over something nobody kept.
		const due = await inbox.claimDue({ leaseMs: 1000 });
		expect(due).toHaveLength(0); // …backing off, not lost.

		time.advance(2 * 60 * 1000);
		const recovered = await inbox.claimDue({ leaseMs: 1000 });
		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.work.payload).toMatchObject({
			externalConversationId: "chat-1",
			text: "u-1",
		});
		expect(recovered[0]?.work.clawId).toBe("claw-1");
		expect(recovered[0]?.work.threadId).toBe("thread-1");
		expect(recovered[0]?.work.attempts).toBe(1);
	});

	// Durable state stays TOKENIZED. The payload goes through the plugin's redact door into the CLAW's
	// container — the one the transcript uses — so the worker's sendMessage rehydrates it at the model
	// boundary exactly as a resumed run does, and the original never sits in the queue table.
	it("stores the payload tokenized, into the claw's own container", async () => {
		const seen: { clawId?: string }[] = [];
		const adapter = db();
		const inbox = createDeliveryInbox(adapter);

		await dispatchWebhook({
			claw: {
				api: {
					bindConversation: async () => ({
						claw: { id: "claw-7" },
						thread: { id: "thread-7" },
					}),
					sendMessage: async () => ({
						result: { status: "completed", text: "answer" },
					}),
				},
			},
			channel: channel(),
			endpoint,
			request: { headers: { get: () => null }, rawBody: "call me on 555-0100" },
			persist: async () => {},
			inbox,
			redact: async (value, opts) => {
				seen.push({ clawId: opts?.clawId });
				const payload = value as { text: string };
				return {
					...payload,
					text: payload.text.replace("555-0100", "[PHONE]"),
				};
			},
		});

		// Into the claw's container, never the plugin's — a token minted in the wrong one reaches the
		// model as a raw placeholder, silently, with nothing thrown.
		expect(seen).toEqual([{ clawId: "claw-7" }]);

		const stored = await adapter.findOne({
			model: "channel_delivery",
			where: [
				{
					field: "id",
					value: deliveryRowId({
						provider: "fake",
						endpointKey: "acme-bot",
						deliveryId: "call me on 555-0100",
					}),
				},
			],
		});
		expect((stored as { payload: { text: string } }).payload.text).toBe(
			"call me on [PHONE]",
		);
	});

	// A message that fails every time is a message that will fail again. Retried forever it costs a
	// model call per drain and buries the fact that it never succeeded.
	it("buries a delivery that has failed past its cap", async () => {
		const time = clock();
		const inbox = createDeliveryInbox(db(), { now: time.now });
		await admitted(inbox);

		let landed: string | undefined;
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const claim = await inbox.claim(key, 1000);
			if (!claim) throw new Error(`expected to claim attempt ${attempt}`);
			landed = await inbox.fail({
				key,
				leaseId: claim.leaseId,
				error: "the model is down",
				backoffMs: 1000,
				maxAttempts: 3,
			});
			time.advance(2000);
		}

		expect(landed).toBe("dead");
		// …and a dead row is not work: no drain picks it up again.
		expect(await inbox.claimDue({ leaseMs: 1000 })).toEqual([]);
		expect(await inbox.claim(key, 1000)).toBeNull();
	});

	it("holds a failed delivery back until its backoff has passed", async () => {
		const time = clock();
		const inbox = createDeliveryInbox(db(), { now: time.now });
		await admitted(inbox);

		const claim = await inbox.claim(key, 1000);
		if (!claim) throw new Error("expected the claim to succeed");
		expect(
			await inbox.fail({
				key,
				leaseId: claim.leaseId,
				error: "boom",
				backoffMs: 60_000,
				maxAttempts: 5,
			}),
		).toBe("pending");

		// Pending, but not yet due — a drain that ignored this would re-run the attempt that just failed.
		expect(await inbox.claimDue({ leaseMs: 1000 })).toEqual([]);
		time.advance(61_000);
		expect(await inbox.claimDue({ leaseMs: 1000 })).toHaveLength(1);
	});

	// A failure recorded by a displaced attempt would spend one of the SUCCESSOR's retries on an error
	// that was never theirs.
	it("refuses a failure from a lease that was re-taken", async () => {
		const time = clock();
		const inbox = createDeliveryInbox(db(), { now: time.now });
		await admitted(inbox);

		const first = await inbox.claim(key, 1000);
		if (!first) throw new Error("expected the first claim to succeed");
		time.advance(2000);
		const second = await inbox.claim(key, 1000);
		if (!second) throw new Error("expected the recovery to take the delivery");

		expect(
			await inbox.fail({
				key,
				leaseId: first.leaseId,
				error: "the displaced attempt's error",
				backoffMs: 1000,
				maxAttempts: 5,
			}),
		).toBe("lost");
		// The successor's attempt count is untouched by the corpse's failure.
		const held = await inbox.claim(key, 1000);
		expect(held).toBeNull(); // still the successor's
		expect(
			await inbox.fail({
				key,
				leaseId: second.leaseId,
				error: "its own error",
				backoffMs: 1000,
				maxAttempts: 5,
			}),
		).toBe("pending");
	});

	// The sweep has to find BOTH shapes: work nobody started, and work somebody started and abandoned.
	// A queue that reads only the first never recovers a crash; one that reads only the second never
	// starts anything.
	it("sweeps up both unstarted work and abandoned leases", async () => {
		const time = clock();
		const inbox = createDeliveryInbox(db(), { now: time.now });

		await inbox.admit(
			{
				provider: "fake",
				endpointKey: "acme-bot",
				deliveryId: "never-started",
			},
			{
				payload: { externalConversationId: "chat-1", text: "a" },
				clawId: "claw-1",
				threadId: "thread-1",
			},
		);
		const abandonedKey = {
			provider: "fake",
			endpointKey: "acme-bot",
			deliveryId: "abandoned",
		};
		await inbox.admit(abandonedKey, {
			payload: { externalConversationId: "chat-1", text: "b" },
			clawId: "claw-1",
			threadId: "thread-1",
		});
		// Someone took it and died.
		await inbox.claim(abandonedKey, 1000);

		// Right now only the unstarted one is available: the other is under a LIVE lease, and a live
		// lease is somebody working, not somebody gone.
		const first = await inbox.claimDue({ leaseMs: 1000 });
		expect(first.map((row) => row.key.deliveryId)).toEqual(["never-started"]);

		// Both attempts now die. Once their leases lapse the sweep reaches both — which is the point:
		// the row that was never started and the row that was started and abandoned are both work.
		time.advance(2000);
		const swept = await inbox.claimDue({ leaseMs: 1000 });
		expect(new Set(swept.map((row) => row.key.deliveryId))).toEqual(
			new Set(["never-started", "abandoned"]),
		);
	});
});
