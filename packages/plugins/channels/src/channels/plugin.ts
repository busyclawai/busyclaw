import {
	configurationError,
	type EuroclawCronFlag,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	type EuroclawRoute,
	type EuroclawRouteContext,
	type Secrets,
} from "@euroclaw/contracts";
import { requireClaw } from "../core/claw";
import {
	APP_ENDPOINT_KEY,
	type Channel,
	ENDPOINT_SEGMENT,
	type EndpointContext,
} from "../core/contracts";
import { dispatchWebhook, pollEndpoint } from "../core/dispatch";
import {
	buildRegistrationsPlugin,
	type ChannelRegistrationsPluginApi,
} from "../registrations/plugin";
import { channelsModels } from "./schema";
import {
	type ChannelEndpointStateStore,
	createChannelEndpointStateStore,
} from "./store";

export type ChannelsPluginOptions = {
	/** Plugin id override (default "euroclaw.channels", or "euroclaw.channels.registrations"). */
	id?: string;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
	/**
	 * Opt in to BYO / user-registered bots (the SSO analog) INSTEAD of a shared app bot. Default OFF.
	 * When enabled the `list` names the providers users register their OWN bots for: there is no
	 * shared/default bot and no app-bot token secret, one webhook route serves the registrations, the
	 * `channel_registration` table is contributed (ONLY now — the DB gate), and
	 * `claw.api.channels.registrations` is exposed. Registrations are webhook-only. Enabling REQUIRES a
	 * database (compile-time RequireDatabaseForPlugins + a runtime backstop). One channels() call is
	 * shared-bot XOR BYO.
	 */
	registrations?: { enabled: boolean };
};

/** The `claw.api` shape registrations mode contributes; app-bot mode contributes none. */
type ChannelsApi = ChannelRegistrationsPluginApi;

/**
 * The channels plugin data object — a base plugin that folds the registrations `$Api` and can carry the
 * base `$RequiresDatabase` phantom (set when registrations is enabled → createClaw's
 * RequireDatabaseForPlugins demands a database). Both builders satisfy this wide shape; `channels()`
 * narrows to the mode-specific return type below.
 */
export type ChannelsPlugin<
	HasCron extends EuroclawCronFlag = EuroclawCronFlag,
> = EuroclawPlugin<HasCron, readonly string[], ChannelsApi>;

/** Registrations enabled at the type level — a literal `true` (a runtime-only boolean falls to the runtime gate). */
type RegistrationsEnabled<Options> = Options extends {
	registrations: { enabled: true };
}
	? true
	: false;

// The mode-specific return types (narrower than the wide ChannelsPlugin — they drive createClaw's folds):
//   app-bot       → today's plugin (cron derived from the providers' poll flags), no api, no DB gate;
//   registrations → the registrations api (required $Api, so InferPluginApi picks it up), $HasCron
//                   "no-cron" (registrations never poll), $RequiresDatabase true (RequireDatabaseForPlugins).
type AppBotChannelsPlugin<HasCron extends EuroclawCronFlag> = EuroclawPlugin<
	HasCron,
	readonly string[]
>;
type RegistrationsChannelsPlugin = EuroclawPlugin<
	"no-cron",
	readonly string[],
	ChannelsApi
> & {
	readonly $Api: ChannelsApi;
	readonly $RequiresDatabase: true;
};

type ChannelsReturn<List extends readonly PollAware[], Options> =
	RegistrationsEnabled<Options> extends true
		? RegistrationsChannelsPlugin
		: AppBotChannelsPlugin<ChannelsCronFlag<List>>;

/** A channel that may carry a compile-time poll marker (providers like telegram set it). */
type PollAware = Channel & { readonly $poll?: boolean };

/**
 * Does any channel in the list declare a poll endpoint at the type level? If so the plugin contributes
 * the poll cron, and `createClaw`'s RequireCronHandler demands a cronHandler at compile time. Channels
 * without a `$poll` marker fall back to runtime cron enforcement (assertCronHandler).
 */
type AnyPoll<List extends readonly PollAware[]> = [
	Extract<List[number]["$poll"], true>,
] extends [never]
	? false
	: true;

type ChannelsCronFlag<List extends readonly PollAware[]> =
	AnyPoll<List> extends true ? "has-cron" : "no-cron";

/**
 * The compile-time channel key — provider(:name), literals only. A wide `string` provider/name
 * (hand-rolled fixtures) yields `never` and falls back to the runtime check, so the fold can't
 * false-positive on non-literal types.
 */
type ChannelKeyOf<C> = C extends { readonly provider: infer P extends string }
	? string extends P
		? never
		: C extends { readonly name: infer N extends string }
			? string extends N
				? never
				: `${P}:${N}`
			: `${P}:${typeof APP_ENDPOINT_KEY}`
	: never;

type ChannelKeys<List extends readonly unknown[]> = List extends readonly [
	infer Head,
	...infer Tail,
]
	? [ChannelKeyOf<Head>, ...ChannelKeys<Tail>]
	: [];

type HasDuplicateKey<
	Items extends readonly unknown[],
	Seen = never,
> = Items extends readonly [infer Head, ...infer Tail]
	? [Head] extends [never]
		? HasDuplicateKey<Tail, Seen>
		: [Head] extends [Seen]
			? true
			: HasDuplicateKey<Tail, Seen | Head>
	: false;

type DuplicateChannelError = {
	readonly "ERROR: two channels share a provider without distinct names": never;
	readonly "FIX: name the extra bots — telegram({ name: 'sales' })": never;
};

/** Two bots of one provider must carry distinct names (the genericOAuth providerId model). */
type RequireDistinctChannels<List extends readonly unknown[]> =
	HasDuplicateKey<ChannelKeys<List>> extends true
		? DuplicateChannelError
		: unknown;

// ── compile-time mirror of ENDPOINT_SEGMENT — literal names walk the same alphabet ───────────────

type CharsOf<S extends string> = S extends `${infer Head}${infer Tail}`
	? Head | CharsOf<Tail>
	: never;
// Union-building recursion is not tail-eliminated (depth ~50), so the alphabet comes in chunks.
type SegmentChar =
	| CharsOf<"ABCDEFGHIJKLMNOPQRSTUVWXYZ">
	| CharsOf<"abcdefghijklmnopqrstuvwxyz">
	| CharsOf<"0123456789_-">;

type IsSegment<S extends string> = S extends ""
	? false
	: S extends `${infer Head}${infer Tail}`
		? Head extends SegmentChar
			? Tail extends ""
				? true
				: IsSegment<Tail>
			: false
		: false;

/** A channel's literal name that fails the segment walk — `never` for valid, wide, or unnamed. */
type InvalidNameOf<C> = C extends { readonly name: infer N extends string }
	? string extends N
		? never
		: IsSegment<N> extends true
			? never
			: N
	: never;

type AnyInvalidName<List extends readonly unknown[]> = List extends readonly [
	infer Head,
	...infer Tail,
]
	? [InvalidNameOf<Head>] extends [never]
		? AnyInvalidName<Tail>
		: true
	: false;

type InvalidChannelNameError = {
	readonly "ERROR: a channel name must be a URL path segment (A-Z a-z 0-9 _ -)": never;
	readonly "FIX: rename the bot — telegram({ name: 'sales' })": never;
};

/** Literal names must be path segments; wide strings fall back to the runtime check. */
type RequireValidChannelNames<List extends readonly unknown[]> =
	AnyInvalidName<List> extends true ? InvalidChannelNameError : unknown;

// The webhook mounts for the app's own bots: a provider's unnamed bot answers on the bare path,
// named bots each get their own segment — the genericOAuth `/oauth2/callback/:providerId` model.
// User-registered bots (channels() registrations mode) mount their own route, not these.
const WEBHOOK_PATH = "/channels/:provider/webhook";
const NAMED_WEBHOOK_PATH = "/channels/:provider/webhook/:name";

/** A bot's endpoint key: its name, or the unnamed-bot constant. */
const keyOf = (channel: Channel): string => channel.name ?? APP_ENDPOINT_KEY;

/** Distinct (provider, name) per app bot — the runtime mirror of RequireDistinctChannels. */
function assertUniqueChannelKeys(channels: readonly Channel[]): void {
	const keys = new Set<string>();
	for (const channel of channels) {
		// A name is the bot's webhook path segment — enforce that (and the segment charset keeps the
		// registrations/ binding-key prefix unforgeable).
		if (channel.name !== undefined && !ENDPOINT_SEGMENT.test(channel.name)) {
			throw configurationError("invalid channel name", {
				name: channel.name,
				provider: channel.provider,
				reason: "a name is a URL path segment: A-Z a-z 0-9 _ -",
			});
		}
		const key = `${channel.provider}:${keyOf(channel)}`;
		if (keys.has(key)) {
			throw configurationError("duplicate channel", {
				name: keyOf(channel),
				provider: channel.provider,
				reason:
					"two bots of one provider need distinct names — telegram({ name: 'sales' })",
			});
		}
		keys.add(key);
	}
}

/**
 * The channels plugin. Two modes, one call, shared-bot XOR BYO:
 *   - default — the app's own bots (the socialProviders/genericOAuth analog): one shared bot per
 *     provider declared in code, serving every user of the app. Credentials resolve through the
 *     one-door reader; the channel_endpoint table holds only operational state (poll cursor, last
 *     traffic, last error).
 *   - `{ registrations: { enabled: true } }` — user-registered bots (the SSO analog): the `list`
 *     names the providers users register their OWN bots for. No shared/default bot, no app-bot token
 *     secret, one webhook route, the channel_registration table (the DB gate), and
 *     `claw.api.channels.registrations`. Registrations are webhook-only and require a database.
 */
export function channels<
	const List extends readonly PollAware[],
	const Options extends ChannelsPluginOptions = Record<never, never>,
>(
	list: List & RequireDistinctChannels<List> & RequireValidChannelNames<List>,
	options: Options = {} as Options,
): ChannelsReturn<List, Options> {
	// The narrowing cast is the one seam between the runtime branch and the typed return:
	// buildAppBotPlugin sets $HasCron from the same poll check AnyPoll folds; buildRegistrationsPlugin
	// sets $RequiresDatabase from the same registrations flag RegistrationsEnabled folds.
	if (options.registrations?.enabled) {
		return buildRegistrationsPlugin(list, options, undefined) as ChannelsReturn<
			List,
			Options
		>;
	}
	// No store and no secrets reader yet: both arrive at configure (the assembly's seam).
	return buildAppBotPlugin(
		list,
		options,
		undefined,
		undefined,
	) as ChannelsReturn<List, Options>;
}

function buildAppBotPlugin(
	list: readonly Channel[],
	options: ChannelsPluginOptions,
	store: ChannelEndpointStateStore | undefined,
	secrets: Secrets | undefined,
): ChannelsPlugin {
	assertUniqueChannelKeys(list);
	// Every channel here is an app bot — fail at startup, not on first traffic, if one is unusable
	// (e.g. no token in config and none in the environment).
	for (const channel of list) channel.validate?.();
	const now = options.now ?? (() => new Date().toISOString());
	// Safe to key by (provider, name): assertUniqueChannelKeys guarantees distinct keys.
	const byKey = new Map(
		list.map((channel) => [`${channel.provider}:${keyOf(channel)}`, channel]),
	);
	const hasWebhook = list.some((channel) => channel.supports.webhook);
	const hasNamed = list.some((channel) => channel.name !== undefined);
	const pollTargets = list.filter(
		(channel) => channel.supports.poll && channel.mode === "poll",
	);
	// Aggregate each app bot's declared secret name(s) so the assembly's required-names list enumerates
	// them (boot coverage). App-bot tokens resolve via the one-door reader — the declaration is the
	// enumerable half; registrations declare nothing (their tokens live in the rows).
	const declaredSecrets = list.flatMap(
		(channel) => channel.declaredSecrets ?? [],
	);

	const requireStore = (): ChannelEndpointStateStore => {
		if (!store) {
			throw configurationError("channels requires a database adapter", {
				reason:
					"pass a database to createClaw so channels can persist endpoint state",
			});
		}
		return store;
	};

	const configure = (
		context: EuroclawPluginConfigureContext,
	): ChannelsPlugin | undefined => {
		if (store) return undefined;
		if (!context.adapter) return undefined;
		// Capture the one-door reader here — the only place it's in scope — and hand it to the rebuilt
		// plugin so contextFor can thread it to each app bot's lazy token resolution.
		return buildAppBotPlugin(
			list,
			options,
			createChannelEndpointStateStore(context.adapter, { now }),
			context.secrets,
		);
	};

	// A bot's normalized view: no per-connection secret VALUE (an app bot keeps its client in memory),
	// but it DOES carry the one-door secret READER so the channel can resolve its own token lazily
	// (secrets.get) on the send/webhook path; no bind defaults (conversations create bare personal
	// claws — placement is the host's logic through the public bindConversation api); cursor from the
	// state row under the bot's key.
	const contextFor = async (channel: Channel): Promise<EndpointContext> => {
		const state = await requireStore().get({
			provider: channel.provider,
			endpointKey: keyOf(channel),
		});
		return {
			provider: channel.provider,
			endpointKey: keyOf(channel),
			mode: channel.mode,
			cursor: state?.cursor,
			secrets,
		};
	};

	const persistFor =
		(channel: Channel) =>
		(event: Parameters<ChannelEndpointStateStore["record"]>[1]) =>
			requireStore().record(
				{
					provider: channel.provider,
					endpointKey: keyOf(channel),
					mode: channel.mode,
				},
				event,
			);

	const webhookHandler =
		(keyFrom: (params: Record<string, string>) => string) =>
		async ({ claw, params, request }: EuroclawRouteContext) => {
			const channel = byKey.get(`${params.provider ?? ""}:${keyFrom(params)}`);
			if (!channel) {
				return { status: 404, body: { ok: false, error: "unknown channel" } };
			}
			const rawBody = await request.text();
			const result = await dispatchWebhook({
				claw: requireClaw(claw),
				channel,
				endpoint: await contextFor(channel),
				request: { headers: request.headers, rawBody },
				persist: persistFor(channel),
			});
			return { status: result.status, body: result.body };
		};

	const webhookRoutes: EuroclawRoute[] = [
		{
			id: "channels:webhook",
			method: "POST",
			path: WEBHOOK_PATH,
			handler: webhookHandler(() => APP_ENDPOINT_KEY),
		},
		// Mounted only when a named bot exists — each named bot answers on its own path segment.
		...(hasNamed
			? [
					{
						id: "channels:webhook:named",
						method: "POST" as const,
						path: NAMED_WEBHOOK_PATH,
						handler: webhookHandler((params) => params.name ?? ""),
					},
				]
			: []),
	];

	const pollTask = {
		id: "channels:poll",
		handler: async ({ claw, limit }: { claw: unknown; limit?: number }) => {
			let processed = 0;
			for (const channel of pollTargets) {
				const result = await pollEndpoint({
					claw: requireClaw(claw),
					channel,
					endpoint: await contextFor(channel),
					limit,
					persist: persistFor(channel),
				});
				processed += result.processed;
			}
			return {
				processed,
				status: processed > 0 ? ("processed" as const) : ("idle" as const),
			};
		},
	};

	return {
		id: options.id ?? "euroclaw.channels",
		$HasCron: pollTargets.length > 0 ? "has-cron" : "no-cron",
		schema: channelsModels,
		...(declaredSecrets.length > 0 ? { secrets: declaredSecrets } : {}),
		configure,
		routes: hasWebhook ? webhookRoutes : [],
		cron: pollTargets.length > 0 ? [pollTask] : [],
	};
}
