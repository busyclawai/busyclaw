import type { Adapter } from "@busyclaw/contracts";
import {
	type AuthzContext,
	type AuthzTarget,
	authorizationError,
	type Principal,
	type RouteLevel,
	userPrincipal,
} from "@busyclaw/contracts";
import { buildSecrets, env, optionalCipher } from "@busyclaw/secrets";
import { entityAdapter, memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { drainOutbox } from "../src/core/dispatch";
import {
	channelDeliveryModels,
	channelOutboxModels,
	createDeliveryOutbox,
} from "../src/core/inbox";
import {
	type Channel,
	type ChannelsPlugin,
	channels,
	endpointId,
} from "../src/index";
import {
	channelRegistrationEntity,
	channelRegistrationsModels,
} from "../src/registrations/schema";
import {
	createChannelRegistrationsStore,
	openRegistrationSecret,
	webhookSecretDigest,
} from "../src/registrations/store";

// Stores and the configure context take the schema-aware adapter the assembly provides in
// production; tests wrap manually.
const db = () =>
	entityAdapter(memoryAdapter(), {
		...channelRegistrationsModels,
		...channelDeliveryModels,
		...channelOutboxModels,
	});

const now = () => "2026-01-01T00:00:00.000Z";

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

// The fake resolves its registration from the `x-secret` header (its webhookSecret) — the telegram
// secret_token model: one URL per provider, the row named by the secret the request carries.
function fakeChannel(overrides: Partial<Channel> = {}): Channel {
	return {
		provider: "fake",
		supports: { webhook: true, poll: true },
		mode: "webhook",
		identify: (request) => request.headers.get("x-secret") ?? undefined,
		// A webhook channel must say how it authenticates: dispatch refuses one with no verifier
		// rather than serving anonymous POSTs. Accepting unconditionally is this double's explicit,
		// visible opt-in — the fail-closed cases below override it.
		verify: () => true,
		parseInbound: ({ request }) => [
			{ externalConversationId: "chat-1", text: request.rawBody },
		],
		send: async () => {},
		...overrides,
	};
}

const ALICE = userPrincipal("alice");
const MALLORY = userPrincipal("mallory");

/** The loose api handle registrations mode contributes on `claw.api.channels.registrations`. Handlers
 *  take the authz context as their SECOND argument — in production the PEP builds it; here the tests do,
 *  because these call the unwrapped handlers directly. */
type RegistrationsApi = {
	register: (input: unknown, ctx: AuthzContext) => Promise<unknown>;
	get: (input: { id: string }, ctx: AuthzContext) => Promise<unknown>;
	getByKey: (input: unknown, ctx: AuthzContext) => Promise<unknown>;
	list: (input: unknown, ctx: AuthzContext) => Promise<unknown[]>;
	revoke: (input: unknown, ctx: AuthzContext) => Promise<unknown>;
};

function registrationsApi(plugin: {
	api?: (input: Record<string, unknown>) => unknown;
}): RegistrationsApi {
	const api = plugin.api?.({}) as {
		channels: { registrations: RegistrationsApi };
	};
	return api.channels.registrations;
}

/** A test authz context. `allow` decides each imperative decision — the default says yes, so a test
 *  about registration MECHANICS doesn't restate the authorization model, and the tests that are about
 *  authorization pass a real predicate. Every decision is recorded, so a test can assert that the handler
 *  ASKED — a check that silently stopped happening is the regression that matters most here. */
function fakeAuthz(
	principal: Principal = ALICE,
	allow: (level: string, target: AuthzTarget) => boolean = () => true,
): AuthzContext & { checks: { level: string; target: AuthzTarget }[] } {
	const checks: { level: string; target: AuthzTarget }[] = [];
	const enforce = async (level: RouteLevel, target: AuthzTarget) => {
		checks.push({ level, target });
		if (!allow(level, target)) {
			throw authorizationError("app-authz denied (test)", {
				method: "test",
				decision: "deny",
			});
		}
	};
	return {
		caller: { principal },
		principal,
		checks,
		authz: {
			enforce,
			// The real one hoists the scope resolution and the grant read out of the loop and bounds
			// concurrency; none of that is observable from a handler, so the double only has to reproduce
			// the CONTRACT — decide each row, drop the ones that deny, never throw.
			filter: async (level, rows, target) => {
				const kept = [];
				for (const row of rows) {
					try {
						await enforce(level, target(row));
						kept.push(row);
					} catch {
						// dropped, not thrown
					}
				}
				return kept;
			},
		},
	};
}

/** Configure the plugin against a bare adapter — what the createClaw assembly does. */
function configured(
	plugin: ChannelsPlugin,
	// Pass one when the TEST needs to reach the same rows the plugin writes.
	adapter: Adapter = db(),
) {
	const built = plugin.configure?.({ adapter, secrets: buildSecrets() });
	if (!built) throw new Error("expected configure to build the plugin");
	return built;
}

/** A BYO channels() plugin over the given transports. */
function registrationsPlugin(list: readonly Channel[]) {
	return configured(channels(list, { registrations: { enabled: true } }));
}

// One webhook URL per provider — no key in the path; the row is named by the `x-secret` the request
// carries (fake.identify), optionally with a separate `x-verify` credential for verify.
function webhookRequest(input: {
	body: string;
	secret?: string;
	verify?: string;
}) {
	return {
		method: "POST",
		url: "https://host/channels/fake/registrations/webhook",
		headers: {
			get: (name: string) => {
				if (name === "x-secret") return input.secret ?? null;
				if (name === "x-verify") return input.verify ?? null;
				return null;
			},
		},
		json: async () => JSON.parse(input.body) as unknown,
		text: async () => input.body,
	};
}

describe("createChannelRegistrationsStore", () => {
	it("registers with a key-derived id, rotates in place, and revokes softly", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		// `register` answers `null` when the key is taken — create-only since R-H09.
		const first = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			secret: "token-1",
			webhookSecret: "hook-1",
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-acme",
		});
		if (!first) throw new Error("expected the create to win");
		expect(first).toMatchObject({
			id: endpointId({ provider: "telegram", endpointKey: "acme-bot" }),
			status: "active",
			secret: "token-1",
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-acme",
		});

		// Rotation is the trust grant: credentials + routing secret change, one row stays — but the
		// registrant is immutable, so a manager rotating the token does not become the owner.
		//
		// Through `rotate`, not `register`. `register` is create-only now (R-H09): it used to take over
		// an existing row for whoever asked, which is a management operation the api layer had not
		// authorized. The behaviour did not go away, it moved to a verb you have to mean.
		const key = { provider: "telegram", endpointKey: "acme-bot" };
		expect(
			await store.register({
				...key,
				secret: "token-2",
				webhookSecret: "hook-2",
				createdBy: MALLORY,
			}),
		).toBeNull();
		const rotated = await store.rotate(
			key,
			{ secret: "token-2", webhookSecret: "hook-2" },
			first.updatedAt,
		);
		if (!rotated) throw new Error("expected the rotation to apply");
		expect(rotated.id).toBe(first.id);
		expect(rotated.secret).toBe("token-2");
		// R-M07: the routing key is stored DIGESTED, never verbatim. The property that matters is not
		// what the column holds but that the presented plaintext still resolves the row.
		expect(rotated.webhookSecret).not.toBe("hook-2");
		expect(rotated.webhookSecret).toBe(webhookSecretDigest("hook-2"));
		expect(rotated.createdBy).toBe(ALICE);
		await expect(store.list()).resolves.toHaveLength(1);

		const revoked = await store.revoke({
			provider: "telegram",
			endpointKey: "acme-bot",
		});
		if (!revoked) throw new Error("expected the revoke to apply");
		expect(revoked.status).toBe("disabled");

		// rotating again re-activates
		const restored = await store.rotate(
			{ provider: "telegram", endpointKey: "acme-bot" },
			{ secret: "token-3", webhookSecret: "hook-3", status: "active" },
			revoked.updatedAt,
		);
		if (!restored) throw new Error("expected the re-activation to apply");
		expect(restored.status).toBe("active");
	});

	it("defaults an unbounded registration to its registrant's personal boundary", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		const row = await store.register({
			provider: "telegram",
			endpointKey: "personal-bot",
			webhookSecret: "hook-p",
			createdBy: ALICE,
		});
		// Personal until registered into a boundary — the same default a claw takes, and the reason an
		// omitted boundary can never widen who reaches the row.
		expect(row).toMatchObject({ scope: "personal", scopeId: ALICE });
	});

	it("lists by boundary — the (scope, scopeId) link", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			webhookSecret: "hook-a",
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-acme",
		});
		await store.register({
			provider: "telegram",
			endpointKey: "globex-bot",
			webhookSecret: "hook-g",
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-globex",
		});
		const acme = await store.list({
			scope: "organization",
			scopeId: "org-acme",
		});
		expect(acme.map((row) => row.endpointKey)).toEqual(["acme-bot"]);
	});

	it("resolves a registration by its inbound secret (getBySecret), any status", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			webhookSecret: "route-me",
			createdBy: ALICE,
		});
		await expect(
			store.getBySecret("telegram", "route-me"),
		).resolves.toMatchObject({ endpointKey: "acme-bot" });
		await expect(store.getBySecret("telegram", "nope")).resolves.toBeNull();
		// revoke does not delete — getBySecret still finds it (the route enforces `active`, not the store)
		await store.revoke({ provider: "telegram", endpointKey: "acme-bot" });
		await expect(
			store.getBySecret("telegram", "route-me"),
		).resolves.toMatchObject({ status: "disabled" });
	});

	it("rejects a second registration claiming another's webhookSecret", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			webhookSecret: "shared",
			createdBy: ALICE,
		});
		await expect(
			store.register({
				provider: "telegram",
				endpointKey: "globex-bot",
				webhookSecret: "shared",
				createdBy: ALICE,
			}),
		).rejects.toThrow(/already in use/);
	});

	it("clears lastError and stamps lastReceivedAt on a received webhook event", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-x",
			createdBy: ALICE,
		});
		const recorded = await store.record(
			{ provider: "fake", endpointKey: "acme-bot" },
			{ kind: "received" },
		);
		expect(recorded).toMatchObject({ lastReceivedAt: now(), lastError: null });
	});
});

describe("channels() registrations mode", () => {
	it("rejects registration for a provider that is not in the registry", async () => {
		const api = registrationsApi(registrationsPlugin([fakeChannel()]));
		await expect(
			api.register(
				{ provider: "slack", endpointKey: "x", webhookSecret: "s" },
				fakeAuthz(),
			),
		).rejects.toThrow(/unknown channel provider/);
	});

	it("rejects a provider that can't identify itself from a request", () => {
		expect(() =>
			channels([fakeChannel({ identify: undefined })], {
				registrations: { enabled: true },
			}),
		).toThrow(/cannot be a registration transport/);
	});

	it("rejects a poll-mode registration — registrations are webhook-only", async () => {
		const api = registrationsApi(registrationsPlugin([fakeChannel()]));
		await expect(
			api.register(
				{
					provider: "fake",
					endpointKey: "poller",
					webhookSecret: "s",
					mode: "poll",
				},
				fakeAuthz(),
			),
		).rejects.toThrow(/webhook-only/);
	});

	it("binds even a registration keyed 'default' disjointly from the app bot", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		// no reserved words: the registrations/ namespace makes any key safe
		await api.register(
			{
				provider: "fake",
				endpointKey: "default",
				webhookSecret: "sec-default",
			},
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");
		const ok = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "sec-default" }),
		});
		expect(ok.status).toBe(200);
		// the app bot's unnamed key is "default"; this binding lives elsewhere
		expect(recorded.binds).toMatchObject([
			{ endpointKey: "registrations/default" },
		]);
	});

	it("rejects a registration key that is not a single segment", async () => {
		const api = registrationsApi(registrationsPlugin([fakeChannel()]));
		await expect(
			api.register(
				{
					provider: "fake",
					endpointKey: "acme/bot",
					webhookSecret: "s",
				},
				fakeAuthz(),
			),
		).rejects.toThrow(/invalid registration key/);
	});

	it("routes an inbound webhook to the registration named by its secret, with row-driven bind scope", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		await api.register(
			{
				provider: "fake",
				endpointKey: "acme-bot",
				webhookSecret: "hook-1",
				scope: "organization",
				scopeId: "org-acme",
				claw: { name: "Acme bot" },
			},
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");

		// a secret that names no registration can't be routed — 404 (absent and unknown look identical)
		const stranger = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "wrong" }),
		});
		expect(stranger.status).toBe(404);

		const ok = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "hook-1" }),
		});
		expect(ok.status).toBe(200);
		expect(recorded.relayed).toEqual(["hello"]);
		// the row's own boundary + claw defaults drove the bind — tenancy never touched transport identity,
		// and the binding key is namespaced so it can never collide with an app bot's. The registration's
		// (scope, scopeId) places the claw; createdBy is a principal filled at bind time (system:anonymous
		// when the conversation is unauthenticated), never the endpoint or external id.
		expect(recorded.binds).toMatchObject([
			{
				provider: "fake",
				endpointKey: "registrations/acme-bot",
				claw: { scope: "organization", scopeId: "org-acme", name: "Acme bot" },
			},
		]);
	});

	it("still fails closed — a routed request whose verify fails is rejected (401)", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		// identify routes by x-secret; verify gates on a separate x-verify credential
		const channel = fakeChannel({
			verify: ({ request, endpoint }) =>
				request.headers.get("x-verify") === endpoint.webhookSecret,
		});
		const plugin = registrationsPlugin([channel]);
		const api = registrationsApi(plugin);
		await api.register(
			{
				provider: "fake",
				endpointKey: "acme-bot",
				webhookSecret: "hook-c",
			},
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");

		// routed to the row (x-secret matches) but verify rejects (x-verify wrong) → 401, nothing relayed
		const denied = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({
				body: "hello",
				secret: "hook-c",
				verify: "wrong",
			}),
		});
		expect(denied.status).toBe(401);
		expect(recorded.relayed).toEqual([]);

		const ok = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({
				body: "hello",
				secret: "hook-c",
				verify: "hook-c",
			}),
		});
		expect(ok.status).toBe(200);
	});

	it("hides unknown and revoked registrations identically (404)", async () => {
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");

		const unknown = await route.handler({
			claw: fakeClaw({ binds: [], relayed: [] }),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "ghost" }),
		});
		expect(unknown.status).toBe(404);

		await api.register(
			{
				provider: "fake",
				endpointKey: "acme-bot",
				webhookSecret: "hook-r",
			},
			fakeAuthz(),
		);
		await api.revoke(
			{ provider: "fake", endpointKey: "acme-bot" },
			fakeAuthz(),
		);
		const revoked = await route.handler({
			claw: fakeClaw({ binds: [], relayed: [] }),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "hook-r" }),
		});
		expect(revoked.status).toBe(404);
	});

	it("binds a personal registration into its registrant's own boundary", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		await api.register(
			{
				provider: "fake",
				endpointKey: "personal-bot",
				webhookSecret: "hook-p",
				claw: { name: "Personal bot" },
			},
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");
		const result = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "hook-p" }),
		});
		expect(result.status).toBe(200);
		// No explicit boundary at register ⇒ personal to the registrant, and the bind inherits exactly
		// that: an unbounded bot's conversations are the registrant's, never loose in a shared scope.
		expect(recorded.binds).toMatchObject([
			{ claw: { name: "Personal bot", scope: "personal", scopeId: ALICE } },
		]);
	});

	it("mounts one shared registrations webhook route (no key in path) and a drain cron", () => {
		const base = channels([fakeChannel()], {
			registrations: { enabled: true },
		});
		// The static markers ride the plugin object; the webhook route is the RUNTIME half (configure).
		// Registrations never POLL — but they do contribute the delivery queues' drain, and a durable
		// queue nothing drains is the guarantee-by-configuration this whole design removes.
		expect(base.$HasCron).toBe("has-cron");
		expect(base.$RequiresDatabase).toBe(true);
		const runtime = configured(base);
		expect(runtime.routes?.map((route) => route.path)).toEqual([
			"/channels/:provider/registrations/webhook",
		]);
		// Registrations never poll, so there is no poll task — but the queues' drain is scheduled work,
		// and it is the only thing that finishes a delivery whose inline attempt died.
		expect(runtime.cron?.map((task) => task.id)).toEqual([
			"channels:registrations:drain",
		]);
	});

	it("declares no app-bot token secret in registrations mode — tokens live in the rows", () => {
		expect(
			channels([fakeChannel()], { registrations: { enabled: true } }).secrets,
		).toBeUndefined();
	});

	it("rejects registrations enabled with an empty provider list", () => {
		expect(() => channels([], { registrations: { enabled: true } })).toThrow(
			/no providers/,
		);
	});

	it("rejects two transports of one provider (one registration transport each)", () => {
		expect(() =>
			channels([fakeChannel(), fakeChannel()], {
				registrations: { enabled: true },
			}),
		).toThrow(/duplicate channel provider/);
	});
});

// The management surface used to be ungoverned and credential-leaking: rows had no owner, so any
// authenticated caller reached any tenant's bot, and every read handed back the bot token and the
// inbound routing secret in full. These are the properties that close it.
describe("registrations management is owned, bounded, and credential-free", () => {
	const registered = async (
		api: RegistrationsApi,
		endpointKey: string,
		ctx = fakeAuthz(),
	) =>
		api.register(
			{
				provider: "fake",
				endpointKey,
				secret: "bot-token-super-secret",
				webhookSecret: `hook-${endpointKey}`,
			},
			ctx,
		);

	it("returns no credentials from any read — only whether one is set", async () => {
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		const created = (await registered(api, "acme-bot")) as Record<
			string,
			unknown
		>;

		// register is a read too: it used to hand the token straight back to whoever posted it.
		expect(created).not.toHaveProperty("secret");
		expect(created).not.toHaveProperty("webhookSecret");
		expect(created.hasSecret).toBe(true);
		expect(created.createdBy).toBe(ALICE);

		const id = endpointId({ provider: "fake", endpointKey: "acme-bot" });
		for (const row of [
			(await api.get({ id }, fakeAuthz())) as Record<string, unknown>,
			(await api.getByKey(
				{ provider: "fake", endpointKey: "acme-bot" },
				fakeAuthz(),
			)) as Record<string, unknown>,
			(await api.revoke(
				{ provider: "fake", endpointKey: "acme-bot" },
				fakeAuthz(),
			)) as Record<string, unknown>,
			((await api.list({}, fakeAuthz())) as Record<string, unknown>[])[0] ?? {},
		]) {
			expect(row).not.toHaveProperty("secret");
			expect(row).not.toHaveProperty("webhookSecret");
		}

		// The value is still THERE — the store keeps it, because dispatch calls the provider with it and
		// the webhook route matches on it. What changed is that no caller-facing path returns it.
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			secret: "bot-token-super-secret",
			webhookSecret: "hook-acme-bot",
			createdBy: ALICE,
		});
		expect((await store.get(id))?.secret).toBe("bot-token-super-secret");
	});

	it("reports hasSecret false for a registration with no egress credential", async () => {
		const api = registrationsApi(registrationsPlugin([fakeChannel()]));
		const created = (await api.register(
			{ provider: "fake", endpointKey: "tokenless", webhookSecret: "hook-t" },
			fakeAuthz(),
		)) as Record<string, unknown>;
		expect(created.hasSecret).toBe(false);
	});

	it("checks manage on the existing row before a re-registration rotates it", async () => {
		const api = registrationsApi(registrationsPlugin([fakeChannel()]));
		await registered(api, "acme-bot");
		const id = endpointId({ provider: "fake", endpointKey: "acme-bot" });

		// The hijack: re-register someone else's (provider, endpointKey) with your own credentials and
		// their traffic starts flowing to you. The natural key is public — the row is not.
		const mallory = fakeAuthz(MALLORY, () => false);
		await expect(
			api.register(
				{
					provider: "fake",
					endpointKey: "acme-bot",
					secret: "mallory-token",
					webhookSecret: "hook-mallory",
				},
				mallory,
			),
		).rejects.toThrow(/denied/);
		expect(mallory.checks).toEqual([
			{ level: "manage", target: { kind: "channel_registration", id } },
		]);

		// and nothing rotated — the denial happened before the write
		const store = createChannelRegistrationsStore(db(), { now });
		await expect(store.getBySecret("fake", "hook-mallory")).resolves.toBeNull();
	});

	it("authorizes an explicit boundary as membership before writing it", async () => {
		const api = registrationsApi(registrationsPlugin([fakeChannel()]));

		// Registering into a boundary you are not in would hand that tenant a bot they do not control
		// and push its conversations into their data.
		const outsider = fakeAuthz(MALLORY, () => false);
		await expect(
			api.register(
				{
					provider: "fake",
					endpointKey: "acme-bot",
					webhookSecret: "hook-x",
					scope: "organization",
					scopeId: "org-acme",
				},
				outsider,
			),
		).rejects.toThrow(/denied/);
		expect(outsider.checks).toEqual([
			{ level: "use", target: { scope: "organization", scopeId: "org-acme" } },
		]);
	});

	it("refuses half a boundary rather than guessing the other half", async () => {
		const api = registrationsApi(registrationsPlugin([fakeChannel()]));
		await expect(
			api.register(
				{
					provider: "fake",
					endpointKey: "acme-bot",
					webhookSecret: "hook-h",
					scope: "organization",
				},
				fakeAuthz(),
			),
		).rejects.toThrow(/boundary incomplete/);
	});

	it("filters a listing row by row, as the single-row read", async () => {
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		await registered(api, "acme-bot");
		await registered(api, "globex-bot");
		const mine = endpointId({ provider: "fake", endpointKey: "acme-bot" });

		// A caller who may read exactly one of them sees exactly one. The filter narrows; it never
		// decides — a wide filter returns what the caller may read, not everything.
		const ctx = fakeAuthz(
			MALLORY,
			(_level, target) => "kind" in target && target.id === mine,
		);
		const rows = (await api.list({}, ctx)) as Record<string, unknown>[];
		expect(rows.map((row) => row.endpointKey)).toEqual(["acme-bot"]);
		// Denied rows are ABSENT, not an error: one unreadable row must not fail the page, and
		// distinguishing "denied" from "not there" would make the list a probe for other tenants' bots.
		expect(ctx.checks).toHaveLength(2);
	});

	it("registers the channel_registration kind so the PEP can load it", async () => {
		const base = channels([fakeChannel()], {
			registrations: { enabled: true },
		});
		const kind = base.shareable?.find(
			(entry) => entry.kind === "channel_registration",
		);
		if (!kind) throw new Error("expected the channel_registration kind");

		// The one per-kind bit: a data-fetcher. Without it every binding above resolves to an
		// unregistered kind and the routes are inert — so this asserts the loader ANSWERS.
		const adapter = db();
		const store = createChannelRegistrationsStore(adapter, { now });
		const row = await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-1",
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-acme",
		});
		if (!row) throw new Error("expected the create to win");
		const load = kind.load({ adapter });
		await expect(load(row.id)).resolves.toEqual({
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-acme",
		});
		// Absent ⇒ null ⇒ DENY, like every other loader.
		await expect(load("no-such-row")).resolves.toBeNull();
	});
});

// H-10. A provider retries — on a non-2xx, on a timeout, on its own schedule — and nothing
// distinguished a retry from a new message. `dispatchWebhook` now claims `(provider, endpointKey,
// deliveryId)` before the turn runs, and the claim IS the row's insert, so a second attempt at the same
// delivery loses to the database rather than to a read two processes can both pass.
//
// Testable in memory because the adapter now declares that it does NOT arbitrate uniqueness, and
// `entityAdapter` checks before writing on its behalf — so insert-as-claim behaves the same here as
// against a real engine. It did not, until it did: the branch that handles losing was unreachable in
// every test in the tree.
describe("a delivery is relayed at most once", () => {
	// The fake numbers its deliveries the way a provider does — the same body twice IS the same
	// delivery, which is exactly what a retry looks like on the wire.
	const numbered = () =>
		fakeChannel({
			parseInbound: ({ request }) => [
				{
					deliveryId: request.rawBody,
					externalConversationId: "chat-1",
					text: request.rawBody,
				},
			],
		});

	const registered = async () => {
		const plugin = registrationsPlugin([numbered()]);
		await registrationsApi(plugin).register(
			{ provider: "fake", endpointKey: "acme-bot", webhookSecret: "hook-1" },
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");
		return route;
	};

	it("ignores a retry of a delivery it already handled", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const route = await registered();
		const deliver = (body: string) =>
			route.handler({
				claw: fakeClaw(recorded),
				params: { provider: "fake" },
				request: webhookRequest({ body, secret: "hook-1" }),
			});

		const first = await deliver("u-1");
		const retry = await deliver("u-1");

		// Both answered 200 — the provider must STOP retrying, and an error would only make it try
		// harder. What differs is what RAN: one turn, one bind, one reply.
		expect(first.status).toBe(200);
		expect(retry.status).toBe(200);
		expect(recorded.relayed).toEqual(["u-1"]);
		expect(recorded.binds).toHaveLength(1);
		// …and the count reports what this endpoint ran, not what arrived at it.
		expect((retry.body as { data: { processed: number } }).data.processed).toBe(
			0,
		);
	});

	it("still relays a genuinely new delivery", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const route = await registered();
		const deliver = (body: string) =>
			route.handler({
				claw: fakeClaw(recorded),
				params: { provider: "fake" },
				request: webhookRequest({ body, secret: "hook-1" }),
			});
		await deliver("u-1");
		await deliver("u-2");
		expect(recorded.relayed).toEqual(["u-1", "u-2"]);
	});
});

describe("a delivery carries the provider's id", () => {
	it("threads deliveryId from the transport to the dispatch", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const seen: (string | undefined)[] = [];
		const plugin = registrationsPlugin([
			fakeChannel({
				parseInbound: ({ request }) => {
					const message = {
						deliveryId: request.rawBody,
						externalConversationId: "chat-1",
						text: request.rawBody,
					};
					seen.push(message.deliveryId);
					return [message];
				},
			}),
		]);
		await registrationsApi(plugin).register(
			{ provider: "fake", endpointKey: "acme-bot", webhookSecret: "hook-1" },
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");
		const result = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({ body: "u-1", secret: "hook-1" }),
		});
		expect(result.status).toBe(200);
		// The id reached the dispatch, which is what the claim keys on — the claim's own enforcement
		// needs a database that honours the constraint.
		expect(seen).toEqual(["u-1"]);
		expect(recorded.relayed).toEqual(["u-1"]);
	});
});

// De-duplicating the inbound half created a new way to LOSE a reply: the turn runs, the process dies
// before `send`, and the delivery is already claimed — so the provider's retry correctly declines to
// re-run it and the answer is simply gone. The outbox is what makes at-most-once inbound and
// at-least-once outbound hold together.
describe("a reply is durable before it is sent", () => {
	const numbered = (send: Channel["send"]) =>
		fakeChannel({
			send,
			parseInbound: ({ request }) => [
				{
					deliveryId: request.rawBody,
					externalConversationId: "chat-1",
					text: request.rawBody,
				},
			],
		});

	it("keeps the reply owed when the send fails, and drainOutbox finishes it", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const adapter = db();
		const sent: string[] = [];
		let failNext = true;
		const channel = numbered(async ({ message }) => {
			if (failNext) {
				failNext = false;
				throw new Error("telegram unreachable");
			}
			sent.push(message.text);
		});
		const plugin = configured(
			channels([channel], { registrations: { enabled: true } }),
			adapter,
		);
		await registrationsApi(plugin).register(
			{ provider: "fake", endpointKey: "acme-bot", webhookSecret: "hook-1" },
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");

		// The turn runs and the send fails. The reply is NOT lost — it was written first.
		await expect(
			route.handler({
				claw: fakeClaw(recorded),
				params: { provider: "fake" },
				request: webhookRequest({ body: "u-1", secret: "hook-1" }),
			}),
		).rejects.toThrow(/telegram unreachable/);
		expect(sent).toEqual([]);

		const outbox = createDeliveryOutbox(adapter);
		expect(await outbox.pending()).toMatchObject([
			{ deliveryId: "u-1", text: "echo:u-1", attempts: 1 },
		]);

		// A failed send BACKS OFF: the drain that runs a second later must not hammer a provider that
		// just refused it. So the recovery is the drain that runs LATER, which is what the schedule is.
		const later = createDeliveryOutbox(adapter, {
			now: () => new Date(Date.now() + 5 * 60 * 1000).toISOString(),
		});

		// The recovery: whatever the deployment runs on a schedule finishes what the crash left owed.
		const result = await drainOutbox({
			outbox: later,
			// The resolver now hands back the transport WITH the endpoint: the drain has to know which
			// channel to send through, and looking it up from a separate map meant two sources that could
			// disagree about which provider a stored row belonged to.
			endpointFor: () => ({
				channel,
				endpoint: {
					provider: "fake",
					endpointKey: "registrations/acme-bot",
					mode: "webhook" as const,
				},
			}),
		});
		expect(result).toEqual({ sent: 1, failed: 0 });
		expect(sent).toEqual(["echo:u-1"]);
		// …and nothing is owed twice.
		expect(await outbox.pending()).toEqual([]);
	});

	it("owes nothing once the reply has gone out", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const adapter = db();
		const plugin = configured(
			channels([numbered(async () => {})], {
				registrations: { enabled: true },
			}),
			adapter,
		);
		await registrationsApi(plugin).register(
			{ provider: "fake", endpointKey: "acme-bot", webhookSecret: "hook-1" },
			fakeAuthz(),
		);
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");
		await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({ body: "u-1", secret: "hook-1" }),
		});
		expect(await createDeliveryOutbox(adapter).pending()).toEqual([]);
	});
});

// R-H09 — registering is create-only, and taking over an existing row is a `manage` decision.
//
// The endpoint enforced `manage` only when its own read FOUND a row. The store then read again and
// patched whatever it found — with the second caller's token, secret, scope and bind defaults — and
// the create's catch path did the same on a lost race. So a caller who arrives when the row does not
// exist yet, or who loses the create by microseconds, rewrites somebody else's registration without
// ever being asked for `manage`. The natural key is `(provider, endpointKey)` and the endpointKey is
// caller-chosen, so the race is not hypothetical: it is what happens when two tenants pick the same
// obvious name, and it is trivially forced by anyone who wants it.
describe("registering cannot take over an existing row unasked (R-H09)", () => {
	it("refuses to rotate a row the caller may not manage", async () => {
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		// Alice's bot exists.
		await api.register(
			{
				provider: "fake",
				endpointKey: "acme-bot",
				webhookSecret: "alice-hook",
			},
			fakeAuthz(ALICE),
		);

		// Bob re-registers the same natural key. He is not the registrant and holds no grant, so the
		// only honest answer is a denial — not a silent rotation onto his token.
		const bob = fakeAuthz(MALLORY, (level) => level !== "manage");
		await expect(
			api.register(
				{
					provider: "fake",
					endpointKey: "acme-bot",
					webhookSecret: "bob-hook",
				},
				bob,
			),
		).rejects.toThrow(/app-authz denied/);

		// And Alice's row is untouched, so her traffic still routes to her. Asserted through the
		// resolver rather than the view: the view omits both secrets by design.
		// That the row is UNCHANGED is asserted one test down, against the store — the view omits both
		// secrets by design, and the secret is the whole point, being the inbound routing key.
		// Asserting it here would mean reaching for something the api deliberately does not return.
	});

	it("the store REFUSES to rotate — it creates, or it reports the key is taken", async () => {
		// The store-level contract, which is what actually closes the hole. The endpoint's read can
		// always be stale — the row may appear between the check and the write — so the fix cannot be
		// "read more carefully". It has to be that the write itself will not take over a row, leaving
		// the api layer the only place a takeover can be decided.
		const store = createChannelRegistrationsStore(db(), { now });
		const lookup = { provider: "fake", endpointKey: "acme-bot" };
		const mine = await store.register({
			...lookup,
			webhookSecret: "alice-hook",
			createdBy: ALICE,
		});
		expect(mine).not.toBeNull();

		// Second register on the same natural key: null, and NOT a silent rotation.
		expect(
			await store.register({
				...lookup,
				webhookSecret: "mallory-hook",
				createdBy: MALLORY,
			}),
		).toBeNull();
		expect((await store.getByKey(lookup))?.webhookSecret).toBe(
			webhookSecretDigest("alice-hook"),
		);
	});

	it("rotate is a compare-and-set against the row that was authorized", async () => {
		// `manage` is decided against a row that can change before the write lands. Passing the
		// `updatedAt` the decision was made on is what makes the rotation refuse a row that moved.
		// An ADVANCING clock: the shared fixed `now` makes every `updatedAt` identical, so a stale
		// version is indistinguishable from a current one and the CAS has nothing to compare.
		let tick = 0;
		const store = createChannelRegistrationsStore(db(), {
			now: () => `2026-01-01T00:00:0${tick++}.000Z`,
		});
		const lookup = { provider: "fake", endpointKey: "acme-bot" };
		const created = await store.register({
			...lookup,
			webhookSecret: "alice-hook",
			createdBy: ALICE,
		});
		if (!created) throw new Error("expected the create to win");

		expect(
			await store.rotate(
				lookup,
				{ webhookSecret: "rotated" },
				created.updatedAt,
			),
		).not.toBeNull();
		// Stale version — the row is no longer the one that was authorized.
		expect(
			await store.rotate(lookup, { webhookSecret: "later" }, created.updatedAt),
		).toBeNull();
		expect((await store.getByKey(lookup))?.webhookSecret).toBe(
			webhookSecretDigest("rotated"),
		);
	});
});

// R-H09, the physical half. The webhookSecret is the INBOUND ROUTING KEY — the webhook route finds
// the row by matching it — so two rows sharing one makes routing ambiguous, and which bot receives a
// tenant's traffic becomes a question of row order.
//
// The column's own doc has always said "must be unique per provider" and the store checked it with a
// read before the write. That is the same time-of-check gap as the registration race one layer up:
// two registers can both read "free" and both write. A physical unique is the only thing that makes
// the claim true under concurrency, and it is what turns a lost race into a loud conflict rather
// than a silently ambiguous route.
describe("the inbound routing key is physically unique (R-H09)", () => {
	it("declares (provider, webhookSecret) as a natural key", () => {
		expect(
			channelRegistrationEntity.storage.channel_registration?.uniques,
		).toContainEqual(["provider", "webhookSecret"]);
	});

	it("refuses a second registration claiming a taken secret", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "fake",
			endpointKey: "alice-bot",
			webhookSecret: "shared-hook",
			createdBy: ALICE,
		});
		await expect(
			store.register({
				provider: "fake",
				endpointKey: "mallory-bot",
				webhookSecret: "shared-hook",
				createdBy: MALLORY,
			}),
		).rejects.toThrow(/webhookSecret already in use/);
	});
});

// R-M07. The inbound routing key was persisted VERBATIM — a live credential in a table, and the one
// an attacker most wants, because presenting it IS how a request proves which registration it is. It
// could not simply be encrypted: the row is FOUND by matching it, and a nonce-per-row ciphertext is
// unmatchable. Digested instead, which is what a high-entropy random secret wants anyway.
describe("the inbound routing key is not stored verbatim (R-M07)", () => {
	it("stores a digest, and still resolves the row from the presented plaintext", async () => {
		const adapter = db();
		const store = createChannelRegistrationsStore(adapter, { now });
		await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-secret",
			createdBy: userPrincipal("alice"),
		});

		// Nothing in the row equals what the provider will echo.
		const row = await store.getByKey({
			provider: "fake",
			endpointKey: "acme-bot",
		});
		expect(row?.webhookSecret).not.toBe("hook-secret");
		expect(row?.webhookSecret).toBe(webhookSecretDigest("hook-secret"));

		// …and the lookup the webhook route makes still works, from the plaintext alone.
		await expect(
			store.getBySecret("fake", "hook-secret"),
		).resolves.toMatchObject({ endpointKey: "acme-bot" });
		await expect(store.getBySecret("fake", "not-it")).resolves.toBeNull();
	});

	it("digests a rotated key too — no write path leaves the plaintext behind", async () => {
		const adapter = db();
		const store = createChannelRegistrationsStore(adapter, { now });
		const created = await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "first",
			createdBy: userPrincipal("alice"),
		});
		if (!created) throw new Error("expected the registration to be created");

		await store.rotate(
			{ provider: "fake", endpointKey: "acme-bot" },
			{ webhookSecret: "second" },
			created.updatedAt,
		);
		const row = await store.getByKey({
			provider: "fake",
			endpointKey: "acme-bot",
		});
		expect(row?.webhookSecret).not.toBe("second");
		await expect(store.getBySecret("fake", "second")).resolves.toMatchObject({
			endpointKey: "acme-bot",
		});
		// The old key no longer routes.
		await expect(store.getBySecret("fake", "first")).resolves.toBeNull();
	});
});

// R-M07. The BOT TOKEN is the credential that acts AS the bot: whoever holds it sends as that bot,
// reads its conversations, and does not need this system at all to do it. It sat in a column readable
// by anything with database access. Unlike the routing key it is read BACK to call the provider, so
// it is encrypted rather than hashed.
describe("the bot token is sealed at rest (R-M07)", () => {
	const KEY = "11".repeat(32);
	const withKey = () =>
		buildSecrets([env({ vars: { BUSYCLAW_SECRET_STORE_KEY: KEY } })]);

	it("stores a sealed token and opens it only for use", async () => {
		const adapter = db();
		const cipher = optionalCipher(withKey());
		const store = createChannelRegistrationsStore(adapter, { now, cipher });

		const created = await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook",
			secret: "bot-token-xyz",
			createdBy: userPrincipal("alice"),
		});
		if (!created) throw new Error("expected the registration to be created");

		// Nothing in the row is the token.
		expect(created.secret).not.toBe("bot-token-xyz");
		expect(created.secret).toMatch(/^k1\./);

		// …and the one place it is opened gets the real thing back.
		await expect(openRegistrationSecret(created, cipher)).resolves.toBe(
			"bot-token-xyz",
		);
	});

	// The AAD binds each ciphertext to its own (scope, scopeId, name), which is what makes ONE
	// deployment key safe across every consumer: a token lifted into another registration's row does
	// not open there.
	it("refuses to open a token relocated into another registration", async () => {
		const adapter = db();
		const cipher = optionalCipher(withKey());
		const store = createChannelRegistrationsStore(adapter, { now, cipher });
		const mine = await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-a",
			secret: "bot-token-xyz",
			createdBy: userPrincipal("alice"),
		});
		if (!mine) throw new Error("expected the registration to be created");

		// The same ciphertext, presented as another registration's row.
		const stolen = { ...mine, endpointKey: "other-bot" };
		await expect(openRegistrationSecret(stolen, cipher)).resolves.not.toBe(
			"bot-token-xyz",
		);
	});

	// A deployment with no master key keeps working — registering a bot is not a request to run a
	// key-management story, and failing every registration on a key nobody was told to set would take
	// working deployments down to protect a column.
	it("passes the token through when no master key is configured", async () => {
		const adapter = db();
		const cipher = optionalCipher(buildSecrets([]));
		const store = createChannelRegistrationsStore(adapter, { now, cipher });
		const created = await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook",
			secret: "bot-token-xyz",
			createdBy: userPrincipal("alice"),
		});
		expect(created?.secret).toBe("bot-token-xyz");
	});
});
