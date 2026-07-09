// The channels floor — the @better-auth/core/oauth2 analog: the Channel adapter contract, the
// normalized endpoint view, and the message shapes. Both channels() modes (app bots and registrations
// = user-registered bots) and every provider build on this module; nothing here imports a plugin or a
// store.

import type {
	BindConversationClawInput,
	BindConversationThreadInput,
	JsonValue,
	SecretDeclaration,
	Secrets,
} from "@euroclaw/contracts";

export const channelEndpointModeValues = ["webhook", "poll"] as const;
export type ChannelEndpointMode = (typeof channelEndpointModeValues)[number];

/**
 * A raw inbound request, narrowed to what a channel needs. The dispatch engine reads the body once and
 * hands the bytes to both `verify` (header- or signature-based) and `parseInbound`, so a channel never
 * has to worry about the single-read body.
 */
export type InboundRequest = {
	headers: { get: (name: string) => string | null };
	rawBody: string;
};

/** One normalized inbound message — the parse target every provider produces from its wire format. */
export type InboundMessage = {
	externalConversationId: string;
	externalActorId?: string;
	text: string;
	conversationTitle?: string;
	/** Opaque token the channel round-trips to `send` to thread the reply (e.g. a message id). */
	replyContext?: JsonValue;
	raw?: JsonValue;
};

/** A normalized reply the dispatch engine hands back to a channel to deliver. */
export type OutboundMessage = {
	externalConversationId: string;
	text: string;
	replyContext?: JsonValue;
};

/**
 * The endpoint a channel operates on for one request/poll cycle — a NORMALIZED view the calling
 * plugin assembles. A code-declared bot (the app's own — credentials in memory on the channel) and a
 * registered connection row (a user's bot — credentials in the row) look identical here; only the
 * assembling plugin knows the source.
 */
export type EndpointContext = {
	provider: string;
	endpointKey: string;
	mode: ChannelEndpointMode;
	/** Egress credential from a connection row (e.g. a bot token). Code bots keep clients in memory. */
	secret?: string;
	/** Inbound verification secret from a connection row — `verify` checks it before code config. */
	webhookSecret?: string;
	/**
	 * The one-door secret reader (`@euroclaw/secrets`) the channels plugin threads from its
	 * `configure(context.secrets)`, so a code-declared APP bot resolves its OWN token (the app-bot
	 * fallback) through `secrets.get(name)` — honouring an org's aliases/providers instead of a raw
	 * env read. Set only on app-bot endpoints; a registered connection carries its token in `secret`
	 * (above) and never sets this — the connection path is unchanged.
	 */
	secrets?: Secrets;
	/** Poll cursor from the endpoint's persisted state. */
	cursor?: JsonValue;
	/**
	 * Bind defaults for conversations on this endpoint — set by registrations mode from the row
	 * (organization on `claw.organizationId`). The app's own bots carry none: conversations create bare personal
	 * claws, and hosts that want placement pre-bind through the public bindConversation api.
	 */
	claw?: BindConversationClawInput;
	thread?: BindConversationThreadInput;
};

/**
 * What dispatch reports back after handling traffic on an endpoint. Each mode maps events onto its
 * own table (app bots → channel_endpoint state, registrations → the channel_registration row) — the
 * engine never touches storage.
 */
export type EndpointEvent =
	| { kind: "received" }
	| { kind: "polled"; cursor: JsonValue | undefined }
	| { kind: "poll-error"; error: JsonValue };

export type PersistEndpointEvent = (event: EndpointEvent) => Promise<unknown>;

/**
 * The endpoint key of an UNNAMED app bot. A provider's first bot needs no name and lives under this
 * constant (webhook: `/channels/:provider/webhook`); additional bots of the same provider carry a
 * `name`, which becomes their endpoint key and their path segment
 * (`/channels/:provider/webhook/:name`) — the genericOAuth model, where the discriminator is in the
 * callback URL. App bots own the BARE binding-key namespace; registered bots bind under a
 * `registrations/` prefix, so the two modes' binding spaces are disjoint by construction.
 */
export const APP_ENDPOINT_KEY = "default";

/**
 * An app-bot name is a webhook path segment (`/webhook/:name`) and a registration's endpointKey is its
 * binding-key segment (`registrations/${endpointKey}`) — both must be single segments (telegram's own
 * secret_token charset), which also keeps the `registrations/` binding-key prefix unforgeable: a raw
 * key can never contain a slash. A registration's endpointKey is NOT in its webhook URL — registrations
 * share one URL per provider and are resolved from the request (`Channel.identify`).
 */
export const ENDPOINT_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * The behavioral contract every channel implements — the OAuthProvider analog, but bidirectional
 * (channels send). The shared engine owns bind/relay/reply; a channel supplies only the
 * provider-specific verify/parse/send/poll. Credential resolution (code client vs `endpoint.secret`)
 * is the channel's private concern.
 */
export interface Channel {
	readonly provider: string;
	/**
	 * Distinguishes multiple app bots of one provider — it becomes the bot's endpoint key and its
	 * webhook path segment (a single ENDPOINT_SEGMENT). Optional for a provider's only bot;
	 * channels() requires distinct (provider, name) pairs at compile time and at runtime.
	 */
	readonly name?: string;
	readonly supports: { readonly webhook: boolean; readonly poll: boolean };
	/** The app bot's transport. */
	readonly mode: ChannelEndpointMode;
	/**
	 * The secret name(s) this transport's APP bot resolves through the one-door reader
	 * (`secrets.get(name)`) — e.g. telegram's `tokenRef ?? "TELEGRAM_BOT_TOKEN"`. The `channels`
	 * plugin AGGREGATES these into its `plugin.secrets` declarations so the required-names list
	 * (`claw.api.secrets.list` / boot coverage) enumerates them. channels() in registrations mode
	 * deliberately does NOT — a registered bot's token lives in its row (`endpoint.secret`), not a
	 * `secrets.get` name. Absent for a pure transport with no app-bot credential of its own.
	 */
	readonly declaredSecrets?: readonly SecretDeclaration[];
	/**
	 * Assert the code-declared configuration is usable (credentials present after env fallbacks).
	 * channels() calls this at construction so a dead app bot fails at startup, not on first traffic;
	 * registrations mode never calls it — a bare transport's credentials live on the rows.
	 */
	validate?: () => void;
	/**
	 * Authenticate an inbound request against the endpoint BEFORE its body is trusted. Prefer failing
	 * closed — an unverified webhook relays attacker input straight into a model run (telegram checks
	 * `endpoint.webhookSecret`, then code config, and refuses when neither is set).
	 */
	verify?: (input: {
		request: InboundRequest;
		endpoint: EndpointContext;
	}) => boolean | Promise<boolean>;
	/**
	 * Registrations mode ONLY (one webhook URL per provider — no key in the path): return the secret the
	 * provider echoes in the request that names WHICH registration this is, so the store can select the
	 * row by its `webhookSecret` without a URL key. Telegram returns its `X-Telegram-Bot-Api-Secret-Token`
	 * header — a unique secret per registration both selects the row and (via the subsequent `verify`
	 * against that same secret) authenticates it. `undefined` ⇒ no registration is named, so the request is
	 * refused (404); a provider that omits `identify` entirely can't be a registration transport. App-bot
	 * mode never calls this — its bots are keyed by the URL path.
	 */
	identify?: (
		request: InboundRequest,
	) => string | undefined | Promise<string | undefined>;
	/** Parse a raw request into normalized inbound messages. */
	parseInbound: (input: {
		request: InboundRequest;
		endpoint: EndpointContext;
	}) => InboundMessage[] | Promise<InboundMessage[]>;
	/** Deliver a reply through the provider. */
	send: (input: {
		message: OutboundMessage;
		endpoint: EndpointContext;
	}) => Promise<void>;
	/** Poll for new messages — present only when `supports.poll`. */
	poll?: (input: {
		endpoint: EndpointContext;
		cursor: JsonValue | undefined;
		limit?: number;
	}) => Promise<{ messages: InboundMessage[]; cursor: JsonValue | undefined }>;
}
