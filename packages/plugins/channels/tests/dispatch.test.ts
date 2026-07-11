import { describe, expect, it } from "vitest";
import {
	type Channel,
	dispatchWebhook,
	type EndpointContext,
	type EndpointEvent,
	pollEndpoint,
} from "../src/index";

// A fake claw whose api records what the engine relays and always replies with an echo. Enough to
// exercise the shared bind -> relay -> reply path without the full assembly.
function fakeClaw(recorded: { binds: unknown[]; relayed: string[] }) {
	return {
		api: {
			bindConversation: async (input: unknown) => {
				recorded.binds.push(input);
				return {
					binding: { id: "binding-1" },
					claw: { id: "claw-1" },
					thread: { id: "thread-1" },
					created: true,
				};
			},
			sendMessage: async (input: { message: string }) => {
				recorded.relayed.push(input.message);
				return {
					result: { status: "completed", text: `echo:${input.message}` },
					userMessage: { id: "message-1" },
				};
			},
		},
	};
}

function fakeChannel(overrides: Partial<Channel> = {}): Channel {
	return {
		provider: "fake",
		supports: { webhook: true, poll: true },
		mode: "webhook",
		parseInbound: ({ request }) => [
			{ externalConversationId: "chat-1", text: request.rawBody },
		],
		send: async () => {},
		...overrides,
	};
}

function endpoint(overrides: Partial<EndpointContext> = {}): EndpointContext {
	return {
		provider: "fake",
		endpointKey: "default",
		mode: "webhook",
		...overrides,
	};
}

function eventSink(events: EndpointEvent[]) {
	return async (event: EndpointEvent) => {
		events.push(event);
	};
}

describe("dispatch engine", () => {
	it("dispatches a webhook: verify -> parse -> bind -> relay -> reply -> report", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const replies: string[] = [];
		const events: EndpointEvent[] = [];
		const channel = fakeChannel({
			send: async ({ message }) => {
				replies.push(message.text);
			},
		});

		const result = await dispatchWebhook({
			claw: fakeClaw(recorded),
			channel,
			endpoint: endpoint({
				claw: { scope: "organization", scopeId: "acme", name: "Support bot" },
			}),
			request: { headers: { get: () => null }, rawBody: "hello" },
			persist: eventSink(events),
		});

		expect(result.status).toBe(200);
		expect(recorded.relayed).toEqual(["hello"]); // message reached the claw
		expect(replies).toEqual(["echo:hello"]); // the run's text was sent back
		// the binding is endpoint-keyed; whose data it is rides the claw defaults
		expect(recorded.binds).toMatchObject([
			{
				provider: "fake",
				endpointKey: "default",
				externalConversationId: "chat-1",
				claw: { scope: "organization", scopeId: "acme", name: "Support bot" },
			},
		]);
		expect(events).toEqual([{ kind: "received" }]);
	});

	it("returns 401 and reports nothing when verify fails", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const events: EndpointEvent[] = [];

		const result = await dispatchWebhook({
			claw: fakeClaw(recorded),
			channel: fakeChannel({ verify: () => false }),
			endpoint: endpoint(),
			request: { headers: { get: () => null }, rawBody: "hello" },
			persist: eventSink(events),
		});

		expect(result.status).toBe(401);
		expect(recorded.relayed).toEqual([]);
		expect(events).toEqual([]);
	});

	it("polls from the context cursor, relays, and reports the advanced cursor", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const events: EndpointEvent[] = [];
		const channel = fakeChannel({
			poll: async ({ cursor }) => {
				const offset = (cursor as { offset?: number } | undefined)?.offset ?? 0;
				return {
					messages:
						offset === 0
							? [{ externalConversationId: "chat-1", text: "polled" }]
							: [],
					cursor: { offset: offset + 1 },
				};
			},
		});

		const first = await pollEndpoint({
			claw: fakeClaw(recorded),
			channel,
			endpoint: endpoint({ mode: "poll" }),
			persist: eventSink(events),
		});
		expect(first.processed).toBe(1);
		expect(recorded.relayed).toEqual(["polled"]);
		expect(events).toEqual([{ kind: "polled", cursor: { offset: 1 } }]);

		// the caller re-assembles the context from persisted state -> resumes past the cursor
		const second = await pollEndpoint({
			claw: fakeClaw(recorded),
			channel,
			endpoint: endpoint({ mode: "poll", cursor: { offset: 1 } }),
			persist: eventSink(events),
		});
		expect(second.processed).toBe(0);
		expect(events).toEqual([
			{ kind: "polled", cursor: { offset: 1 } },
			{ kind: "polled", cursor: { offset: 2 } },
		]);
	});

	it("reports a poll-error and rethrows when a poll fails", async () => {
		const events: EndpointEvent[] = [];
		const channel = fakeChannel({
			poll: async () => {
				throw new Error("provider down");
			},
		});
		await expect(
			pollEndpoint({
				claw: fakeClaw({ binds: [], relayed: [] }),
				channel,
				endpoint: endpoint({ mode: "poll" }),
				persist: eventSink(events),
			}),
		).rejects.toThrow(/provider down/);
		expect(events).toEqual([
			{ kind: "poll-error", error: { message: "provider down" } },
		]);
	});
});
