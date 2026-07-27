import {
	type AuthzContext,
	type AuthzTarget,
	authorizationError,
	type Principal,
	userPrincipal,
} from "@busyclaw/contracts";
import { entityAdapter, memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import {
	type Channel,
	type ChannelsPlugin,
	channels,
	endpointId,
} from "../src/index";
import { channelRegistrationsModels } from "../src/registrations/schema";
import { createChannelRegistrationsStore } from "../src/registrations/store";

// Stores and the configure context take the schema-aware adapter the assembly provides in
// production; tests wrap manually.
const db = () => entityAdapter(memoryAdapter(), channelRegistrationsModels);

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

function registrationsApi(plugin: ChannelsPlugin): RegistrationsApi {
	const api = plugin.api?.({}) as {
		channels: { registrations: RegistrationsApi };
	};
	return api.channels.registrations;
}

/** A test authz context. `allow` decides each imperative `ctx.check` — the default says yes, so a test
 *  about registration MECHANICS doesn't restate the authorization model, and the tests that are about
 *  authorization pass a real predicate. Every check is recorded, so a test can assert that the handler
 *  ASKED — a check that silently stopped happening is the regression that matters most here. */
function fakeAuthz(
	principal: Principal = ALICE,
	allow: (level: string, target: AuthzTarget) => boolean = () => true,
): AuthzContext & { checks: { level: string; target: AuthzTarget }[] } {
	const checks: { level: string; target: AuthzTarget }[] = [];
	const check = async (level: string, target: AuthzTarget) => {
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
		check,
		// The real one hoists the scope resolution and bounds concurrency; neither is observable from a
		// handler, so the double only has to reproduce the CONTRACT — decide each row, drop the ones
		// that deny, never throw.
		filter: async (level, rows, target) => {
			const kept = [];
			for (const row of rows) {
				try {
					await check(level, target(row));
					kept.push(row);
				} catch {
					// dropped, not thrown
				}
			}
			return kept;
		},
	};
}

/** Configure the plugin against a bare adapter — what the createClaw assembly does. */
function configured(plugin: ChannelsPlugin): ChannelsPlugin {
	const built = plugin.configure?.({ adapter: db() });
	if (!built) throw new Error("expected configure to build the plugin");
	return built;
}

/** A BYO channels() plugin over the given transports. */
function registrationsPlugin(list: readonly Channel[]): ChannelsPlugin {
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
		const first = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			secret: "token-1",
			webhookSecret: "hook-1",
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-acme",
		});
		expect(first).toMatchObject({
			id: endpointId({ provider: "telegram", endpointKey: "acme-bot" }),
			status: "active",
			secret: "token-1",
			createdBy: ALICE,
			scope: "organization",
			scopeId: "org-acme",
		});

		// re-registration is the trust grant: rotate credentials + routing secret, stay one row — but the
		// registrant is immutable, so a manager rotating the token does not become the owner.
		const rotated = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			secret: "token-2",
			webhookSecret: "hook-2",
			createdBy: MALLORY,
		});
		expect(rotated.id).toBe(first.id);
		expect(rotated.secret).toBe("token-2");
		expect(rotated.webhookSecret).toBe("hook-2");
		expect(rotated.createdBy).toBe(ALICE);
		await expect(store.list()).resolves.toHaveLength(1);

		const revoked = await store.revoke({
			provider: "telegram",
			endpointKey: "acme-bot",
		});
		expect(revoked?.status).toBe("disabled");

		// registering again re-activates
		const restored = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			secret: "token-3",
			webhookSecret: "hook-3",
			createdBy: ALICE,
		});
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

	it("mounts one shared registrations webhook route (no key in path) and no cron", () => {
		const base = channels([fakeChannel()], {
			registrations: { enabled: true },
		});
		// The static markers ride the plugin object; the webhook route is the RUNTIME half (configure).
		expect(base.$HasCron).toBe("no-cron");
		expect(base.$RequiresDatabase).toBe(true);
		const runtime = configured(base);
		expect(runtime.routes?.map((route) => route.path)).toEqual([
			"/channels/:provider/registrations/webhook",
		]);
		// Registrations never poll — the runtime half contributes no cron.
		expect(runtime.cron ?? []).toEqual([]);
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
