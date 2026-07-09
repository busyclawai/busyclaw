import { field } from "@euroclaw/contracts";
import { createStoredRedactor, noopDetector } from "@euroclaw/core";
import { env } from "@euroclaw/secrets";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";
import type { wrapLanguageModel } from "ai";
import { createClaw, getEuroclawTables } from "euroclaw";
import { describe, expect, it, vi } from "vitest";
import { type Channel, channels } from "../src/index";
import { telegram, telegramWebhookSecret } from "../src/telegram/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function textModel(text: string): V2Model {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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

describe("channels ↔ euroclaw integration", () => {
	it("collects each mode's own table via getEuroclawTables", () => {
		const withPlugins = getEuroclawTables({
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
		expect(
			withPlugins.channel_registration?.fields.organizationId,
		).toBeDefined();
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

	it("gates channel_registration on the registrations flag (mirrors dynamicSecretAliases)", () => {
		// OFF (app-bot mode) → channel_endpoint, never channel_registration
		const off = getEuroclawTables({ plugins: [channels([telegram()])] });
		expect(off.channel_endpoint).toBeDefined();
		expect(off.channel_registration).toBeUndefined();
		// ON (BYO mode) → channel_registration, never channel_endpoint
		const on = getEuroclawTables({
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
		expect(on.channel_registration).toBeDefined();
		expect(on.channel_endpoint).toBeUndefined();
	});

	it("does not put channel tables in core — only the plugins bring them", () => {
		const core = getEuroclawTables({});
		expect(core.channel_endpoint).toBeUndefined();
		expect(core.channel_registration).toBeUndefined();
		expect(core.conversation_binding).toBeDefined();
	});

	it("wires both modes into createClaw and exposes the registrations api", async () => {
		const db = memoryAdapter();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redactor: createStoredRedactor({
				detector: noopDetector,
				mappings: createPiiMappingStore(db),
			}),
			plugins: [
				channels([appBot()]),
				channels([telegram()], { registrations: { enabled: true } }),
			],
		});
		// the registrations namespace is present (no getEuroclawTables collision at construction)
		expect(claw.api.channels.registrations).toBeDefined();

		// register a user's bot at runtime through the public api, read it back
		const created = await claw.api.channels.registrations.register({
			provider: "telegram",
			endpointKey: "acme-bot",
			secret: "bot-token",
			webhookSecret: "hook",
			organizationId: "org-acme",
		});
		expect(created).toMatchObject({
			status: "active",
			organizationId: "org-acme",
		});
		expect(
			await claw.api.channels.registrations.getByKey({
				provider: "telegram",
				endpointKey: "acme-bot",
			}),
		).toMatchObject({ id: created.id });
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
			redactor: createStoredRedactor({
				detector: noopDetector,
				mappings: createPiiMappingStore(db),
			}),
			// the named app bot resolves its token via its own tokenRef → "app-token"
			secrets: [env({ source: { SALES_BOT: "app-token" } })],
			plugins: [
				channels([
					telegram({ fetch: fakeFetch, name: "sales", tokenRef: "SALES_BOT" }),
				]),
				channels([telegram({ fetch: fakeFetch })], {
					registrations: { enabled: true },
				}),
			],
		});
		await claw.api.channels.registrations.register({
			provider: "telegram",
			endpointKey: "sales",
			secret: "row-token",
			webhookSecret: "hook",
		});

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
			redactor: createStoredRedactor({
				detector: noopDetector,
				mappings: createPiiMappingStore(db),
			}),
			secrets: [env({ source: { TELEGRAM_BOT_TOKEN: "env-token" } })],
			plugins: [channels([telegram({ fetch: fakeFetch })])],
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
			redactor: createStoredRedactor({
				detector: noopDetector,
				mappings: createPiiMappingStore(db),
			}),
			secrets: [env({ source: {} })], // the reader resolves nothing
			plugins: [channels([telegram()])],
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
