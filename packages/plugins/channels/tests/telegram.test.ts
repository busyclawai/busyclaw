import { buildSecrets, env } from "@euroclaw/secrets";
import { describe, expect, it } from "vitest";
import {
	dispatchWebhook,
	type EndpointContext,
	type EndpointEvent,
} from "../src/index";
import {
	type TelegramFetch,
	telegram,
	telegramWebhookSecret,
} from "../src/telegram/index";

// The app bot resolves its token ONLY through the one-door reader the plugin threads onto the endpoint.
// This shared reader resolves the unnamed bot's TELEGRAM_BOT_TOKEN to "app-token" — what the derived
// verify secret and the /botapp-token/ URLs below check against.
const appTokenSecrets = buildSecrets([
	env({ vars: { TELEGRAM_BOT_TOKEN: "app-token" } }),
]);

const endpoint: EndpointContext = {
	provider: "telegram",
	endpointKey: "default",
	mode: "webhook",
	secrets: appTokenSecrets,
};

/** An app-bot endpoint (the default key) carrying a one-door reader — what the plugin threads. */
function appEndpoint(secrets: EndpointContext["secrets"]): EndpointContext {
	return {
		provider: "telegram",
		endpointKey: "default",
		mode: "webhook",
		secrets,
	};
}

/** A fake Bot API server: records every call and serves canned getUpdates results. */
function fakeApi() {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const api = {
		calls,
		updates: [] as unknown[],
		fetch: (async (url, init) => {
			const body = init?.body
				? (JSON.parse(init.body) as Record<string, unknown>)
				: {};
			calls.push({ url, body });
			const result = url.endsWith("/getUpdates") ? api.updates : {};
			return { ok: true, json: async () => ({ ok: true, result }) };
		}) as TelegramFetch,
	};
	return api;
}

function update(overrides: Record<string, unknown> = {}) {
	return {
		update_id: 10,
		message: { message_id: 1, text: "hello", chat: { id: 123 }, ...overrides },
	};
}

describe("telegram channel", () => {
	it("parses a text update into a normalized inbound message", () => {
		const channel = telegram();
		const messages = channel.parseInbound({
			request: {
				headers: { get: () => null },
				rawBody: JSON.stringify(update()),
			},
			endpoint,
		});
		expect(messages).toEqual([
			{
				externalConversationId: "123",
				externalActorId: undefined,
				text: "hello",
				conversationTitle: undefined,
				replyContext: { messageId: 1 },
			},
		]);
	});

	it("ignores updates without a text message", () => {
		const channel = telegram();
		const noText = channel.parseInbound({
			request: {
				headers: { get: () => null },
				rawBody: JSON.stringify({
					update_id: 11,
					message: { chat: { id: 1 } },
				}),
			},
			endpoint,
		});
		expect(noText).toEqual([]);
	});

	it("rejects a non-JSON webhook body as a validation error, not a crash", () => {
		const channel = telegram();
		expect(() =>
			channel.parseInbound({
				request: { headers: { get: () => null }, rawBody: "not-json{" },
				endpoint,
			}),
		).toThrow(/invalid JSON/);
	});

	it("verifies against the secret derived from the bot token — no second credential", async () => {
		const channel = telegram({ fetch: fakeApi().fetch });
		const headers = (value: string | null) => ({
			request: { headers: { get: () => value }, rawBody: "{}" },
			endpoint,
		});
		expect(
			await channel.verify?.(headers(telegramWebhookSecret("app-token"))),
		).toBe(true);
		expect(await channel.verify?.(headers("wrong"))).toBe(false);
	});

	it("identifies a registration by the secret_token telegram echoes in the header", async () => {
		const channel = telegram();
		const at = (value: string | null) =>
			channel.identify?.({
				headers: {
					get: (name) =>
						name === "x-telegram-bot-api-secret-token" ? value : null,
				},
				rawBody: "{}",
			});
		expect(await at("route-token")).toBe("route-token");
		expect(await at(null)).toBeUndefined();
	});

	it("derives a registered bot's secret from its row token, unless webhookSecret overrides", async () => {
		const channel = telegram(); // bare transport — nothing configured in code
		const row = (
			overrides: Partial<EndpointContext>,
		): ((value: string | null) => {
			request: { headers: { get: () => string | null }; rawBody: string };
			endpoint: EndpointContext;
		}) => {
			const registration: EndpointContext = {
				provider: "telegram",
				endpointKey: "acme-bot",
				mode: "webhook",
				...overrides,
			};
			return (value) => ({
				request: { headers: { get: () => value }, rawBody: "{}" },
				endpoint: registration,
			});
		};

		// derived from the row's bot token
		const derived = row({ secret: "row-token" });
		expect(
			await channel.verify?.(derived(telegramWebhookSecret("row-token"))),
		).toBe(true);
		expect(await channel.verify?.(derived("wrong"))).toBe(false);

		// an explicit webhookSecret on the row wins over derivation
		const explicit = row({ secret: "row-token", webhookSecret: "chosen" });
		expect(await channel.verify?.(explicit("chosen"))).toBe(true);
		expect(
			await channel.verify?.(explicit(telegramWebhookSecret("row-token"))),
		).toBe(false);
	});

	it("fails closed when a registration has no token to derive a secret from", async () => {
		const channel = telegram();
		// a registered bot (not the app-bot key) with neither a stored secret nor a
		// webhookSecret — nothing to verify against, so fail closed and loud. (The app bot's own
		// no-token case fails loud with "telegram bot has no token" — covered below.)
		await expect(
			channel.verify?.({
				request: { headers: { get: () => null }, rawBody: "{}" },
				endpoint: {
					provider: "telegram",
					endpointKey: "acme-bot",
					mode: "webhook",
				},
			}),
		).rejects.toThrow(/no secret/);
	});

	it("resolves the app bot's token through the one-door reader (secrets.get)", async () => {
		const secrets = buildSecrets([
			env({ vars: { TELEGRAM_BOT_TOKEN: "env-token" } }),
		]);
		const api = fakeApi();
		const channel = telegram({ fetch: api.fetch }); // no inline token — the reader supplies it
		const ep = appEndpoint(secrets);
		// verify derives its secret from the reader-resolved token
		expect(
			await channel.verify?.({
				request: {
					headers: { get: () => telegramWebhookSecret("env-token") },
					rawBody: "{}",
				},
				endpoint: ep,
			}),
		).toBe(true);
		// and send puts that same (memoized) resolved token on the wire
		await channel.send({
			message: { externalConversationId: "1", text: "hi" },
			endpoint: ep,
		});
		expect(api.calls[0]?.url).toBe(
			"https://api.telegram.org/botenv-token/sendMessage",
		);
	});

	it("honours a secrets alias remap for the app bot's token", async () => {
		const secrets = buildSecrets([
			env({
				aliases: { TELEGRAM_BOT_TOKEN: "PROD_TELEGRAM" },
				vars: { PROD_TELEGRAM: "prod-token" },
			}),
		]);
		const channel = telegram();
		expect(
			await channel.verify?.({
				request: {
					headers: { get: () => telegramWebhookSecret("prod-token") },
					rawBody: "{}",
				},
				endpoint: appEndpoint(secrets),
			}),
		).toBe(true);
	});

	it("resolves a named bot's token under its own tokenRef, not the base name", async () => {
		// two secrets in one reader: the base name AND the named bot's ref — the named bot must read
		// its ref, never the base, so two bots can't collide.
		const secrets = buildSecrets([
			env({
				vars: {
					TELEGRAM_BOT_TOKEN: "default-token",
					SALES_BOT: "sales-token",
				},
			}),
		]);
		const api = fakeApi();
		const channel = telegram({
			name: "sales",
			tokenRef: "SALES_BOT",
			fetch: api.fetch,
		});
		// the named bot's endpoint key is its name; it resolves SALES_BOT → "sales-token"
		const salesEndpoint: EndpointContext = {
			provider: "telegram",
			endpointKey: "sales",
			mode: "webhook",
			secrets,
		};
		expect(
			await channel.verify?.({
				request: {
					headers: { get: () => telegramWebhookSecret("sales-token") },
					rawBody: "{}",
				},
				endpoint: salesEndpoint,
			}),
		).toBe(true);
		await channel.send({
			message: { externalConversationId: "1", text: "hi" },
			endpoint: salesEndpoint,
		});
		expect(api.calls[0]?.url).toBe(
			"https://api.telegram.org/botsales-token/sendMessage",
		);
	});

	it("fails loud when the reader resolves no token for the app bot", async () => {
		const secrets = buildSecrets([env({ vars: {} })]); // reader resolves nothing
		const channel = telegram();
		await expect(
			channel.send({
				message: { externalConversationId: "1", text: "hi" },
				endpoint: appEndpoint(secrets),
			}),
		).rejects.toThrow(/telegram bot has no token/);
		// verify on the same app bot fails loud identically (the memoized miss, not a fresh lookup)
		await expect(
			channel.verify?.({
				request: { headers: { get: () => "anything" }, rawBody: "{}" },
				endpoint: appEndpoint(secrets),
			}),
		).rejects.toThrow(/telegram bot has no token/);
	});

	it("sends a reply through the Bot API with the reply-to message id", async () => {
		const api = fakeApi();
		const channel = telegram({ fetch: api.fetch });
		await channel.send({
			message: {
				externalConversationId: "123",
				text: "hi back",
				replyContext: { messageId: 7 },
			},
			endpoint,
		});
		expect(api.calls).toMatchObject([
			{
				url: "https://api.telegram.org/botapp-token/sendMessage",
				body: { chat_id: "123", text: "hi back", reply_to_message_id: 7 },
			},
		]);
	});

	it("polls updates and advances the cursor past the highest update id", async () => {
		const api = fakeApi();
		api.updates = [
			update({ text: "one" }),
			{ update_id: 12, message: { text: "two", chat: { id: 9 } } },
		];
		const channel = telegram({
			mode: "poll",
			fetch: api.fetch,
		});
		const result = await channel.poll?.({
			endpoint: { ...endpoint, mode: "poll" },
			cursor: { offset: 5 },
		});
		expect(result?.messages.map((m) => m.text)).toEqual(["one", "two"]);
		expect(result?.cursor).toEqual({ offset: 13 });
		expect(api.calls[0]?.body).toMatchObject({ offset: 5 });
	});

	it("uses the registration row's token for registered bots", async () => {
		const api = fakeApi();
		const channel = telegram({ fetch: api.fetch }); // transport only — no code token
		await channel.send({
			message: { externalConversationId: "9", text: "reply" },
			endpoint: {
				provider: "telegram",
				endpointKey: "acme-bot",
				mode: "webhook",
				secret: "row-token",
			},
		});
		// the credential came straight off the row and onto the wire
		expect(api.calls[0]?.url).toBe(
			"https://api.telegram.org/botrow-token/sendMessage",
		);
	});

	it("never serves a registration with the app bot's token, even under a colliding key", async () => {
		const api = fakeApi();
		// the app bot could resolve its own token for the "default" key — the adversarial case
		const channel = telegram({ fetch: api.fetch });
		await channel.send({
			message: { externalConversationId: "9", text: "reply" },
			endpoint: {
				provider: "telegram",
				// a registration keyed "default" arrives under the namespaced binding key, so it can
				// never satisfy the code-key comparison — the row credential wins
				endpointKey: "registrations/default",
				mode: "webhook",
				secret: "row-token",
			},
		});
		expect(api.calls[0]?.url).toBe(
			"https://api.telegram.org/botrow-token/sendMessage",
		);
	});

	it("errors clearly on an endpoint with neither an app-bot key nor a stored secret", async () => {
		const channel = telegram({ fetch: fakeApi().fetch });
		// a key the app bot doesn't own, and no row credential to fall back on
		const unknown: EndpointContext = {
			provider: "telegram",
			endpointKey: "other-bot",
			mode: "poll",
		};
		await expect(
			channel.poll?.({ endpoint: unknown, cursor: undefined }),
		).rejects.toThrow(/no credentials/);
	});

	it("relays a telegram webhook end to end and replies through the Bot API", async () => {
		const api = fakeApi();
		const channel = telegram({ fetch: api.fetch });
		const events: EndpointEvent[] = [];
		const claw = {
			api: {
				bindConversation: async () => ({
					binding: { id: "b" },
					claw: { id: "claw-1" },
					thread: { id: "thread-1" },
					created: true,
				}),
				sendMessage: async () => ({
					result: { status: "completed", text: "pong" },
					userMessage: { id: "m" },
				}),
			},
		};

		const result = await dispatchWebhook({
			claw,
			channel,
			endpoint,
			request: {
				headers: {
					get: (name) =>
						name === "x-telegram-bot-api-secret-token"
							? telegramWebhookSecret("app-token")
							: null,
				},
				rawBody: JSON.stringify(update({ text: "ping", message_id: 4 })),
			},
			persist: async (event) => {
				events.push(event);
			},
		});

		expect(result.status).toBe(200);
		expect(api.calls).toMatchObject([
			{
				url: "https://api.telegram.org/botapp-token/sendMessage",
				body: { chat_id: "123", text: "pong", reply_to_message_id: 4 },
			},
		]);
		expect(events).toEqual([{ kind: "received" }]);
	});
});
