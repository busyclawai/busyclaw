import { entityAdapter, memoryAdapter } from "@euroclaw/storage-core";
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
		parseInbound: ({ request }) => [
			{ externalConversationId: "chat-1", text: request.rawBody },
		],
		send: async () => {},
		...overrides,
	};
}

/** The loose api handle registrations mode contributes on `claw.api.channels.registrations`. */
type RegistrationsApi = {
	register: (input: unknown) => Promise<unknown>;
	get: (input: { id: string }) => Promise<unknown>;
	getByKey: (input: unknown) => Promise<unknown>;
	revoke: (input: unknown) => Promise<unknown>;
};

function registrationsApi(plugin: ChannelsPlugin): RegistrationsApi {
	const api = plugin.api?.({}) as {
		channels: { registrations: RegistrationsApi };
	};
	return api.channels.registrations;
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
			organizationId: "org-acme",
		});
		expect(first).toMatchObject({
			id: endpointId({ provider: "telegram", endpointKey: "acme-bot" }),
			status: "active",
			secret: "token-1",
			organizationId: "org-acme",
		});

		// re-registration is the trust grant: rotate credentials + routing secret, stay one row
		const rotated = await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			secret: "token-2",
			webhookSecret: "hook-2",
		});
		expect(rotated.id).toBe(first.id);
		expect(rotated.secret).toBe("token-2");
		expect(rotated.webhookSecret).toBe("hook-2");
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
		});
		expect(restored.status).toBe("active");
	});

	it("lists by organization — the organizationId-style link", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			webhookSecret: "hook-a",
			organizationId: "org-acme",
		});
		await store.register({
			provider: "telegram",
			endpointKey: "globex-bot",
			webhookSecret: "hook-g",
			organizationId: "org-globex",
		});
		const acme = await store.list({ organizationId: "org-acme" });
		expect(acme.map((row) => row.endpointKey)).toEqual(["acme-bot"]);
	});

	it("resolves a registration by its inbound secret (getBySecret), any status", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			webhookSecret: "route-me",
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
		});
		await expect(
			store.register({
				provider: "telegram",
				endpointKey: "globex-bot",
				webhookSecret: "shared",
			}),
		).rejects.toThrow(/already in use/);
	});

	it("clears lastError and stamps lastReceivedAt on a received webhook event", async () => {
		const store = createChannelRegistrationsStore(db(), { now });
		await store.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-x",
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
			api.register({ provider: "slack", endpointKey: "x", webhookSecret: "s" }),
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
			api.register({
				provider: "fake",
				endpointKey: "poller",
				webhookSecret: "s",
				mode: "poll",
			}),
		).rejects.toThrow(/webhook-only/);
	});

	it("binds even a registration keyed 'default' disjointly from the app bot", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		// no reserved words: the registrations/ namespace makes any key safe
		await api.register({
			provider: "fake",
			endpointKey: "default",
			webhookSecret: "sec-default",
		});
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
			api.register({
				provider: "fake",
				endpointKey: "acme/bot",
				webhookSecret: "s",
			}),
		).rejects.toThrow(/invalid registration key/);
	});

	it("routes an inbound webhook to the registration named by its secret, with row-driven bind scope", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		await api.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-1",
			organizationId: "org-acme",
			claw: { name: "Acme bot" },
		});
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
		// the row's organization + claw defaults drove the bind — tenancy never touched transport identity,
		// and the binding key is namespaced so it can never collide with an app bot's. The org places the
		// claw via the standard (scope, scopeId) boundary; createdBy is a principal filled at bind time
		// (system:anonymous when the conversation is unauthenticated), never the endpoint or external id.
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
		await api.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-c",
		});
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

		await api.register({
			provider: "fake",
			endpointKey: "acme-bot",
			webhookSecret: "hook-r",
		});
		await api.revoke({ provider: "fake", endpointKey: "acme-bot" });
		const revoked = await route.handler({
			claw: fakeClaw({ binds: [], relayed: [] }),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "hook-r" }),
		});
		expect(revoked.status).toBe(404);
	});

	it("binds organizationless registrations fine — tenancy is opt-in row data", async () => {
		const recorded = { binds: [] as unknown[], relayed: [] as string[] };
		const plugin = registrationsPlugin([fakeChannel()]);
		const api = registrationsApi(plugin);
		await api.register({
			provider: "fake",
			endpointKey: "personal-bot",
			webhookSecret: "hook-p",
			claw: { name: "Personal bot" },
		});
		const route = plugin.routes?.[0];
		if (!route) throw new Error("expected the registrations webhook route");
		const result = await route.handler({
			claw: fakeClaw(recorded),
			params: { provider: "fake" },
			request: webhookRequest({ body: "hello", secret: "hook-p" }),
		});
		expect(result.status).toBe(200);
		expect(recorded.binds).toMatchObject([{ claw: { name: "Personal bot" } }]);
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
