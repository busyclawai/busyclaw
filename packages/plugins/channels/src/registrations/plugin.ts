import {
	type BindConversationClawInput,
	type BindConversationThreadInput,
	bindConversationClawInput,
	bindConversationThreadInput,
	configurationError,
	type EuroclawPluginConfigureContext,
	type EuroclawPluginRuntime,
	type EuroclawRoute,
	type EuroclawRouteContext,
	endpoints,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import type { ChannelsPlugin, ChannelsPluginOptions } from "../channels/plugin";
import { requireClaw } from "../core/claw";
import {
	type Channel,
	ENDPOINT_SEGMENT,
	type EndpointContext,
} from "../core/contracts";
import { dispatchWebhook } from "../core/dispatch";
import {
	channelRegistrationLookupInput,
	channelRegistrationsModels,
	listChannelRegistrationsInput,
	registerChannelRegistrationInput,
} from "./schema";
import {
	type ChannelRegistrationListFilter,
	type ChannelRegistrationLookup,
	type ChannelRegistrationRecord,
	type ChannelRegistrationsStore,
	createChannelRegistrationsStore,
	type RegisterChannelRegistrationInput,
} from "./store";

/** The api namespace registrations mode exposes on `claw.api.channels.registrations`. */
export type ChannelRegistrationsApi = {
	/** Register (or re-register: rotate + re-activate) a user's bot — the sso register analog. */
	register: (
		input: RegisterChannelRegistrationInput,
	) => Promise<ChannelRegistrationRecord>;
	get: (input: { id: string }) => Promise<ChannelRegistrationRecord | null>;
	getByKey: (
		input: ChannelRegistrationLookup,
	) => Promise<ChannelRegistrationRecord | null>;
	list: (
		filter?: ChannelRegistrationListFilter,
	) => Promise<ChannelRegistrationRecord[]>;
	revoke: (
		input: ChannelRegistrationLookup,
	) => Promise<ChannelRegistrationRecord | null>;
};

/** The `claw.api` shape registrations mode contributes (folded onto `claw.api` via `$Api`). */
export type ChannelRegistrationsPluginApi = {
	readonly channels: { readonly registrations: ChannelRegistrationsApi };
};

/** One transport per provider — registrations resolve everything else from rows. */
export function assertUniqueProviders(channels: readonly Channel[]): void {
	const providers = new Set<string>();
	for (const channel of channels) {
		if (providers.has(channel.provider)) {
			throw configurationError("duplicate channel provider", {
				provider: channel.provider,
				reason: "pass one transport per provider",
			});
		}
		providers.add(channel.provider);
	}
}

// ONE webhook mount per provider — no key in the path. Every registered bot of a provider posts to the
// same URL; the row is resolved from the request by its inbound secret (Channel.identify → getBySecret),
// so hosts hand this one URL (plus a per-registration secret_token) to setWebhook.
const WEBHOOK_PATH = "/channels/:provider/registrations/webhook";

// Boundary input for the by-id read — the row id, the base api's idInput shape.
const registrationIdInput = type({ id: "string" }).configure({
	euroclaw: {
		doc: "The row id for the by-id read. The id is the (provider, endpointKey) natural key hashed (`endpointId`), not a random surrogate, so a caller holding the pair can compute it without a prior lookup.",
	},
});

/**
 * The registrations mode of channels() — user-registered bots, the SSO analog: hosts let their users
 * bring their OWN bots at runtime. Credentials live in the channel_registration row (read back at use),
 * the organization they belong to is row data (the organizationId analog), and conversations bind under
 * the row's claw defaults. Registrations are WEBHOOK-ONLY — no poll cron, no shared/default bot. One
 * webhook URL per provider: the request names its own registration (Channel.identify returns the secret
 * the provider echoes; the row is found by matching its webhookSecret). Providers are the same Channel
 * transports app bots use — pass them config-light (e.g. `telegram()`), everything endpoint-specific
 * resolves from the row. Contributes the channel_registration table (the DB gate) and requires a database.
 */
export function buildRegistrationsPlugin(
	list: readonly Channel[],
	options: ChannelsPluginOptions,
): ChannelsPlugin {
	assertUniqueProviders(list);
	if (list.length === 0) {
		throw configurationError(
			"channels registrations enabled but no providers",
			{
				reason:
					"list the providers you support — channels([telegram()], { registrations: { enabled: true } })",
			},
		);
	}
	// Registrations resolve the row from the request, so every provider MUST know how to name itself in
	// one — fail at config, not on first traffic.
	for (const channel of list) {
		if (!channel.identify) {
			throw configurationError(
				"channel provider cannot be a registration transport",
				{
					provider: channel.provider,
					reason:
						"registrations share one URL per provider and resolve the row from the request — the provider must implement identify()",
				},
			);
		}
	}
	const now = options.now ?? (() => new Date().toISOString());
	const byProvider = new Map(
		list.map((channel) => [channel.provider, channel]),
	);

	// The row's bind-defaults JSON crossed a trust boundary (the registration api wrote it), so the
	// claw/thread defaults are arktype-validated here before they reach bindConversation.
	const clawDefaults = (
		row: ChannelRegistrationRecord,
	): BindConversationClawInput | undefined => {
		// The registration's org (an org-scoped BYO bot) places its conversations' claws under that org:
		// organizationId → the standard (scope, scopeId) boundary. Organizationless registrations carry no
		// placement and the claw defaults to personal at create. `createdBy` is filled at bind time.
		const merged = {
			...row.claw,
			...(row.organizationId !== undefined
				? { scope: "organization", scopeId: row.organizationId }
				: {}),
		};
		if (Object.keys(merged).length === 0) return undefined;
		const valid = bindConversationClawInput(merged);
		if (valid instanceof type.errors) {
			throw validationError(
				"channel registration claw defaults invalid",
				valid.summary,
				{ endpointKey: row.endpointKey, provider: row.provider },
			);
		}
		return valid;
	};
	const threadDefaults = (
		row: ChannelRegistrationRecord,
	): BindConversationThreadInput | undefined => {
		if (row.thread === undefined || Object.keys(row.thread).length === 0)
			return undefined;
		const valid = bindConversationThreadInput(row.thread);
		if (valid instanceof type.errors) {
			throw validationError(
				"channel registration thread defaults invalid",
				valid.summary,
				{ endpointKey: row.endpointKey, provider: row.provider },
			);
		}
		return valid;
	};

	// Registrations bind under a namespaced key: app bots own the bare binding-key space, so the two
	// modes' conversation bindings are disjoint by construction — an app bot named "sales" and a
	// registration registered as "sales" never share rows (and a registration can never satisfy a
	// provider's code-key comparison, so it can never be served with the app bot's credentials).
	const bindingKey = (row: ChannelRegistrationRecord): string =>
		`registrations/${row.endpointKey}`;

	// A registration's normalized endpoint view. Registrations are webhook-only, so `mode` is the
	// constant "webhook" (the stored column is gone); credentials and bind scope come from the row.
	const contextFor = (row: ChannelRegistrationRecord): EndpointContext => ({
		provider: row.provider,
		endpointKey: bindingKey(row),
		mode: "webhook",
		secret: row.secret,
		webhookSecret: row.webhookSecret,
		claw: clawDefaults(row),
		thread: threadDefaults(row),
	});

	// The RUNTIME half: the channel_registration store arrives at configure, so the webhook route AND
	// the management api are built HERE, closing over that store — no plugin rebuild, no captured slots.
	// An absent adapter leaves the store undefined; every store-backed method fails loud (requireStore).
	const configure = (
		context: EuroclawPluginConfigureContext,
	): EuroclawPluginRuntime<ChannelRegistrationsPluginApi> | undefined => {
		const store = context.adapter
			? createChannelRegistrationsStore(context.adapter, { now })
			: undefined;
		const requireStore = (): ChannelRegistrationsStore => {
			if (!store) {
				throw configurationError(
					"channels registrations require a database adapter",
					{
						reason:
							"pass a database to createClaw so registrations can be registered and resolved",
					},
				);
			}
			return store;
		};

		const register = async (
			input: RegisterChannelRegistrationInput,
		): Promise<ChannelRegistrationRecord> => {
			if (!byProvider.has(input.provider)) {
				throw configurationError("unknown channel provider", {
					provider: input.provider,
					reason:
						"pass this provider's channel to channels([...], { registrations: { enabled: true } })",
				});
			}
			// Registrations are webhook-only. Drop any stray `mode` a widened/JS caller passes, and reject
			// a poll mode loudly — the whole poll surface is gone for registrations.
			const { mode, ...registration } =
				input as RegisterChannelRegistrationInput & {
					mode?: unknown;
				};
			if (mode === "poll") {
				throw configurationError("channel registrations are webhook-only", {
					provider: input.provider,
					reason:
						"a registration is always a webhook — drop mode (registrations no longer poll)",
				});
			}
			// The endpointKey is the registration's binding-key segment (`registrations/${endpointKey}`),
			// never a URL segment now — enforce the segment shape so the prefix stays unforgeable (no slash).
			if (!ENDPOINT_SEGMENT.test(input.endpointKey)) {
				throw configurationError("invalid registration key", {
					endpointKey: input.endpointKey,
					provider: input.provider,
					reason: "an endpointKey is a single segment: A-Z a-z 0-9 _ -",
				});
			}
			return requireStore().register(registration);
		};

		const webhookRoute: EuroclawRoute = {
			id: "channels:registrations:webhook",
			method: "POST",
			path: WEBHOOK_PATH,
			handler: async ({ claw, params, request }: EuroclawRouteContext) => {
				const channel = byProvider.get(params.provider ?? "");
				// identify is guaranteed present (asserted at build), but narrow for the type.
				if (!channel?.identify) {
					return {
						status: 404,
						body: { ok: false, error: "unknown provider" },
					};
				}
				// Read the body once, then hand the same bytes to identify (may parse it) and dispatch.
				const rawBody = await request.text();
				const inbound = { headers: request.headers, rawBody };
				const secret = await channel.identify(inbound);
				if (secret === undefined) {
					return {
						status: 404,
						body: { ok: false, error: "unidentified registration" },
					};
				}
				const row = await requireStore().getBySecret(channel.provider, secret);
				// Absent and revoked look identical from outside — don't leak registry state.
				if (row?.status !== "active") {
					return {
						status: 404,
						body: { ok: false, error: "unknown registration" },
					};
				}
				const result = await dispatchWebhook({
					claw: requireClaw(claw),
					channel,
					endpoint: contextFor(row),
					request: inbound,
					persist: (event) =>
						requireStore().record(
							{ provider: row.provider, endpointKey: row.endpointKey },
							event,
						),
				});
				return { status: result.status, body: result.body };
			},
		};

		return {
			routes: [webhookRoute],
			// The management api is a declared endpoints() namespace nested under the `channels` key —
			// the adapter mounts it at /channels/registrations/<method> (register/revoke POST by the name
			// rule, get/get-by-key/list GET), while `claw.api.channels.registrations.*` stays these
			// same handlers called directly.
			api: () => ({
				channels: {
					registrations: endpoints({
						register: {
							input: registerChannelRegistrationInput,
							handler: register,
						},
						get: {
							input: registrationIdInput,
							handler: ({ id }: { id: string }) => requireStore().get(id),
						},
						getByKey: {
							input: channelRegistrationLookupInput,
							handler: (input: ChannelRegistrationLookup) =>
								requireStore().getByKey(input),
						},
						list: {
							input: listChannelRegistrationsInput,
							handler: (filter?: ChannelRegistrationListFilter) =>
								requireStore().list(filter),
						},
						revoke: {
							input: channelRegistrationLookupInput,
							handler: (input: ChannelRegistrationLookup) =>
								requireStore().revoke(input),
						},
					}),
				},
			}),
		};
	};

	return {
		id: options.id ?? "euroclaw.channels.registrations",
		$HasCron: "no-cron",
		$RequiresDatabase: true,
		schema: channelRegistrationsModels,
		// The webhook route and the management api are the RUNTIME half — configure returns them.
		configure,
	};
}
