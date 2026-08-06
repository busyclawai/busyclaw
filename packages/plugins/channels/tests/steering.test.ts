// A message that arrives while the claw is still answering JOINS that turn — it does not start a
// second one beside it.
//
// What it was before: two runs on one conversation, each blind to the other's message, each producing
// an answer. Someone who sent "book the 3pm" and then "sorry, make it 4pm" got a confirmation for
// three o'clock and a confirmation for four, in whichever order the models happened to finish, and the
// claw had done exactly what it was told twice.
//
// Joining is what makes a follow-up a follow-up. It also moves the reply: a run that answers two
// messages produces ONE answer, so the reply cannot belong to a delivery any more, and the delivery
// that relayed it may be long finished by the time the run ends. Hence the second half of these tests
// — the reply is an obligation on the row, discharged inline when it can be and by the drain when it
// cannot.

import type { Adapter } from "@busyclaw/contracts";
import {
	entityAdapter,
	entityView,
	memoryAdapter,
} from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	drainDeliveries,
	drainReplies,
	runDelivery,
} from "../src/core/dispatch";
import {
	channelDeliveryFields,
	channelDeliveryModels,
	channelOutboxModels,
	createDeliveryInbox,
	createDeliveryOutbox,
	deliveryRowId,
	joinedMessageId,
} from "../src/core/inbox";
import type { Channel, EndpointContext } from "../src/index";
import { fakeClaw } from "./fake-claw";

const db = (): Adapter =>
	entityAdapter(memoryAdapter(), {
		...channelDeliveryModels,
		...channelOutboxModels,
	});

const endpoint: EndpointContext = {
	provider: "fake",
	endpointKey: "acme-bot",
	mode: "webhook",
};

const channelThatRecords = (sent: string[]): Channel => ({
	provider: "fake",
	supports: { webhook: true, poll: false },
	mode: "webhook",
	verify: () => true,
	parseInbound: () => [],
	send: async ({ message }) => {
		sent.push(message.text);
	},
});

const keyFor = (deliveryId: string) => ({
	provider: "fake",
	endpointKey: "acme-bot",
	deliveryId,
});

/** Admit one message and run it through the dispatch, exactly as a webhook would. */
async function deliver(input: {
	adapter: Adapter;
	claw: ReturnType<typeof fakeClaw>;
	channel: Channel;
	deliveryId: string;
	text: string;
}) {
	const inbox = createDeliveryInbox(input.adapter);
	const outbox = createDeliveryOutbox(input.adapter);
	const key = keyFor(input.deliveryId);
	await inbox.admit(key, {
		payload: { externalConversationId: "chat-1", text: input.text },
		clawId: "claw-1",
		threadId: "thread-1",
	});
	const claimed = await inbox.claim(key, 60_000);
	if (claimed === null) throw new Error("expected to claim the delivery");
	return runDelivery({
		claw: input.claw,
		channel: input.channel,
		endpoint,
		inbox,
		outbox,
		key,
		leaseId: claimed.leaseId,
		work: claimed.work,
	});
}

describe("a message arriving mid-turn joins the run", () => {
	it("does not open a second run beside a live one", async () => {
		const adapter = db();
		const sent: string[] = [];
		const channel = channelThatRecords(sent);
		// The first turn parks — it is still live when the second message lands, which is the whole
		// situation. `waiting_approval` is the realistic shape of it: a tool call somebody must allow.
		const claw = fakeClaw({ status: "waiting_approval", answer: null });

		await deliver({
			adapter,
			claw,
			channel,
			deliveryId: "u-1",
			text: "book the 3pm",
		});
		await deliver({
			adapter,
			claw,
			channel,
			deliveryId: "u-2",
			text: "sorry, make it 4pm",
		});

		// ONE run. Without the join this is two, and the correction is answered as a separate booking.
		expect(claw.relayed).toEqual(["book the 3pm"]);
		expect(claw.runs).toHaveLength(1);
		expect(claw.joined).toEqual([
			{ toRunId: "run-1", text: "sorry, make it 4pm" },
		]);
		// Neither message has been answered yet — the run has not finished.
		expect(sent).toEqual([]);
	});

	it("puts the joined message in the transcript, not only in the run", async () => {
		// `deliverMessage` fills the run's inbox and nothing else. A conversation whose second message
		// reached the model but not the transcript shows an answer to a question nobody can see.
		const adapter = db();
		const claw = fakeClaw({ status: "waiting_approval", answer: null });
		const channel = channelThatRecords([]);

		await deliver({ adapter, claw, channel, deliveryId: "u-1", text: "first" });
		await deliver({
			adapter,
			claw,
			channel,
			deliveryId: "u-2",
			text: "second",
		});

		expect(
			claw.messages
				.filter((message) => message.role === "user")
				.map((message) => JSON.stringify(message.content)),
		).toEqual([
			JSON.stringify({ text: "first" }),
			JSON.stringify({ text: "second" }),
		]);
		// Stamped with the run it joined, so the answer and the question it answers share an id.
		expect(
			claw.messages.find(
				(message) => message.id === joinedMessageId(keyFor("u-2")),
			)?.runId,
		).toBe("run-1");
	});

	it("answers two joined messages ONCE, when the run finishes", async () => {
		const adapter = db();
		const sent: string[] = [];
		const channel = channelThatRecords(sent);
		const claw = fakeClaw({ status: "waiting_approval", answer: null });

		await deliver({ adapter, claw, channel, deliveryId: "u-1", text: "first" });
		await deliver({
			adapter,
			claw,
			channel,
			deliveryId: "u-2",
			text: "second",
		});
		expect(sent).toEqual([]);

		// The approval is granted somewhere else entirely, and the run finishes.
		claw.finish("run-1", "both of those, done");

		const drained = await drainReplies({
			claw,
			inbox: createDeliveryInbox(adapter),
			outbox: createDeliveryOutbox(adapter),
			endpointFor: () => ({ channel, endpoint }),
		});

		// TWO deliveries settled, ONE message. The reply is keyed on the run, so the second enqueue
		// loses at the database rather than posting the same answer twice.
		expect(sent).toEqual(["both of those, done"]);
		expect(drained).toEqual({ sent: 1, silent: 1, waiting: 0 });
	});

	it("leaves a live run's messages owed rather than settling them", async () => {
		const adapter = db();
		const channel = channelThatRecords([]);
		const claw = fakeClaw({ status: "waiting_approval", answer: null });
		await deliver({ adapter, claw, channel, deliveryId: "u-1", text: "first" });

		const inbox = createDeliveryInbox(adapter);
		const first = await drainReplies({
			claw,
			inbox,
			endpointFor: () => ({ channel, endpoint }),
		});
		expect(first).toEqual({ sent: 0, silent: 0, waiting: 1 });
		// Still owed, so the NEXT drain finds it — this is the property an approval granted tomorrow
		// depends on.
		expect(await inbox.owed({})).toHaveLength(1);
	});
});

describe("a delivery is relayed once, whatever happens after", () => {
	it("does not open a second run when a relayed delivery is re-claimed", async () => {
		// THE CRASH THIS CLOSES: a process that stamped the run and died before completing the row.
		// The lease lapses, a drain re-claims it, and without the stamp it would relay again — a second
		// run, a second run-keyed reply, a duplicate message to a human. The delivery-keyed reply used
		// to catch exactly that; a run-keyed one cannot, so the row has to remember its run.
		const adapter = db();
		const sent: string[] = [];
		const channel = channelThatRecords(sent);
		const claw = fakeClaw({ answer: "the answer" });
		const key = keyFor("u-1");
		const inbox = createDeliveryInbox(adapter);
		const outbox = createDeliveryOutbox(adapter);

		await inbox.admit(key, {
			payload: { externalConversationId: "chat-1", text: "hello" },
			clawId: "claw-1",
			threadId: "thread-1",
		});
		// The dead attempt got as far as the stamp.
		const first = await inbox.claim(key, 60_000);
		if (first === null) throw new Error("expected to claim");
		const sendResult = await claw.api.sendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			message: "hello",
		});
		await inbox.relayed(key, first.leaseId, sendResult.runId);

		// …and then the lease lapses and a drain takes over.
		const later = createDeliveryInbox(adapter, {
			now: () => new Date(Date.now() + 30 * 60 * 1000).toISOString(),
		});
		const again = await later.claim(key, 60_000);
		if (again === null) throw new Error("expected to re-claim");
		expect(again.work.runId).toBe("run-1");

		await runDelivery({
			claw,
			channel,
			endpoint,
			inbox: later,
			outbox,
			key,
			leaseId: again.leaseId,
			work: again.work,
		});

		// The model was NOT asked again — one run, one relay — and the answer went out once.
		expect(claw.relayed).toEqual(["hello"]);
		expect(claw.runs).toHaveLength(1);
		expect(sent).toEqual(["the answer"]);
	});

	it("stamps the run on the row, and settles it once answered", async () => {
		const adapter = db();
		const claw = fakeClaw({ answer: "hi" });
		await deliver({
			adapter,
			claw,
			channel: channelThatRecords([]),
			deliveryId: "u-1",
			text: "hello",
		});

		const rows = entityView(adapter, {
			channel_delivery: { fields: channelDeliveryFields },
		});
		const row = await rows.findOne({
			model: "channel_delivery",
			where: [{ field: "id", value: deliveryRowId(keyFor("u-1")) }],
		});
		expect(row).toMatchObject({ runId: "run-1", status: "completed" });
		expect(row?.settledAt).not.toBe("");
	});
});

describe("a run that answers nothing settles the message anyway", () => {
	it("sends nothing and stops coming back", async () => {
		// A failed or cancelled run has no answer and never will. The bot does not invent an apology —
		// that is the host's copy, in the host's language, for a failure it can see and has the run id
		// for. What must not happen is the row staying owed: an obligation that can never be discharged
		// is one every drain re-examines forever.
		const adapter = db();
		const sent: string[] = [];
		const channel = channelThatRecords(sent);
		const claw = fakeClaw({ status: "waiting_approval", answer: null });
		await deliver({ adapter, claw, channel, deliveryId: "u-1", text: "hello" });

		claw.finish("run-1", null, "failed");

		const inbox = createDeliveryInbox(adapter);
		const drained = await drainReplies({
			claw,
			inbox,
			outbox: createDeliveryOutbox(adapter),
			endpointFor: () => ({ channel, endpoint }),
		});

		expect(drained).toEqual({ sent: 0, silent: 1, waiting: 0 });
		expect(sent).toEqual([]);
		// SETTLED — the sweep is empty, so this row is not examined again.
		expect(await inbox.owed({})).toEqual([]);
	});

	it("keeps a message whose endpoint has gone owed, rather than settling it", async () => {
		// A revoked registration can come back. Unlike the inbound queue there is no attempt counter to
		// burn here, so re-examining costs one row read per drain — and settling it would erase the only
		// record that somebody is still waiting for an answer.
		const adapter = db();
		const claw = fakeClaw({ answer: "hi" });
		const channel = channelThatRecords([]);
		await deliver({ adapter, claw, channel, deliveryId: "u-1", text: "hello" });

		const inbox = createDeliveryInbox(adapter);
		// Settled by the inline path already; admit a second one and leave it unresolvable.
		await inbox.admit(keyFor("u-2"), {
			payload: { externalConversationId: "chat-1", text: "second" },
			clawId: "claw-1",
			threadId: "thread-1",
		});
		const claimed = await inbox.claim(keyFor("u-2"), 60_000);
		if (claimed === null) throw new Error("expected to claim");
		await inbox.relayed(keyFor("u-2"), claimed.leaseId, "run-9");

		const drained = await drainReplies({
			claw,
			inbox,
			endpointFor: () => undefined,
		});
		expect(drained).toEqual({ sent: 0, silent: 0, waiting: 1 });
		expect(await inbox.owed({})).toHaveLength(1);
	});
});

describe("the two triggers are one implementation", () => {
	it("answers through the delivery drain when the inline attempt never happened", async () => {
		const adapter = db();
		const sent: string[] = [];
		const channel = channelThatRecords(sent);
		const claw = fakeClaw({ answer: "recovered" });
		const inbox = createDeliveryInbox(adapter);

		// Admitted by a request that died before it could claim.
		await inbox.admit(keyFor("u-1"), {
			payload: { externalConversationId: "chat-1", text: "hello" },
			clawId: "claw-1",
			threadId: "thread-1",
		});

		const result = await drainDeliveries({
			claw,
			inbox,
			outbox: createDeliveryOutbox(adapter),
			endpointFor: () => ({ channel, endpoint }),
		});

		expect(result).toEqual({ processed: 1, failed: 0 });
		// The recovery path produced the answer the live path would have, through the same function.
		expect(sent).toEqual(["recovered"]);
		expect(await inbox.owed({})).toEqual([]);
	});
});
