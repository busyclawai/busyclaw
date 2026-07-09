import {
	configurationError,
	errorMessage,
	validationError,
} from "@euroclaw/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import {
	APP_ENDPOINT_KEY,
	type Channel,
	type ChannelEndpointMode,
	type EndpointContext,
	type InboundMessage,
} from "../core/contracts";
import {
	createTelegramClient,
	type TelegramClient,
	type TelegramFetch,
} from "./client";

// ── Telegram wire format (the untrusted-boundary schemas the adapter parses into normalized messages) ─
const telegramId = type("string | number");
const telegramUser = type({
	id: telegramId,
	"is_bot?": "boolean | undefined",
	"first_name?": "string | undefined",
	"username?": "string | undefined",
});
const telegramChat = type({
	id: telegramId,
	"type?": "string | undefined",
	"title?": "string | undefined",
	"username?": "string | undefined",
});
const telegramMessage = type({
	"message_id?": "number | undefined",
	"text?": "string | undefined",
	chat: telegramChat,
	"from?": telegramUser.or("undefined"),
});
const telegramUpdate = type({
	update_id: "number",
	"message?": telegramMessage.or("undefined"),
});
const telegramUpdates = telegramUpdate.array();
const telegramCursor = type({ "offset?": "number | undefined" });

type TelegramUpdate = typeof telegramUpdate.infer;

/** Shared config for the app's own telegram bot — everything except the (name, tokenRef) pairing. */
type TelegramConfigBase = {
	/** Transport for the app's own bot; defaults to webhook (poll is opt-in and contributes the cron). */
	mode?: ChannelEndpointMode;
	/** Bot API base URL for a self-hosted server; defaults to https://api.telegram.org. */
	apiBaseUrl?: string;
	/** Fetch implementation override (proxies, tests); defaults to global fetch. */
	fetch?: TelegramFetch;
	poll?: { limit?: number; timeoutSeconds?: number };
};

/**
 * The app bot's config. euroclaw keeps NO token in code: the bot's own token resolves ONLY through
 * the channels plugin's one-door reader — `secrets.get(tokenRef)` (env-backed by default, so an org's
 * aliases/providers are honoured), lazily on the first webhook/send. The two shapes make a multi-bot
 * set impossible to collide on one secret:
 *   - the single unnamed bot may omit `tokenRef` (it defaults to the canonical `TELEGRAM_BOT_TOKEN`);
 *   - a NAMED bot — which `channels()` demands the moment two telegram bots are registered — MUST
 *     carry its own `tokenRef`, so each named bot resolves its own token with no derived-name guessing.
 */
export type TelegramConfig =
	| (TelegramConfigBase & {
			name?: undefined;
			/** Secret name this bot's token resolves under; defaults to `TELEGRAM_BOT_TOKEN`. */
			tokenRef?: string;
	  })
	| (TelegramConfigBase & {
			/**
			 * Distinguishes multiple app bots — becomes the bot's endpoint key and webhook path segment
			 * (/channels/telegram/webhook/:name). channels() demands distinct names once two telegram bots
			 * are registered (compile-time + runtime).
			 */
			name: string;
			/** Secret name this named bot's token resolves under — required so two named bots never collide. */
			tokenRef: string;
	  });

/**
 * The webhook secret for a bot — derived from its token (domain-separated hash), so verification
 * needs no second credential: telegraf's secretPathComponent precedent, on Telegram's official
 * secret_token mechanism. Pass this value as `secret_token` when you call setWebhook; `verify`
 * expects it in the X-Telegram-Bot-Api-Secret-Token header. A connection row's explicit
 * webhookSecret overrides the derivation.
 */
export function telegramWebhookSecret(token: string): string {
	return bytesToHex(
		sha256(utf8ToBytes(`euroclaw:telegram:webhook-secret:${token}`)),
	);
}

/** The default secret name the single unnamed app bot resolves under; a named bot sets its own tokenRef. */
const DEFAULT_APP_BOT_TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";

function parseUpdate(input: unknown): TelegramUpdate {
	const valid = telegramUpdate(input);
	if (valid instanceof type.errors) {
		throw validationError("telegram update invalid", valid.summary);
	}
	return valid;
}

function parseUpdates(input: unknown): TelegramUpdate[] {
	const valid = telegramUpdates(input);
	if (valid instanceof type.errors) {
		throw validationError("telegram updates invalid", valid.summary);
	}
	return valid;
}

function cursorOffset(cursor: unknown): number | undefined {
	if (cursor === undefined) return undefined;
	const valid = telegramCursor(cursor);
	return valid instanceof type.errors ? undefined : valid.offset;
}

// A telegram update → a normalized inbound message, or null when there's nothing to relay.
function inboundFrom(update: TelegramUpdate): InboundMessage | null {
	const message = update.message;
	if (!message?.text) return null;
	return {
		externalConversationId: String(message.chat.id),
		externalActorId:
			message.from?.id !== undefined ? String(message.from.id) : undefined,
		text: message.text,
		conversationTitle: message.chat.title ?? message.chat.username,
		replyContext:
			message.message_id !== undefined
				? { messageId: message.message_id }
				: undefined,
	};
}

function replyMessageId(replyContext: unknown): number | undefined {
	if (replyContext === null || typeof replyContext !== "object")
		return undefined;
	const id = (replyContext as { messageId?: unknown }).messageId;
	return typeof id === "number" ? id : undefined;
}

/** Compile-time poll flag: a channel contributes cron only when it declares a poll endpoint. */
type TelegramPoll<Config> = Config extends { mode: "poll" } ? true : false;

/** The literal bot name (feeds channels()'s distinct-key fold), or undefined for the unnamed bot. */
type TelegramName<Config> = Config extends { name: infer N extends string }
	? N
	: undefined;

/**
 * The Telegram channel. As the app's own bot (channels plugin) its token resolves lazily on first
 * traffic through the one-door reader the plugin threads onto the endpoint — `secrets.get(tokenRef)`,
 * defaulting to `TELEGRAM_BOT_TOKEN` for the unnamed bot; webhook verification derives from that
 * token, so nothing else is required. Bare `telegram()` is also the pure transport for registrations
 * mode: every endpoint-specific value (token, webhook secret, organization, defaults) resolves from the
 * registration row via the EndpointContext. The `$poll` marker lets `channels()` derive its cron
 * requirement at compile time; the overloads keep it a literal without a cast.
 */
export function telegram(): Channel & {
	readonly provider: "telegram";
	readonly name: undefined;
	readonly $poll: false;
};
export function telegram<const Config extends TelegramConfig>(
	config: Config,
): Channel & {
	readonly provider: "telegram";
	readonly name: TelegramName<Config>;
	readonly $poll: TelegramPoll<Config>;
};
export function telegram(
	config: TelegramConfig = {},
): Channel & { readonly $poll: boolean } {
	// Read (name, tokenRef) through a widened view: the config union already forbids a named bot
	// without a tokenRef at compile time; this reads them uniformly for the runtime mirror below.
	const { name, tokenRef }: { name?: string; tokenRef?: string } = config;
	const mode: ChannelEndpointMode = config.mode ?? "webhook";
	const key = name ?? APP_ENDPOINT_KEY;

	// Runtime mirror of the config union: a named app bot must name its own secret so two named bots
	// never resolve the same token (the compile-time requirement can be bypassed by widening to Channel[]).
	if (name !== undefined && tokenRef === undefined) {
		throw configurationError("telegram named bot has no tokenRef", {
			name,
			reason:
				"a named app bot must set tokenRef so it resolves its own token — telegram({ name, tokenRef })",
		});
	}
	// The secret name THIS bot's own token resolves under: its explicit tokenRef, else the canonical
	// default for the single unnamed bot.
	const appTokenSecret = tokenRef ?? DEFAULT_APP_BOT_TOKEN_SECRET;

	// The app-bot secret DECLARATION — the `channels` plugin aggregates it into `plugin.secrets` so the
	// required-names list enumerates this bot's token. (registrations mode ignores it: a registered bot's
	// token lives in its row, not under a `secrets.get` name.)
	const declaredSecret = {
		name: appTokenSecret,
		description:
			name !== undefined
				? `Telegram bot token for "${name}"`
				: "Telegram app-bot token",
	};

	// The app bot's OWN token, resolved lazily through the one-door reader threaded onto the endpoint
	// (secrets.get(appTokenSecret)) — euroclaw keeps no token in code, so an org's aliases/providers
	// are honoured. Memoized because one webhook needs it twice — the derived verify secret and the
	// send client. A resolver THROW (an infra outage) is deliberately NOT memoized, so the next request
	// retries; a null (unset) is a miss.
	let appToken: string | undefined;
	let appTokenResolved = false;
	const resolveAppToken = async (
		endpoint: EndpointContext,
	): Promise<string | undefined> => {
		if (appTokenResolved) return appToken;
		const material = await endpoint.secrets?.get(appTokenSecret, {
			organizationId: endpoint.claw?.organizationId,
		});
		appToken = material?.kind === "token" ? material.value : undefined;
		appTokenResolved = true;
		return appToken;
	};

	// The token for one endpoint: THIS bot's own key resolves the app token — and fails LOUD when the
	// bot has none, so the setup gap surfaces on first traffic (the one-door resolution is async, so it
	// can no longer be caught at startup); every other endpoint reads the credential stored on its
	// connection row (the sso model — read the credential back), unchanged.
	const tokenFor = async (
		endpoint: EndpointContext,
	): Promise<string | undefined> => {
		if (endpoint.endpointKey === key) {
			const resolved = await resolveAppToken(endpoint);
			if (resolved !== undefined) return resolved;
			throw configurationError("telegram bot has no token", {
				...(name !== undefined ? { name } : {}),
				tokenRef: appTokenSecret,
				reason: `set the ${appTokenSecret} secret (env by default), or pass telegram({ tokenRef })`,
			});
		}
		return endpoint.secret;
	};

	const clientFor = async (
		endpoint: EndpointContext,
	): Promise<TelegramClient> => {
		const token = await tokenFor(endpoint);
		if (!token) {
			throw configurationError("telegram endpoint has no credentials", {
				endpointKey: endpoint.endpointKey,
				reason:
					"pass token in code, or register the connection with a stored secret",
			});
		}
		return createTelegramClient({
			apiBaseUrl: config.apiBaseUrl,
			fetch: config.fetch,
			token,
		});
	};

	return {
		provider: "telegram",
		name,
		supports: { webhook: true, poll: true },
		mode,
		declaredSecrets: [declaredSecret],
		// Phantom-ish marker read by channels() at the type level; its runtime value tracks the mode.
		$poll: mode === "poll",

		// No validate(): the app bot's token now resolves lazily (async, through the one-door reader
		// only available at the plugin's configure), so a missing token can no longer be caught at
		// startup — it fails LOUD on first traffic instead (tokenFor throws "telegram bot has no token").

		// Registrations mode: the secret_token telegram echoes IS the per-registration identity. The
		// plugin looks the row up by its webhookSecret == this value, so one URL serves every registered
		// bot; `verify` below then re-checks the same header (the match is also the authentication).
		identify(request) {
			return (
				request.headers.get("x-telegram-bot-api-secret-token") ?? undefined
			);
		},

		async verify({ request, endpoint }) {
			// A registration row's explicit webhookSecret wins; otherwise the secret derives from the bot
			// token (telegramWebhookSecret) — no second credential to configure. For the app bot, tokenFor
			// fails LOUD when no token resolves ("telegram bot has no token"); for a registration with
			// neither a stored secret nor a webhookSecret we still fail CLOSED and loudly here — an open
			// webhook would relay attacker text straight into a model run, and a missing credential is a
			// setup gap, not a bad request.
			const token = await tokenFor(endpoint);
			const secret =
				endpoint.webhookSecret ??
				(token !== undefined ? telegramWebhookSecret(token) : undefined);
			if (!secret) {
				throw configurationError("telegram webhook endpoint has no secret", {
					endpointKey: endpoint.endpointKey,
					reason:
						"pass a bot token (the secret_token derives from it) or set webhookSecret on the registration",
				});
			}
			return request.headers.get("x-telegram-bot-api-secret-token") === secret;
		},

		parseInbound({ request }) {
			let body: unknown;
			try {
				body = JSON.parse(request.rawBody);
			} catch (err) {
				// a validation error, not a raw SyntaxError — junk bytes are the caller's fault, not a crash
				throw validationError(
					"telegram webhook body invalid JSON",
					errorMessage(err),
				);
			}
			const update = parseUpdate(body);
			const message = inboundFrom(update);
			return message ? [message] : [];
		},

		async send({ message, endpoint }) {
			const client = await clientFor(endpoint);
			await client.sendMessage({
				chatId: message.externalConversationId,
				text: message.text,
				replyToMessageId: replyMessageId(message.replyContext),
			});
		},

		async poll({ endpoint, cursor, limit }) {
			const offset = cursorOffset(cursor);
			const client = await clientFor(endpoint);
			const updates = parseUpdates(
				await client.getUpdates({
					offset,
					limit: limit ?? config.poll?.limit,
					timeoutSeconds: config.poll?.timeoutSeconds,
				}),
			);
			let nextOffset = offset;
			const messages: InboundMessage[] = [];
			for (const update of updates) {
				nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
				const message = inboundFrom(update);
				if (message) messages.push(message);
			}
			return {
				messages,
				cursor: nextOffset === undefined ? undefined : { offset: nextOffset },
			};
		},
	};
}
