import { field, userPrincipal } from "@busyclaw/contracts";
import { createStoredRedactor, noopDetector } from "@busyclaw/core";
import { env } from "@busyclaw/secrets";
import { secrets } from "@busyclaw/secrets-plugin";
import { memoryAdapter } from "@busyclaw/storage-core";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import type { wrapLanguageModel } from "ai";
import { createClaw, getBusyclawTables } from "busyclaw";
import { describe, expect, it, vi } from "vitest";
import { type Channel, channels } from "../src/index";
import { telegram, telegramWebhookSecret } from "../src/telegram/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function textModel(text: string): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
			warnings: [],
		}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

function appBot() {
	// the app's own bot: its token resolves through the one-door reader (secrets.get), so bare
	// telegram() is the whole config — these tests don't drive its traffic, so no reader is needed
	return telegram();
}

describe("channels ↔ busyclaw integration", () => {
	it("collects each mode's own table via getBusyclawTables", () => {
		const withPlugins = getBusyclawTables({
			plugins: [
				channels([appBot()]),
				channels([telegram()], { registrations: { enabled: true } }),
			],
		});
		// app-bot channels owns operational state only — no credentials, no tenancy
		expect(withPlugins.channel_endpoint?.fields.cursor).toBeDefined();
		expect(withPlugins.channel_endpoint?.fields.secret).toBeUndefined();
		expect(withPlugins.channel_endpoint?.fields.organizationId).toBeUndefined();
		// registrations mode owns the registration row — the ssoProvider analog
		expect(withPlugins.channel_registration?.fields.secret).toBeDefined();
		expect(
			withPlugins.channel_registration?.fields.webhookSecret,
		).toBeDefined();
		// …and the ownership columns that make it a shareable resource: who registered it, and the
		// boundary that decides who may manage it and where its conversations land.
		expect(withPlugins.channel_registration?.fields.createdBy).toBeDefined();
		expect(withPlugins.channel_registration?.fields.scope).toBeDefined();
		expect(withPlugins.channel_registration?.fields.scopeId).toBeDefined();
		// The org-only column it replaced is gone — core reads neither half of the pair.
		expect(
			withPlugins.channel_registration?.fields.organizationId,
		).toBeUndefined();
		// registrations are webhook-only — no poll columns on the row
		expect(withPlugins.channel_registration?.fields.cursor).toBeUndefined();
		expect(
			withPlugins.channel_registration?.fields.lastPolledAt,
		).toBeUndefined();
		expect(withPlugins.channel_registration?.fields.mode).toBeUndefined();
		// conversation_binding stayed core (the `account` analog), keyed by endpoint
		expect(withPlugins.conversation_binding?.fields.endpointKey).toBeDefined();
		expect(
			withPlugins.conversation_binding?.fields.organizationId,
		).toBeUndefined();
	});

	it("gates channel_registration on the registrations flag (the opt-in table pattern)", () => {
		// OFF (app-bot mode) → channel_endpoint, never channel_registration
		const off = getBusyclawTables({ plugins: [channels([telegram()])] });
		expect(off.channel_endpoint).toBeDefined();
		expect(off.channel_registration).toBeUndefined();
		// ON (BYO mode) → channel_registration, never channel_endpoint
		const on = getBusyclawTables({
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
		expect(on.channel_registration).toBeDefined();
		expect(on.channel_endpoint).toBeUndefined();
	});

	it("does not put channel tables in core — only the plugins bring them", () => {
		const core = getBusyclawTables({});
		expect(core.channel_endpoint).toBeUndefined();
		expect(core.channel_registration).toBeUndefined();
		expect(core.conversation_binding).toBeDefined();
	});

	it("wires both modes into createClaw and exposes the registrations api", async () => {
		const db = memoryAdapter();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: {
				redactor: createStoredRedactor({
					detector: noopDetector,
					mappings: createPiiMappingStore(db),
				}),
			},
			plugins: [
				channels([appBot()]),
				channels([telegram()], { registrations: { enabled: true } }),
			],
		});
		// the registrations namespace is present (no getBusyclawTables collision at construction)
		expect(claw.api.channels.registrations).toBeDefined();

		// register a user's bot at runtime through the public api, read it back
		const created = await claw.api.channels.registrations.register(
			{
				provider: "telegram",
				endpointKey: "acme-bot",
				secret: "bot-token",
				webhookSecret: "hook",
			},
			{ principal: userPrincipal("operator") },
		);
		// Stamped from the authenticated caller and personal until registered into a boundary — the same
		// default a claw takes.
		expect(created).toMatchObject({
			status: "active",
			createdBy: "user:operator",
			scope: "personal",
			scopeId: "user:operator",
			hasSecret: true,
		});
		expect(created).not.toHaveProperty("secret");
		expect(created).not.toHaveProperty("webhookSecret");
		expect(
			await claw.api.channels.registrations.getByKey(
				{
					provider: "telegram",
					endpointKey: "acme-bot",
				},
				{ principal: userPrincipal("operator") },
			),
		).toMatchObject({ id: created.id });
	});

	// The whole point of the ownership columns, through the REAL PEP rather than a fake context: a second
	// authenticated principal is not a privileged one. Before the columns existed every one of these
	// passed, because a registration row belonged to nobody and the PEP had nothing to decide against.
	it("keeps one principal's registration out of another's reach", async () => {
		const db = memoryAdapter();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: {
				redactor: createStoredRedactor({
					detector: noopDetector,
					mappings: createPiiMappingStore(db),
				}),
			},
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
		const owner = { principal: userPrincipal("owner") };
		const stranger = { principal: userPrincipal("stranger") };
		const key = { provider: "telegram", endpointKey: "acme-bot" };

		const created = await claw.api.channels.registrations.register(
			{ ...key, secret: "bot-token", webhookSecret: "hook" },
			owner,
		);

		await expect(
			claw.api.channels.registrations.get({ id: created.id }, stranger),
		).rejects.toThrow(/denied/i);
		await expect(
			claw.api.channels.registrations.getByKey(key, stranger),
		).rejects.toThrow(/denied/i);
		await expect(
			claw.api.channels.registrations.revoke(key, stranger),
		).rejects.toThrow(/denied/i);
		// The hijack: re-register the (provider, endpointKey) with your own credentials and the owner's
		// traffic starts flowing to you. The natural key is guessable — the row is not reachable.
		await expect(
			claw.api.channels.registrations.register(
				{ ...key, secret: "stranger-token", webhookSecret: "stranger-hook" },
				stranger,
			),
		).rejects.toThrow(/denied/i);
		// A listing returns what the caller may read, which for a stranger is nothing — not an error,
		// and not a probe that would confirm the row exists.
		await expect(
			claw.api.channels.registrations.list({}, stranger),
		).resolves.toEqual([]);

		// The owner still reaches their own, and it still holds the original credentials.
		await expect(
			claw.api.channels.registrations.getByKey(key, owner),
		).resolves.toMatchObject({ id: created.id, hasSecret: true });
	});

	// The reason a listing calls `ctx.authz.filter` once instead of `ctx.authz.enforce` in a loop. Cedar
	// has no bulk authorize, so the per-ROW evaluation is unavoidable — but the two READS around it are
	// not. `resolvePrincipalScopes` is a HOST callback (the same answer fetched N times, plausibly over
	// the network) and the grant lookup is a query against a table whose rows differ only in the id.
	// Both are hoisted, and this is the only place either property is observable.
	it("resolves scopes and reads grants once for a listing, not once per row", async () => {
		const db = memoryAdapter();
		let resolves = 0;
		let grantReads = 0;
		const counting = {
			...db,
			findMany: async (input: { model: string }) => {
				if (input.model === "access_grant") grantReads += 1;
				return db.findMany(input as Parameters<typeof db.findMany>[0]);
			},
		} as typeof db;
		const claw = createClaw({
			database: counting,
			model: textModel("done"),
			redaction: {
				redactor: createStoredRedactor({
					detector: noopDetector,
					mappings: createPiiMappingStore(db),
				}),
			},
			resolvePrincipalScopes: () => {
				resolves += 1;
				return [];
			},
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
		const owner = { principal: userPrincipal("owner") };
		for (const endpointKey of ["bot-a", "bot-b", "bot-c"]) {
			await claw.api.channels.registrations.register(
				{
					provider: "telegram",
					endpointKey,
					webhookSecret: `hook-${endpointKey}`,
				},
				owner,
			);
		}

		resolves = 0;
		grantReads = 0;
		const rows = await claw.api.channels.registrations.list({}, owner);
		expect(rows).toHaveLength(3);
		// One resolve for the listing's own caller-mode decision, one for the whole batch of rows. Per
		// row it would be 1 + 3, and it would grow with the page.
		expect(resolves).toBe(2);
		// And exactly ONE grant query covers all three rows. Per row it would be 3.
		expect(grantReads).toBe(1);
	});

	// An org-scoped BYO bot needs a deployment that can PROVE org membership. Until an org plugin
	// resolves it, an explicit boundary is denied rather than taken on the caller's word — which is the
	// fail-closed direction: the alternative is registering a bot into a tenant you do not belong to.
	it("denies a boundary the deployment cannot prove membership of", async () => {
		const db = memoryAdapter();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: {
				redactor: createStoredRedactor({
					detector: noopDetector,
					mappings: createPiiMappingStore(db),
				}),
			},
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
		await expect(
			claw.api.channels.registrations.register(
				{
					provider: "telegram",
					endpointKey: "acme-bot",
					webhookSecret: "hook",
					scope: "organization",
					scopeId: "org-acme",
				},
				{ principal: userPrincipal("operator") },
			),
		).rejects.toThrow(/denied/i);
	});

	it("keeps an app bot and a same-named registration in disjoint binding spaces", async () => {
		// The adversarial shape the registrations/ namespace exists for: same provider, same human name,
		// same external chat id — arriving through BOTH ingresses of one real assembled claw.
		const apiCalls: string[] = [];
		const fakeFetch = async (url: string) => {
			apiCalls.push(url);
			return { ok: true, json: async () => ({ ok: true, result: {} }) };
		};
		const db = memoryAdapter();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: {
				redactor: createStoredRedactor({
					detector: noopDetector,
					mappings: createPiiMappingStore(db),
				}),
			},
			// the named app bot resolves its token via its own tokenRef → "app-token"
			plugins: [
				secrets([env({ vars: { SALES_BOT: "app-token" } })]),
				channels([
					telegram({ fetch: fakeFetch, name: "sales", tokenRef: "SALES_BOT" }),
				]),
				channels([telegram({ fetch: fakeFetch })], {
					registrations: { enabled: true },
				}),
			],
		});
		await claw.api.channels.registrations.register(
			{
				provider: "telegram",
				endpointKey: "sales",
				secret: "row-token",
				webhookSecret: "hook",
			},
			{ principal: "user:operator" },
		);

		const plugins = claw.$context.plugins ?? [];
		const namedRoute = plugins
			.flatMap((plugin) => plugin.routes ?? [])
			.find((route) => route.path === "/channels/:provider/webhook/:name");
		const registrationRoute = plugins
			.flatMap((plugin) => plugin.routes ?? [])
			.find((route) =>
				route.path.startsWith("/channels/:provider/registrations/"),
			);
		if (!namedRoute || !registrationRoute)
			throw new Error("expected both webhook routes");

		const update = JSON.stringify({
			update_id: 1,
			message: { message_id: 2, text: "hi", chat: { id: 777 } },
		});
		const request = (secret: string) => ({
			method: "POST",
			url: "https://host/webhook",
			headers: {
				get: (name: string) =>
					name === "x-telegram-bot-api-secret-token" ? secret : null,
			},
			json: async () => JSON.parse(update) as unknown,
			text: async () => update,
		});

		const viaApp = await namedRoute.handler({
			claw,
			params: { name: "sales", provider: "telegram" },
			request: request(telegramWebhookSecret("app-token")),
		});
		const viaRegistration = await registrationRoute.handler({
			claw,
			// no key in the path — the row is resolved from the secret_token telegram echoes ("hook")
			params: { provider: "telegram" },
			request: request("hook"),
		});
		expect(viaApp.status).toBe(200);
		expect(viaRegistration.status).toBe(200);

		// two bindings, two claws — the same chat id never merged across the two ingresses
		const bindings = claw.$context.clawsStore?.conversationBindings;
		if (!bindings) throw new Error("expected the bindings store");
		const appBinding = await bindings.getByExternal({
			provider: "telegram",
			endpointKey: "sales",
			externalConversationId: "777",
		});
		const registrationBinding = await bindings.getByExternal({
			provider: "telegram",
			endpointKey: "registrations/sales",
			externalConversationId: "777",
		});
		expect(appBinding).toBeTruthy();
		expect(registrationBinding).toBeTruthy();
		expect(appBinding?.clawId).not.toBe(registrationBinding?.clawId);

		// and each ingress replied with ITS OWN credential — no token bleed either way
		expect(apiCalls.some((url) => url.includes("/botapp-token/"))).toBe(true);
		expect(apiCalls.some((url) => url.includes("/botrow-token/"))).toBe(true);
	});

	it("runtime-rejects duplicate unnamed bots (the compile-time fold's mirror)", () => {
		// widened to Channel[] so the literal-key fold can't see the duplicate — runtime must
		const dupes: Channel[] = [appBot(), telegram()];
		expect(() => channels(dupes)).toThrow(/duplicate channel/);
	});

	it("resolves an app bot's token through createClaw's one-door reader on first traffic", async () => {
		// no code token: it resolves from the reader the assembly threads into channels.configure —
		// `secrets.get("TELEGRAM_BOT_TOKEN")` — proving the one-door wire end to end (was the old
		// "resolves from TELEGRAM_BOT_TOKEN at startup", now that resolution is lazy, not at startup).
		const apiCalls: string[] = [];
		const fakeFetch = async (url: string) => {
			apiCalls.push(url);
			return { ok: true, json: async () => ({ ok: true, result: {} }) };
		};
		const db = memoryAdapter();
		const claw = createClaw({
			database: db,
			model: textModel("pong"),
			redaction: {
				redactor: createStoredRedactor({
					detector: noopDetector,
					mappings: createPiiMappingStore(db),
				}),
			},
			plugins: [
				secrets([env({ vars: { TELEGRAM_BOT_TOKEN: "env-token" } })]),
				channels([telegram({ fetch: fakeFetch })]),
			],
		});

		const update = JSON.stringify({
			update_id: 1,
			message: { message_id: 2, text: "hi", chat: { id: 42 } },
		});
		const route = (claw.$context.plugins ?? [])
			.flatMap((plugin) => plugin.routes ?? [])
			.find((r) => r.path === "/channels/:provider/webhook");
		if (!route) throw new Error("expected the bare webhook route");

		const res = await route.handler({
			claw,
			params: { provider: "telegram" },
			request: {
				method: "POST",
				url: "https://host/channels/telegram/webhook",
				headers: {
					get: (name: string) =>
						name === "x-telegram-bot-api-secret-token"
							? telegramWebhookSecret("env-token")
							: null,
				},
				json: async () => JSON.parse(update) as unknown,
				text: async () => update,
			},
		});
		// verified (the reader-resolved token derived the webhook secret) and replied on that same token
		expect(res.status).toBe(200);
		expect(apiCalls.some((url) => url.includes("/botenv-token/"))).toBe(true);
	});

	it("fails loud on first traffic — not at startup — when an app bot has no token anywhere", async () => {
		const db = memoryAdapter();
		// construction succeeds: the app-bot token now resolves lazily (async, through the one-door
		// reader available only at configure), so a missing token can no longer be caught at startup.
		const claw = createClaw({
			database: db,
			model: textModel("pong"),
			redaction: {
				redactor: createStoredRedactor({
					detector: noopDetector,
					mappings: createPiiMappingStore(db),
				}),
			},
			// A contributed `env` provider with empty vars suppresses the assembly's env floor, so
			// nothing resolves — deterministic regardless of the real process.env.
			plugins: [secrets([env({ vars: {} })]), channels([telegram()])],
		});
		const route = (claw.$context.plugins ?? [])
			.flatMap((plugin) => plugin.routes ?? [])
			.find((r) => r.path === "/channels/:provider/webhook");
		if (!route) throw new Error("expected the bare webhook route");

		const update = JSON.stringify({
			update_id: 1,
			message: { message_id: 2, text: "hi", chat: { id: 42 } },
		});
		// the same "telegram bot has no token" configurationError, relocated from startup to first traffic
		await expect(
			route.handler({
				claw,
				params: { provider: "telegram" },
				request: {
					method: "POST",
					url: "https://host/channels/telegram/webhook",
					headers: { get: () => "anything" },
					json: async () => JSON.parse(update) as unknown,
					text: async () => update,
				},
			}),
		).rejects.toThrow(/telegram bot has no token/);
	});

	it("keeps bare telegram() valid as a registrations transport — no startup token check", () => {
		vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
		try {
			// credentials live on the rows; the transport itself needs none
			expect(() =>
				channels([telegram()], { registrations: { enabled: true } }),
			).not.toThrow();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("rejects a plugin schema that redefines a core claw column at createClaw", () => {
		// sanity that the collision guard still fires for genuine core-column clashes
		expect(() =>
			createClaw({
				model: textModel("done"),
				plugins: [
					{
						id: "evil",
						schema: { claw: { fields: { status: field.string() } } },
					} as never,
				],
			}),
		).toThrow(/redefines core column/);
	});
});
