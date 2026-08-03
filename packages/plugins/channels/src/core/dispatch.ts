// The shared dispatch engine — protocol only. The calling mode resolves the endpoint (code
// declaration for app bots, registration row for registrations mode), assembles the normalized
// EndpointContext, and supplies a persist sink for state events; the engine owns the
// verify → parse → bind → relay → reply round-trip and never touches storage.

import type { JsonObject, JsonValue, Principal } from "@busyclaw/contracts";
import { errorMessage, stateError, systemPrincipal } from "@busyclaw/contracts";
import type { ClawLike } from "./claw";
import type {
	Channel,
	EndpointContext,
	InboundMessage,
	InboundRequest,
	PersistEndpointEvent,
} from "./contracts";
import type {
	DeliveryInbox,
	DeliveryKey,
	DeliveryOutbox,
	DeliveryWork,
} from "./inbox";

export type ChannelDispatchResult = {
	status: number;
	body: unknown;
};

/**
 * The service principal a dispatch acts as — scoped to the ENDPOINT, not shared by every stranger.
 *
 * R-M11. Every inbound message from every bot on every tenant relayed as one global
 * `system:anonymous`. That principal is the claw's `createdBy` for a fresh binding, so the owner rule
 * let it relay — and it let EVERY other endpoint's traffic relay into the same conversations for the
 * same reason. There was no attribution (which bot did this?), no isolation (a policy naming the
 * relay identity named all of them at once), and nothing per-endpoint to rate-limit or revoke.
 *
 * `system:channel:<provider>:<endpointKey>` gives each endpoint its own least-privilege identity. It
 * is still not the human sender — resolving external actors to real principals is a separate,
 * larger piece of work, and `message.externalActorId` is recorded on the binding either way — but it
 * is the difference between "a stranger" and "this bot", which is what a policy can act on.
 */
function endpointPrincipal(endpoint: EndpointContext): Principal {
	return systemPrincipal(
		`channel:${endpoint.provider}:${endpoint.endpointKey}`,
	);
}

/**
 * The shared half every provider reuses: bind the external conversation to a claw/thread (core), relay
 * the message to the claw, and — if the run produced text — reply through the channel. A channel only
 * supplies parse/send; this owns the round-trip. The binding is keyed by the endpoint (the bot scopes
 * external conversation ids); whose data the conversation is rides the claw bind defaults.
 */
export async function handleInbound(input: {
	claw: ClawLike;
	channel: Channel;
	endpoint: EndpointContext;
	message: InboundMessage;
	/** Absent ⇒ no database, so the reply is sent without a durable record and a crash loses it. */
	outbox?: DeliveryOutbox;
}): Promise<void> {
	const { claw, channel, endpoint, message } = input;
	// The dispatch acts for no authenticated human — the app-authz caller is this ENDPOINT's service
	// principal, which is also what a fresh binding stamps as the claw's `createdBy`, so the owner rule
	// permits relaying into that conversation's own claw and permits no other endpoint to.
	const caller = { principal: endpointPrincipal(endpoint) };
	const binding = await claw.api.bindConversation(
		{
			provider: endpoint.provider,
			endpointKey: endpoint.endpointKey,
			externalConversationId: message.externalConversationId,
			externalActorId: message.externalActorId,
			claw: endpoint.claw,
			thread: {
				...endpoint.thread,
				title: endpoint.thread?.title ?? message.conversationTitle,
			},
		},
		caller,
	);
	const sent = await claw.api.sendMessage(
		{
			clawId: binding.claw.id,
			threadId: binding.thread.id,
			message: message.text,
		},
		caller,
	);
	if (sent.result.status !== "completed" || !sent.result.text) return;
	const reply = {
		externalConversationId: message.externalConversationId,
		text: sent.result.text,
		...(message.replyContext !== undefined
			? { replyContext: message.replyContext }
			: {}),
	};
	const key =
		input.outbox !== undefined && message.deliveryId !== undefined
			? {
					provider: channel.provider,
					endpointKey: endpoint.endpointKey,
					deliveryId: message.deliveryId,
				}
			: undefined;
	// No outbox (or no delivery id to key one on) ⇒ send and hope, exactly as before.
	if (input.outbox === undefined || key === undefined) {
		await channel.send({ endpoint, message: reply });
		return;
	}
	await deliverReply({
		channel,
		endpoint,
		key,
		reply,
		outbox: input.outbox,
	});
}

/**
 * Put the reply where it survives, then send it.
 *
 * DURABLE BEFORE SENT. De-duplicating the inbound half created a new way to lose a reply: the turn
 * runs, the process dies before `send`, and the delivery is already claimed — so a retry correctly
 * declines to re-run it and the answer is simply gone. Writing the reply first means a crash anywhere
 * after this leaves a row the drain will finish.
 *
 * Shared by the inline path and the worker so a recovered delivery's reply is recorded exactly the
 * same way as a live one's.
 */
async function deliverReply(input: {
	channel: Channel;
	endpoint: EndpointContext;
	key: DeliveryKey;
	reply: {
		externalConversationId: string;
		text: string;
		replyContext?: JsonValue;
	};
	outbox?: DeliveryOutbox;
}): Promise<void> {
	const { channel, endpoint, key, reply } = input;
	if (input.outbox === undefined) {
		await channel.send({ endpoint, message: reply });
		return;
	}
	// The enqueue's answer MATTERS. It was discarded and the send ran regardless — so on a recovery
	// re-run this sent the text THIS attempt produced while `markSent` marked the STORED one delivered:
	// one message recorded and never sent, another sent and never recorded. A delivery that already
	// owes a reply belongs to the drain, which sends what was recorded.
	//
	// The enqueue also HANDS BACK the lease, because the writer is always this reply's first sender.
	// Without holding one, a drain running concurrently could take the row this call just wrote and
	// send it alongside us.
	const held = await input.outbox.enqueue(key, reply);
	if (held === null) return;
	try {
		await channel.send({ endpoint, message: reply });
	} catch (error) {
		// Left PENDING on purpose, with a backoff — the drain owns the retry, and a send that failed
		// here is exactly what the outbox exists to carry.
		await input.outbox.markFailed({
			key,
			leaseId: held.leaseId,
			error: errorMessage(error),
			backoffMs: OUTBOX_BACKOFF_MS,
			maxAttempts: MAX_OUTBOX_ATTEMPTS,
		});
		throw error;
	}
	// A crash between the send and this mark re-sends later: a duplicate message is visible and
	// recoverable, a lost one is neither, so that is the side to fail on.
	await input.outbox.markSent(key, held.leaseId);
}

/**
 * Handle one inbound webhook on an already-resolved endpoint: authenticate before trusting the body,
 * parse, relay each message, and report `received` to the persist sink.
 */
export async function dispatchWebhook(input: {
	claw: ClawLike;
	channel: Channel;
	endpoint: EndpointContext;
	request: InboundRequest;
	persist: PersistEndpointEvent;
	/** Absent ⇒ this claw has no database, so there is nowhere to record a claim and a provider retry
	 *  replays the turn exactly as it did before. */
	inbox?: DeliveryInbox;
	outbox?: DeliveryOutbox;
	/** The plugin's tokenize door, so an admitted payload is stored redacted into the claw's container
	 *  rather than raw. Absent ⇒ stored as it arrived, which is what a claw with no redactor does with
	 *  its transcript too. */
	redact?: RedactValue;
}): Promise<ChannelDispatchResult> {
	const { claw, channel, endpoint, request } = input;
	// Authentication is NOT optional here. `if (channel.verify)` read as "verify when the channel
	// offers it", which means a channel that simply does not implement `verify` — a new provider, a
	// half-finished one — serves every anonymous POST that reaches its URL as a genuine message from
	// the provider, silently and with no error to notice. A webhook endpoint with nothing to
	// authenticate it is not an endpoint yet, so the absence is refused rather than skipped.
	if (!channel.verify) {
		return {
			status: 401,
			body: {
				ok: false,
				error: "unauthorized",
				reason: `channel "${channel.provider}" has no webhook verifier`,
			},
		};
	}
	const ok = await channel.verify({ request, endpoint });
	if (!ok) return { status: 401, body: { ok: false, error: "unauthorized" } };
	const messages = await channel.parseInbound({ request, endpoint });
	let processed = 0;
	for (const message of messages) {
		if (await relayOnce({ ...input, message })) processed += 1;
	}
	await input.persist({ kind: "received" });
	return {
		status: 200,
		// What this endpoint actually RAN, not what arrived: a retried delivery is answered 200 (the
		// provider must stop retrying) while contributing nothing, and the count says so.
		body: { ok: true, data: { processed } },
	};
}

/**
 * How long a delivery may be held before a retry may take it over. Generous, like the approval lease
 * and for the same reason: it has to outlast the slowest legitimate turn, because what it guards is a
 * process that DIED and what it would cause if set short is the same turn running twice.
 */
const DELIVERY_LEASE_MS = 15 * 60 * 1000;

/** How many times one delivery is attempted before it is buried rather than retried forever. */
const MAX_DELIVERY_ATTEMPTS = 5;

/** How long a failed delivery waits before it is eligible again. */
const DELIVERY_BACKOFF_MS = 60 * 1000;

/** The same two bounds for the outbound half — a reply that cannot be delivered is buried rather
 *  than retried by every drain forever. */
const MAX_OUTBOX_ATTEMPTS = 5;
const OUTBOX_BACKOFF_MS = 60 * 1000;

/**
 * Tokenize plugin-held data — the plugin's own `redact` door, threaded from configure.
 *
 * Optional because a claw assembled without a redactor has none; the assembly supplies the identity
 * function in that case, so this is `undefined` only on paths that never had a plugin context at all.
 */
export type RedactValue = (
	value: unknown,
	opts?: { clawId?: string },
) => Promise<unknown>;

/**
 * Admit one inbound message as durable work, and say whether this call is the one that admitted it.
 *
 * This is the write the whole finding turns on. The delivery row used to be created ALREADY
 * `processing`, by the same request that was running the turn, and it carried no copy of the message —
 * so a turn that died left a lease over something nobody had stored, the provider had already been
 * answered 200 and would not send it again, and no worker could recover a message it had never been
 * told about.
 *
 * Everything here is cheap and deterministic: resolve where the conversation lands, tokenize the
 * message, write the row. The expensive, failure-prone part — the model turn — happens after, against
 * a row that survives the process running it.
 */
async function admitDelivery(input: {
	claw: ClawLike;
	endpoint: EndpointContext;
	message: InboundMessage;
	key: DeliveryKey;
	inbox: DeliveryInbox;
	redact?: RedactValue;
}): Promise<boolean> {
	const { claw, endpoint, message } = input;
	// Already finished, already queued, already dead: whatever it is, it is not new work, and resolving
	// where it would have landed costs a governed api call to learn nothing. The insert below is still
	// what decides — this only avoids paying for the answer twice.
	if (await input.inbox.known(input.key)) return false;
	// The dispatch acts for a stranger (no authenticated principal) — the app-authz caller is
	// `system:anonymous`, the same principal a fresh binding stamps as the claw's `createdBy`, so the
	// owner rule permits relaying into that conversation's own claw.
	const binding = await claw.api.bindConversation(
		{
			provider: endpoint.provider,
			endpointKey: endpoint.endpointKey,
			externalConversationId: message.externalConversationId,
			externalActorId: message.externalActorId,
			claw: endpoint.claw,
			thread: {
				...endpoint.thread,
				title: endpoint.thread?.title ?? message.conversationTitle,
			},
		},
		{ principal: endpointPrincipal(endpoint) },
	);
	// Into the CLAW's container, not the plugin's. A token minted in the plugin container is INERT when
	// the runtime rehydrates in the claw's — it would reach the model as a raw placeholder, silently,
	// with nothing thrown. Same container the transcript uses, so the same value wears the same token.
	const payload = await tokenize(
		normalizeForStorage(message),
		binding.claw.id,
		input.redact,
	);
	return input.inbox.admit(input.key, {
		payload,
		clawId: binding.claw.id,
		threadId: binding.thread.id,
	});
}

/** The message as it is stored: every field the run and the reply need, and nothing else. */
function normalizeForStorage(message: InboundMessage): JsonObject {
	return {
		externalConversationId: message.externalConversationId,
		text: message.text,
		...(message.externalActorId !== undefined
			? { externalActorId: message.externalActorId }
			: {}),
		...(message.replyContext !== undefined
			? { replyContext: message.replyContext }
			: {}),
	};
}

/** Redact through the plugin door, refusing anything that did not come back as a stored payload. */
async function tokenize(
	payload: JsonObject,
	clawId: string,
	redact?: RedactValue,
): Promise<JsonObject> {
	if (redact === undefined) return payload;
	const tokenized = await redact(payload, { clawId });
	// The redactor walks a value and hands back the same shape. If it did not, storing the result would
	// put something unreadable where the worker expects a message — loud here beats a row that claims
	// to be work and cannot be run.
	if (
		typeof tokenized !== "object" ||
		tokenized === null ||
		Array.isArray(tokenized)
	) {
		throw stateError("channel delivery payload could not be tokenized", {
			reason: "the redactor returned something other than the payload object",
		});
	}
	return tokenized as JsonObject;
}

/** What the reply half needs back out of a stored payload. */
function replyTargetOf(work: DeliveryWork): {
	externalConversationId: string;
	text: string;
	replyContext?: JsonValue;
} | null {
	const payload = work.payload;
	const conversation = payload.externalConversationId;
	const text = payload.text;
	if (typeof conversation !== "string" || typeof text !== "string") return null;
	return {
		externalConversationId: conversation,
		text,
		...(payload.replyContext !== undefined
			? { replyContext: payload.replyContext }
			: {}),
	};
}

/**
 * Run one admitted delivery under a lease this caller already holds: the turn, the reply, and the
 * transition that ends it.
 *
 * Separated from admission so the SAME code runs the work whether it was reached inline from the
 * request that admitted it or swept up later by the worker. A recovery path that does not share the
 * live path's code is a recovery path nobody exercises.
 */
export async function runDelivery(input: {
	claw: ClawLike;
	channel: Channel;
	endpoint: EndpointContext;
	inbox: DeliveryInbox;
	outbox?: DeliveryOutbox;
	key: DeliveryKey;
	leaseId: string;
	work: DeliveryWork;
	leaseMs?: number;
	backoffMs?: number;
	maxAttempts?: number;
}): Promise<boolean> {
	const { claw, channel, endpoint, inbox, key, leaseId, work } = input;
	const leaseMs = input.leaseMs ?? DELIVERY_LEASE_MS;
	// The lease is EXTENDED while the turn runs, not merely set once at the start. A turn that
	// legitimately outran a fixed window — a long tool chain, a slow model — was indistinguishable
	// from a dead one, so a recovery took over work that was never stuck and ran it a second time.
	const stopHeartbeat = startLeaseHeartbeat({ inbox, key, leaseId, leaseMs });
	try {
		const text = await runTurn({
			claw,
			work,
			principal: endpointPrincipal(endpoint),
		});
		const target = replyTargetOf(work);
		if (text !== null && target !== null) {
			await deliverReply({
				channel,
				endpoint,
				key,
				reply: {
					externalConversationId: target.externalConversationId,
					text,
					...(target.replyContext !== undefined
						? { replyContext: target.replyContext }
						: {}),
				},
				...(input.outbox !== undefined ? { outbox: input.outbox } : {}),
			});
		}
	} catch (error) {
		// The row goes BACK to the queue rather than being abandoned mid-flight. Left `processing`, it
		// would wait out a full lease before anything could touch it again; dropped, the message would
		// be lost exactly as it was before any of this existed.
		const landed = await inbox.fail({
			key,
			leaseId,
			error: errorMessage(error),
			backoffMs: input.backoffMs ?? DELIVERY_BACKOFF_MS,
			maxAttempts: input.maxAttempts ?? MAX_DELIVERY_ATTEMPTS,
		});
		// A displaced attempt's failure says nothing about the attempt that now owns the row, so it is
		// not reported as this delivery's failure either.
		if (landed === "lost") return false;
		throw error;
	} finally {
		stopHeartbeat();
	}
	// FENCED. A completion from a lease that is no longer current is refused, so a runner displaced by
	// a recovery cannot mark the delivery finished over the top of the attempt now running it.
	//
	// There is nothing to cancel when that happens: `sendMessage` takes no abort signal, so a displaced
	// turn runs to its end. The damage is bounded to wasted work rather than a duplicate message — its
	// reply meets the outbox's one-reply-per-delivery rule and is not sent.
	return await inbox.complete(key, leaseId);
}

/** The model turn itself, over the stored payload. Null ⇒ nothing to reply with. */
async function runTurn(input: {
	claw: ClawLike;
	work: DeliveryWork;
	/** The endpoint's service principal — the SAME identity the binding was stamped with, or the owner
	 *  rule would deny the run into a claw this dispatch itself created. */
	principal: Principal;
}): Promise<string | null> {
	const target = replyTargetOf(input.work);
	// A stored payload that is not a message is not runnable. Thrown rather than skipped: it means the
	// row was written by something that did not agree with this code about what a delivery is.
	if (target === null) {
		throw stateError("stored channel delivery is not a message", {
			reason: "the payload carries no externalConversationId/text pair",
		});
	}
	const sent = await input.claw.api.sendMessage(
		{
			clawId: input.work.clawId,
			threadId: input.work.threadId,
			// Tokenized on the way in and rehydrated by the runtime at the model boundary — the same
			// round-trip a resumed run makes over its stored transcript.
			message: target.text,
		},
		{ principal: input.principal },
	);
	if (sent.result.status !== "completed" || !sent.result.text) return null;
	return sent.result.text;
}

/**
 * Relay one inbound message AT MOST ONCE, and say whether this call is the one that ran it.
 *
 * A provider retries — on a non-2xx, on a timeout, on its own schedule — and a poll can overlap the
 * previous one. Both replay messages that were already handled, and without a claim each replay was a
 * fresh turn: another model charge, another set of tool calls, another reply, under a new run id.
 *
 * A message with no `deliveryId` cannot be de-duplicated, and no inbox means nowhere to record the
 * work. Both relay as before rather than refusing — the alternative is a channel that silently stops
 * delivering — but they are the deployments where the replay remains possible, and that is the honest
 * shape of it rather than a guarantee that quietly does not hold.
 */
async function relayOnce(input: {
	claw: ClawLike;
	channel: Channel;
	endpoint: EndpointContext;
	message: InboundMessage;
	inbox?: DeliveryInbox;
	outbox?: DeliveryOutbox;
	redact?: RedactValue;
}): Promise<boolean> {
	const { claw, channel, endpoint, message, inbox, outbox } = input;
	const deliveryId = message.deliveryId;
	if (inbox === undefined || deliveryId === undefined) {
		await handleInbound({
			claw,
			channel,
			endpoint,
			message,
			...(outbox !== undefined ? { outbox } : {}),
		});
		return true;
	}
	const key = {
		provider: channel.provider,
		endpointKey: endpoint.endpointKey,
		deliveryId,
	};
	// ADMITTED BEFORE THE TURN, and before the provider is told anything. A row written afterwards
	// would be recording history, and the whole point is to have something to recover from when the
	// history never gets written.
	const admitted = await admitDelivery({
		claw,
		endpoint,
		message,
		key,
		inbox,
		...(input.redact !== undefined ? { redact: input.redact } : {}),
	});
	// Already known — a retry, or a poll re-reading what it read last time. The row owns finishing it.
	if (!admitted) return false;
	// The first attempt happens HERE rather than being left to the next drain, so the reply is as fast
	// as it ever was. What changed is that failing no longer loses the message: the row is already
	// durable, and the worker finishes what this attempt does not.
	const claimed = await inbox.claim(key, DELIVERY_LEASE_MS);
	if (claimed === null) return false;
	return await runDelivery({
		claw,
		channel,
		endpoint,
		inbox,
		key,
		leaseId: claimed.leaseId,
		work: claimed.work,
		...(outbox !== undefined ? { outbox } : {}),
	});
}

/**
 * Keep saying "still here" until the turn is done, and give up the moment the lease is gone.
 *
 * Unref'd so a pending tick never holds a process open, and stopped in a `finally` so a turn that
 * throws does not leave a timer extending a lease nobody is using. The same shape the approval lease
 * uses (`startApprovalHeartbeat`), which is where this problem was solved the first time.
 */
function startLeaseHeartbeat(input: {
	inbox: DeliveryInbox;
	key: DeliveryKey;
	leaseId: string;
	leaseMs: number;
}): () => void {
	const timers = globalThis as typeof globalThis & {
		setInterval: (fn: () => void, ms: number) => { unref?: () => void };
		clearInterval: (timer: unknown) => void;
	};
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		timers.clearInterval(timer);
	};
	const timer = timers.setInterval(
		() => {
			void input.inbox
				.heartbeat(input.key, input.leaseId, input.leaseMs)
				// Lost, or unreachable: either way this runner has no lease to extend, and continuing to
				// ask would only keep a timer alive for a row that is not ours.
				.then((held) => {
					if (!held) stop();
				})
				.catch(stop);
		},
		// A third of the window, so two ticks can be missed before the lease actually lapses.
		Math.max(250, Math.floor(input.leaseMs / 3)),
	) as { unref?: () => void };
	timer.unref?.();
	return stop;
}

/**
 * Poll one already-resolved endpoint: ask the channel for new messages from the context's cursor,
 * relay them, and report the advanced cursor to the persist sink. On failure the sink gets a
 * `poll-error` event and the error is rethrown so the cron surfaces it.
 */
export async function pollEndpoint(input: {
	claw: ClawLike;
	channel: Channel;
	endpoint: EndpointContext;
	persist: PersistEndpointEvent;
	limit?: number;
	inbox?: DeliveryInbox;
	outbox?: DeliveryOutbox;
	redact?: RedactValue;
}): Promise<{ processed: number }> {
	const { claw, channel, endpoint } = input;
	if (!channel.poll) return { processed: 0 };
	try {
		const result = await channel.poll({
			endpoint,
			cursor: endpoint.cursor,
			limit: input.limit,
		});
		let processed = 0;
		for (const message of result.messages) {
			// Polls OVERLAP: a cursor advanced after the batch means a poll that starts before the
			// previous one finishes re-reads the same messages. The claim is what makes that harmless.
			if (await relayOnce({ ...input, message })) processed += 1;
		}
		await input.persist({ kind: "polled", cursor: result.cursor });
		return { processed };
	} catch (error) {
		await input.persist({
			kind: "poll-error",
			error: { message: errorMessage(error) },
		});
		throw error;
	}
}

/** Where a stored delivery or reply belongs: the transport, and the endpoint context to use with it. */
export type ResolvedEndpoint = { channel: Channel; endpoint: EndpointContext };

/** Resolve the endpoint a stored row belongs to. `undefined` ⇒ it cannot be resolved right now. */
export type EndpointResolver = (
	key: DeliveryKey,
) => Promise<ResolvedEndpoint | undefined> | ResolvedEndpoint | undefined;

/**
 * Run the deliveries nobody is running — the recovery half of the inbound queue.
 *
 * The inline attempt on the request path covers the common case, and this covers every way that
 * attempt can fail to finish: the process died mid-turn, the model was down, the row was admitted by
 * a request that never got to claim it. Without this a delivery could be perfectly stored and never
 * run, which is a quieter failure than losing it and just as final.
 *
 * Both due shapes are swept — pending work past its backoff, and processing rows whose lease has
 * lapsed — and each runs through the SAME `runDelivery` the live path uses, because a recovery path
 * that does not share the live path's code is a recovery path nobody exercises.
 */
export async function drainDeliveries(input: {
	claw: ClawLike;
	inbox: DeliveryInbox;
	outbox?: DeliveryOutbox;
	endpointFor: EndpointResolver;
	limit?: number;
	leaseMs?: number;
	backoffMs?: number;
	maxAttempts?: number;
}): Promise<{ processed: number; failed: number }> {
	const leaseMs = input.leaseMs ?? DELIVERY_LEASE_MS;
	const maxAttempts = input.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
	const backoffMs = input.backoffMs ?? DELIVERY_BACKOFF_MS;
	const due = await input.inbox.claimDue({
		leaseMs,
		...(input.limit !== undefined ? { limit: input.limit } : {}),
	});
	let processed = 0;
	let failed = 0;
	for (const claimed of due) {
		const resolved = await input.endpointFor(claimed.key);
		if (resolved === undefined) {
			// A revoked registration, a provider no longer configured: this delivery cannot be run, now
			// or later. Recorded as a failed attempt rather than released, so it backs off and is
			// eventually buried — releasing it would hand the same unrunnable row to every future drain,
			// forever, and dropping it would erase a message somebody sent.
			await input.inbox.fail({
				key: claimed.key,
				leaseId: claimed.leaseId,
				error: `no endpoint for ${claimed.key.provider}/${claimed.key.endpointKey}`,
				backoffMs,
				maxAttempts,
			});
			failed += 1;
			continue;
		}
		try {
			const ran = await runDelivery({
				claw: input.claw,
				channel: resolved.channel,
				endpoint: resolved.endpoint,
				inbox: input.inbox,
				key: claimed.key,
				leaseId: claimed.leaseId,
				work: claimed.work,
				leaseMs,
				backoffMs,
				maxAttempts,
				...(input.outbox !== undefined ? { outbox: input.outbox } : {}),
			});
			if (ran) processed += 1;
			else failed += 1;
		} catch {
			// `runDelivery` has already recorded the attempt and set the backoff; it rethrows so a live
			// request surfaces the error. A drain must not stop on one bad row — the rest of the queue is
			// other people's messages.
			failed += 1;
		}
	}
	return { processed, failed };
}

/**
 * Finish the replies a crash left owed — the recovery half of the outbound queue.
 *
 * A reply is written before it is sent and marked after, so anything still `pending` is a send that
 * either never happened or never got acknowledged. Both are re-sent: a duplicate message is visible
 * and recoverable, a lost one is neither.
 *
 * Now CLAIMED rather than merely read. The old shape listed pending rows and sent them, so two drains
 * overlapping — or one drain overlapping the request that had just enqueued — both sent the same
 * reply. The queue built to make a lost reply impossible produced duplicate ones instead.
 */
export async function drainOutbox(input: {
	outbox: DeliveryOutbox;
	endpointFor: EndpointResolver;
	limit?: number;
	leaseMs?: number;
	backoffMs?: number;
	maxAttempts?: number;
}): Promise<{ sent: number; failed: number }> {
	const owed = await input.outbox.claimPending({
		leaseMs: input.leaseMs ?? DELIVERY_LEASE_MS,
		...(input.limit !== undefined ? { limit: input.limit } : {}),
	});
	let sent = 0;
	let failed = 0;
	for (const row of owed) {
		const key = {
			provider: row.provider,
			endpointKey: row.endpointKey,
			deliveryId: row.deliveryId,
		};
		const resolved = await input.endpointFor(key);
		if (resolved === undefined) {
			// A provider that is no longer configured, or an endpoint that has been revoked. Recorded as
			// a failure so it backs off and is eventually buried, rather than left for every future drain
			// to re-resolve and re-fail. Dropping it would erase the evidence that somebody is still owed
			// an answer.
			await input.outbox.markFailed({
				key,
				leaseId: row.leaseId,
				error: `no endpoint for ${row.provider}/${row.endpointKey}`,
				backoffMs: input.backoffMs ?? OUTBOX_BACKOFF_MS,
				maxAttempts: input.maxAttempts ?? MAX_OUTBOX_ATTEMPTS,
			});
			failed += 1;
			continue;
		}
		try {
			await resolved.channel.send({
				endpoint: resolved.endpoint,
				message: {
					externalConversationId: row.externalConversationId,
					text: row.text,
					...(row.replyContext !== undefined
						? { replyContext: row.replyContext }
						: {}),
				},
			});
			// Only the lease that sent it may say so.
			if (await input.outbox.markSent(key, row.leaseId)) sent += 1;
			else failed += 1;
		} catch (error) {
			await input.outbox.markFailed({
				key,
				leaseId: row.leaseId,
				error: errorMessage(error),
				backoffMs: input.backoffMs ?? OUTBOX_BACKOFF_MS,
				maxAttempts: input.maxAttempts ?? MAX_OUTBOX_ATTEMPTS,
			});
			failed += 1;
		}
	}
	return { sent, failed };
}
