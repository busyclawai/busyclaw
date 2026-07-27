// The shared dispatch engine — protocol only. The calling mode resolves the endpoint (code
// declaration for app bots, registration row for registrations mode), assembles the normalized
// EndpointContext, and supplies a persist sink for state events; the engine owns the
// verify → parse → bind → relay → reply round-trip and never touches storage.

import { errorMessage, SYSTEM_ANONYMOUS } from "@busyclaw/contracts";
import type { ClawLike } from "./claw";
import type {
	Channel,
	EndpointContext,
	InboundMessage,
	InboundRequest,
	PersistEndpointEvent,
} from "./contracts";
import type { DeliveryInbox } from "./inbox";

export type ChannelDispatchResult = {
	status: number;
	body: unknown;
};

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
}): Promise<void> {
	const { claw, channel, endpoint, message } = input;
	// The dispatch acts for a stranger (no authenticated principal) — the app-authz caller is
	// `system:anonymous`, the same principal a fresh binding stamps as the claw's `createdBy`, so the
	// owner rule permits relaying into that conversation's own claw.
	const caller = { principal: SYSTEM_ANONYMOUS };
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
	if (sent.result.status === "completed" && sent.result.text) {
		await channel.send({
			endpoint,
			message: {
				externalConversationId: message.externalConversationId,
				text: sent.result.text,
				replyContext: message.replyContext,
			},
		});
	}
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

/**
 * Relay one inbound message AT MOST ONCE, and say whether this call is the one that ran it.
 *
 * A provider retries — on a non-2xx, on a timeout, on its own schedule — and a poll can overlap the
 * previous one. Both replay messages that were already handled, and without a claim each replay was a
 * fresh turn: another model charge, another set of tool calls, another reply, under a new run id.
 *
 * A message with no `deliveryId` cannot be de-duplicated, and no inbox means nowhere to record the
 * claim. Both relay as before rather than refusing — the alternative is a channel that silently stops
 * delivering — but they are the deployments where the replay remains possible, and that is the honest
 * shape of it rather than a guarantee that quietly does not hold.
 */
async function relayOnce(input: {
	claw: ClawLike;
	channel: Channel;
	endpoint: EndpointContext;
	message: InboundMessage;
	inbox?: DeliveryInbox;
}): Promise<boolean> {
	const { claw, channel, endpoint, message, inbox } = input;
	const deliveryId = message.deliveryId;
	if (inbox === undefined || deliveryId === undefined) {
		await handleInbound({ claw, channel, endpoint, message });
		return true;
	}
	const key = {
		provider: channel.provider,
		endpointKey: endpoint.endpointKey,
		deliveryId,
	};
	// Claimed BEFORE the turn: a claim taken afterwards would be recording history, and the second
	// arrival is already halfway through its own run by then.
	if (!(await inbox.claim(key, DELIVERY_LEASE_MS))) return false;
	await handleInbound({ claw, channel, endpoint, message });
	await inbox.complete(key);
	return true;
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
