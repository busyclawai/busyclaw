import {
	type AuthzContext,
	type BindConversationClawInput,
	type BindConversationThreadInput,
	type BusyclawPluginConfigureContext,
	type BusyclawPluginRuntime,
	type BusyclawRoute,
	type BusyclawRouteContext,
	bindConversationClawInput,
	bindConversationThreadInput,
	type ClawApiCaller,
	configurationError,
	conflictError,
	endpoints,
	route,
	validationError,
} from "@busyclaw/contracts";
import { readRequestBody } from "@busyclaw/core";
import { optionalCipher, type SecretCipher } from "@busyclaw/secrets";
import { type } from "arktype";
import type { ChannelsPlugin, ChannelsPluginOptions } from "../channels/plugin";
import { requireClaw } from "../core/claw";
import {
	type Channel,
	ENDPOINT_SEGMENT,
	type EndpointContext,
} from "../core/contracts";
import {
	dispatchWebhook,
	drainDeliveries,
	drainOutbox,
	drainReplies,
	type ResolvedEndpoint,
} from "../core/dispatch";
import { endpointId } from "../core/id";
import {
	channelDeliveryModels,
	channelOutboxModels,
	createDeliveryInbox,
	createDeliveryOutbox,
} from "../core/inbox";
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
	type ChannelRegistrationView,
	createChannelRegistrationsStore,
	openRegistrationSecret,
	type RegisterChannelRegistrationInput,
	toChannelRegistrationView,
} from "./store";

/** The kind a registration's `access_grant` rows carry — the label the assembly merges into the ONE
 *  loader registry, and the label every route below authorizes against. */
export const CHANNEL_REGISTRATION_KIND = "channel_registration";

// A FIRST registration creates a row, so there is nothing yet to authorize against — the same shape as
// `createClaw`. Everything else about the call IS authorized, inside the handler where the facts exist:
// an explicit boundary as membership, and an existing row as manage. Both are checks the declarative
// resolver cannot express, because both depend on a lookup the resolver has not done.
const REGISTER_IS_A_CREATE =
	"a first registration creates the row it would authorize against; re-registration is checked as manage on the existing row, and an explicit (scope, scopeId) as membership, inside the handler";

// A listing has no id to resolve. It is authorized ROW BY ROW as `channels.registrations.get` — naming
// that method matters: decided as the listing, a per-row check would inherit the create-group permit the
// sealed baseline gives any authenticated principal, and pass for everyone.
const LIST_IS_FILTERED =
	"a listing has no single resource; every row is authorized individually as channels.registrations.get before it is returned";

// The method every in-handler check inside `register` is decided AS. Not cosmetic, and the reason both
// checks below pass an `asMethod`: `register` is caller-mode, so it sits in the `creates` group the
// sealed baseline permits for any authenticated principal — decided as itself, a check inside it
// inherits that permit and answers yes to everyone, which is indistinguishable from having no check at
// all. `revoke` is this kind's declared MANAGE method, and "does this principal have authority over a
// registration here" is exactly the question it asks.
const REGISTRATION_AUTHORITY = "channels.registrations.revoke";

/** The single-row read every per-row listing check is decided as — same reasoning as above, one level
 *  down: a listing is caller-mode, its rows are not. */
const REGISTRATION_READ = "channels.registrations.get";

/** The api namespace registrations mode exposes on `claw.api.channels.registrations`. Every method
 *  takes the out-of-band app-authz caller as its 2nd argument, the same shape the rest of `claw.api`
 *  uses. `list` takes its filter POSITIONALLY REQUIRED (pass `{}` for "everything visible") because a
 *  governed method's first parameter is its validated input — an omitted one would have nothing for the
 *  boundary schema to check.
 *
 *  Every method returns the {@link ChannelRegistrationView} — the row WITHOUT its credentials. */
export type ChannelRegistrationsApi = {
	/** Register (or re-register: rotate + re-activate) a user's bot — the sso register analog. */
	register: (
		input: RegisterChannelRegistrationInput,
		caller?: ClawApiCaller,
	) => Promise<ChannelRegistrationView>;
	get: (
		input: { id: string },
		caller?: ClawApiCaller,
	) => Promise<ChannelRegistrationView | null>;
	getByKey: (
		input: ChannelRegistrationLookup,
		caller?: ClawApiCaller,
	) => Promise<ChannelRegistrationView | null>;
	list: (
		filter: ChannelRegistrationListFilter,
		caller?: ClawApiCaller,
	) => Promise<ChannelRegistrationView[]>;
	revoke: (
		input: ChannelRegistrationLookup,
		caller?: ClawApiCaller,
	) => Promise<ChannelRegistrationView | null>;
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

/** The namespace registrations bind under, so their conversation bindings never collide with an app
 *  bot of the same name. Also what a stored delivery key is stripped of to find its row again. */
const BINDING_PREFIX = "registrations/";

// Boundary input for the by-id read — the row id, the base api's idInput shape.
const registrationIdInput = type({ id: "string" }).configure({
	busyclaw: {
		doc: "The row id for the by-id read. The id is the (provider, endpointKey) natural key hashed (`endpointId`), not a random surrogate, so a caller holding the pair can compute it without a prior lookup.",
	},
});

/**
 * The registrations mode of channels() — user-registered bots, the SSO analog: hosts let their users
 * bring their OWN bots at runtime. Credentials live in the channel_registration row (read back at use,
 * never returned to a caller), each row carries `createdBy` + a `(scope, scopeId)` boundary that decides
 * both who may manage it and where its conversations land, and conversations bind under the row's claw
 * defaults. Registrations are WEBHOOK-ONLY — no poll cron, no shared/default bot. One
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
		// The registration's own boundary places its conversations' claws — a bot registered into an org
		// makes org claws, a personal one makes personal claws. It OVERRIDES any boundary in the stored
		// defaults, because the row's boundary is the authorized one (register checked membership before
		// writing it) while the JSON blob is whatever was submitted. `createdBy` is filled at bind time.
		const merged = { ...row.claw, scope: row.scope, scopeId: row.scopeId };
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
		`${BINDING_PREFIX}${row.endpointKey}`;

	// A registration's normalized endpoint view. Registrations are webhook-only, so `mode` is the
	// constant "webhook" (the stored column is gone); credentials and bind scope come from the row.
	// `presentedSecret` is the value THIS request echoed, not the row's stored one — R-M07: the column
	// holds a digest now, so the plaintext exists only for the length of a request. The lookup already
	// proved the two correspond (the row was FOUND by that digest), so handing the presented value to
	// `verify` is not trusting the caller: it is giving the channel back the thing already matched.
	// Absent on the drain path, which sends and never verifies.
	const contextFor = async (
		row: ChannelRegistrationRecord,
		cipher: SecretCipher,
		presentedSecret?: string,
	): Promise<EndpointContext> => ({
		provider: row.provider,
		endpointKey: bindingKey(row),
		mode: "webhook",
		// R-M07: the column holds a sealed token; this is the one place it is opened, and the plaintext
		// lives only for the outbound call it is about to make.
		secret: await openRegistrationSecret(row, cipher),
		webhookSecret: presentedSecret ?? row.webhookSecret,
		claw: clawDefaults(row),
		thread: threadDefaults(row),
	});

	// The RUNTIME half: the channel_registration store arrives at configure, so the webhook route AND
	// the management api are built HERE, closing over that store — no plugin rebuild, no captured slots.
	// An absent adapter leaves the store undefined; every store-backed method fails loud (requireStore).
	const configure = (
		context: BusyclawPluginConfigureContext,
	): BusyclawPluginRuntime<ChannelRegistrationsPluginApi> | undefined => {
		// R-M07. One cipher over the deployment's master key; each ciphertext is bound to its own
		// (scope, scopeId, name), so a token sealed for one registration cannot be opened as another's
		// — which is what makes ONE key safe across every consumer of this cipher.
		//
		// OPTIONAL, unlike the secret store's. That store exists to hold secrets, so refusing to run
		// without a key is the whole point of it. Registering a bot is not that: a host enabling
		// channels has not asked to run a key-management story, and failing every registration on a
		// key nobody told them to set would take working deployments down to protect a column. So a
		// key seals when one is configured, and its absence is a warning rather than an outage.
		// No warn seam on the plugin configure context, so the absence is documented on the option and
		// on `optionalCipher` rather than announced. Worth a warn if one is ever threaded through.
		const cipher = optionalCipher(context.secrets);
		const store = context.adapter
			? createChannelRegistrationsStore(context.adapter, { now, cipher })
			: undefined;
		// One delivery is relayed once: a provider retry finds the claim already taken. Registrations
		// require a database, so this is always present here.
		const inbox = context.adapter
			? createDeliveryInbox(context.adapter, { now })
			: undefined;
		// The reply is written here before it is sent, so a crash in between leaves something to finish.
		const outbox = context.adapter
			? createDeliveryOutbox(context.adapter, { now })
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
			ctx: AuthzContext,
		): Promise<ChannelRegistrationView> => {
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
			// An explicit boundary is a claim about where this bot belongs, and it decides BOTH who may
			// manage the row and where its conversations land — so it is authorized as membership before
			// anything is written. Without it a caller could register a bot into another tenant, handing
			// that tenant's members a bot they do not control and pushing conversations into their data.
			// Half a pair is neither a boundary nor a default, so it is refused rather than guessed.
			const { scope, scopeId } = registration;
			if ((scope === undefined) !== (scopeId === undefined)) {
				throw validationError(
					"channel registration boundary incomplete",
					"pass both scope and scopeId, or neither (the registration is then personal to you)",
					{ endpointKey: input.endpointKey, provider: input.provider },
				);
			}
			if (scope !== undefined && scopeId !== undefined) {
				await ctx.authz.enforce(
					"use",
					{ scope, scopeId },
					REGISTRATION_AUTHORITY,
				);
			}
			// CREATE first, and let the store answer whether the key was free. Reading first and
			// deciding on what the read saw is the R-H09 gap itself: the row can appear between the
			// check and the write, and the old code then rotated it having enforced nothing.
			const lookup = {
				provider: input.provider,
				endpointKey: input.endpointKey,
			};
			const created = await requireStore().register({
				...registration,
				// Stamped, never read from the body: a forged `createdBy` loses to runtime proof.
				createdBy: ctx.principal,
			});
			if (created) return toChannelRegistrationView(created);

			// The key is taken. Rotating somebody's credentials and bind defaults is a management
			// operation on THEIR row, so it is decided against the row that actually exists — not the
			// one this caller happened to observe, and not by the store because the key matched.
			const winner = await requireStore().getByKey(lookup);
			if (!winner) {
				throw conflictError("channel registration conflicted then vanished", {
					...lookup,
				});
			}
			await ctx.authz.enforce(
				"manage",
				{ kind: CHANNEL_REGISTRATION_KIND, id: winner.id },
				REGISTRATION_AUTHORITY,
			);
			// `createdBy` is immutable and drops out: whoever MANAGES the row may rotate it, which does
			// not make them its registrant. `updatedAt` is the compare-and-set — the row must still be
			// the one just authorized.
			const { provider: _p, endpointKey: _e, ...rest } = registration;
			const rotated = await requireStore().rotate(
				lookup,
				{ ...rest, status: "active" },
				winner.updatedAt,
			);
			if (!rotated) {
				throw conflictError(
					"channel registration changed while it was being authorized",
					{ ...lookup, reason: "re-read it and try again" },
				);
			}
			return toChannelRegistrationView(rotated);
		};

		const webhookRoute: BusyclawRoute = {
			id: "channels:registrations:webhook",
			method: "POST",
			path: WEBHOOK_PATH,
			handler: async ({ claw, params, request }: BusyclawRouteContext) => {
				const channel = byProvider.get(params.provider ?? "");
				// identify is guaranteed present (asserted at build), but narrow for the type.
				if (!channel?.identify) {
					return {
						status: 404,
						body: { ok: false, error: "unknown provider" },
					};
				}
				// Read the body once, then hand the same bytes to identify (may parse it) and dispatch.
				// Bounded: this endpoint is reachable by strangers BY DESIGN, so an unbounded read here
				// is the one an attacker does not even need an account to reach.
				const rawBody = await readRequestBody(request);
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
					endpoint: await contextFor(row, cipher, secret),
					request: inbound,
					// Registrations require a database, so the claim always has somewhere to live.
					...(inbox !== undefined ? { inbox } : {}),
					...(outbox !== undefined ? { outbox } : {}),
					...(context.redact !== undefined ? { redact: context.redact } : {}),
					persist: (event) =>
						requireStore().record(
							{ provider: row.provider, endpointKey: row.endpointKey },
							event,
						),
				});
				return { status: result.status, body: result.body };
			},
		};

		// Resolve a stored row back to the transport and endpoint it belongs to. Registrations bind under
		// a namespaced key, so the stored `registrations/<name>` is stripped back to the row's own key.
		const endpointFor = async (key: {
			provider: string;
			endpointKey: string;
		}): Promise<ResolvedEndpoint | undefined> => {
			const channel = byProvider.get(key.provider);
			if (!channel) return undefined;
			const bare = key.endpointKey.startsWith(BINDING_PREFIX)
				? key.endpointKey.slice(BINDING_PREFIX.length)
				: key.endpointKey;
			const row = await requireStore().getByKey({
				provider: key.provider,
				endpointKey: bare,
			});
			// Revoked reads the same as absent — a delivery to a bot somebody took away is not runnable,
			// and the drain buries it rather than retrying it forever.
			if (row?.status !== "active") return undefined;
			return { channel, endpoint: await contextFor(row, cipher) };
		};

		// The queues' recovery half, as scheduled work. Deliberately ONE task covering both directions:
		// they fail together (a dead process leaves an unfinished turn AND an unsent reply) and a
		// deployment that ran only one of them would recover half of an interrupted delivery.
		const drainTask = {
			id: "channels:registrations:drain",
			handler: async ({ claw, limit }: { claw: unknown; limit?: number }) => {
				if (!inbox || !outbox) return { status: "idle" as const };
				const inbound = await drainDeliveries({
					claw: requireClaw(claw),
					inbox,
					outbox,
					endpointFor,
					...(limit !== undefined ? { limit } : {}),
				});
				// BETWEEN THE TWO, and in this order. A run that finished since the last pass owes an
				// answer that has not been written anywhere yet, so this is what turns it into an outbox
				// row — and running it before `drainOutbox` means the answer goes out on THIS pass
				// instead of waiting for the next one. Every message parked on an approval somebody
				// granted between passes is answered here or not at all.
				const replies = await drainReplies({
					claw: requireClaw(claw),
					inbox,
					outbox,
					endpointFor,
					...(limit !== undefined ? { limit } : {}),
				});
				const outbound = await drainOutbox({
					outbox,
					endpointFor,
					...(limit !== undefined ? { limit } : {}),
				});
				const processed = inbound.processed + replies.sent + outbound.sent;
				return {
					processed,
					status: processed > 0 ? ("processed" as const) : ("idle" as const),
					data: { inbound, replies, outbound },
				};
			},
		};

		return {
			routes: [webhookRoute],
			cron: [drainTask],
			// The management api is a declared endpoints() namespace nested under the `channels` key —
			// the adapter mounts it at /channels/registrations/<method> (register/revoke POST by the name
			// rule, get/get-by-key/list GET), while `claw.api.channels.registrations.*` stays these
			// same handlers called directly.
			api: () => ({
				channels: {
					registrations: endpoints({
						register: route
							.input(registerChannelRegistrationInput)
							.authz(null, REGISTER_IS_A_CREATE)
							.handler(register),
						get: route
							.input(registrationIdInput)
							.authz("read", ({ id }) => ({
								kind: CHANNEL_REGISTRATION_KIND,
								id,
							}))
							.handler(async ({ id }: { id: string }) =>
								toChannelRegistrationView(await requireStore().get(id)),
							),
						// The (provider, endpointKey) pair hashes to the row id, so the resolver computes the
						// anchor without a lookup — the same row `get` would have named.
						getByKey: route
							.input(channelRegistrationLookupInput)
							.authz("read", (input) => ({
								kind: CHANNEL_REGISTRATION_KIND,
								id: endpointId(input),
							}))
							.handler(async (input: ChannelRegistrationLookup) =>
								toChannelRegistrationView(await requireStore().getByKey(input)),
							),
						list: route
							.input(listChannelRegistrationsInput)
							.authz(null, LIST_IS_FILTERED)
							.handler(
								async (
									filter: ChannelRegistrationListFilter,
									ctx: AuthzContext,
								) => {
									// The filter NARROWS; `ctx.filter` DECIDES. A row the caller may not read is
									// absent rather than an error — one unreadable row must not fail the page, and
									// answering "denied" per row would make the listing a probe for other tenants'
									// registrations. Decided as the single-row read, never as the listing.
									const visible = await ctx.authz.filter(
										"read",
										await requireStore().list(filter),
										(row) => ({
											kind: CHANNEL_REGISTRATION_KIND,
											id: row.id,
										}),
										REGISTRATION_READ,
									);
									return visible.map((row) => toChannelRegistrationView(row));
								},
							),
						revoke: route
							.input(channelRegistrationLookupInput)
							.authz("manage", (input) => ({
								kind: CHANNEL_REGISTRATION_KIND,
								id: endpointId(input),
							}))
							.handler(async (input: ChannelRegistrationLookup) =>
								toChannelRegistrationView(await requireStore().revoke(input)),
							),
					}),
				},
			}),
		};
	};

	return {
		id: options.id ?? "busyclaw.channels.registrations",
		// The queues need a scheduled drain: an admitted delivery whose inline attempt died, and a reply
		// whose send never completed, are both recoverable only by something that runs later.
		$HasCron: "has-cron",
		$RequiresDatabase: true,
		schema: {
			...channelRegistrationsModels,
			...channelDeliveryModels,
			...channelOutboxModels,
		},
		// The ONE per-kind bit: a data-fetcher, not authz logic. Registering the kind is what makes every
		// binding above enforceable — owner ∪ scope ∪ grant over the generic `access_grant` table, with no
		// policy of our own. Read statically off the plugin, so the registry binds before configure runs;
		// a no-database claw has no rows and the loader is never invoked.
		shareable: [
			{
				kind: CHANNEL_REGISTRATION_KIND,
				load: (context) => {
					const store = context.adapter
						? createChannelRegistrationsStore(context.adapter, { now })
						: undefined;
					return async (id) => {
						const row = await store?.get(id);
						// Absent ⇒ null ⇒ DENY, like every other loader.
						return row
							? {
									createdBy: row.createdBy,
									scope: row.scope,
									scopeId: row.scopeId,
								}
							: null;
					};
				},
			},
		],
		// The webhook route and the management api are the RUNTIME half — configure returns them.
		configure,
	};
}
