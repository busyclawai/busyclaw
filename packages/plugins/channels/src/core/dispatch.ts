// The shared dispatch engine — protocol only. The calling mode resolves the endpoint (code
// declaration for app bots, registration row for registrations mode), assembles the normalized
// EndpointContext, and supplies a persist sink for state events; the engine owns the
// verify → parse → bind → relay → reply round-trip and never touches storage.

import { errorMessage } from "@euroclaw/contracts";
import type { ClawLike } from "./claw";
import type {
	Channel,
	EndpointContext,
	InboundMessage,
	InboundRequest,
	PersistEndpointEvent,
} from "./contracts";

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
	const binding = await claw.api.bindConversation({
		provider: endpoint.provider,
		endpointKey: endpoint.endpointKey,
		externalConversationId: message.externalConversationId,
		externalActorId: message.externalActorId,
		claw: endpoint.claw,
		thread: {
			...endpoint.thread,
			title: endpoint.thread?.title ?? message.conversationTitle,
		},
	});
	const sent = await claw.api.sendMessage({
		clawId: binding.claw.id,
		threadId: binding.thread.id,
		message: message.text,
	});
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
}): Promise<ChannelDispatchResult> {
	const { claw, channel, endpoint, request } = input;
	if (channel.verify) {
		const ok = await channel.verify({ request, endpoint });
		if (!ok) return { status: 401, body: { ok: false, error: "unauthorized" } };
	}
	const messages = await channel.parseInbound({ request, endpoint });
	for (const message of messages) {
		await handleInbound({ claw, channel, endpoint, message });
	}
	await input.persist({ kind: "received" });
	return {
		status: 200,
		body: { ok: true, data: { processed: messages.length } },
	};
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
			await handleInbound({ claw, channel, endpoint, message });
			processed += 1;
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
