import type { Secrets } from "@euroclaw/contracts";
import { buildSecrets, env } from "@euroclaw/secrets";
import { memoryAdapter, schemaAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { type Channel, channels, channelsSchema } from "../src/index";
import { telegram, telegramWebhookSecret } from "../src/telegram/index";

// A fake claw that records binds and completes without reply text (so no Bot API egress happens).
function fakeClaw(binds: unknown[]) {
	return {
		api: {
			bindConversation: async (input: unknown) => {
				binds.push(input);
				return {
					binding: { id: "b" },
					claw: { id: "claw-1" },
					thread: { id: "thread-1" },
					created: true,
				};
			},
			sendMessage: async () => ({
				result: { status: "completed" },
				userMessage: { id: "m" },
			}),
		},
	};
}

/** Configure the plugin against a wrapped adapter and the one-door reader — what createClaw does. */
function configured(plugin: ReturnType<typeof channels>, secrets?: Secrets) {
	const built = plugin.configure?.({
		adapter: schemaAdapter(memoryAdapter(), channelsSchema),
		secrets,
	});
	if (!built) throw new Error("expected configure to build the plugin");
	return built;
}

function webhookRequest(input: { body: string; secret: string }) {
	return {
		method: "POST",
		url: "https://host/channels/telegram/webhook",
		headers: {
			get: (name: string) =>
				name === "x-telegram-bot-api-secret-token" ? input.secret : null,
		},
		json: async () => JSON.parse(input.body) as unknown,
		text: async () => input.body,
	};
}

const update = JSON.stringify({
	update_id: 1,
	message: { message_id: 2, text: "hi", chat: { id: 42 } },
});

describe("channels plugin — named bots (the genericOAuth model)", () => {
	it("routes the unnamed and each named bot to their own webhook paths", async () => {
		const binds: unknown[] = [];
		// each bot resolves its OWN token via the one-door reader: the unnamed bot under the base name,
		// the named bot under its tokenRef — so the two never collide on one secret.
		const plugin = configured(
			channels([
				telegram({}),
				telegram({ name: "sales", tokenRef: "TELEGRAM_BOT_TOKEN_SALES" }),
			]),
			buildSecrets([
				env({
					vars: {
						TELEGRAM_BOT_TOKEN: "support-token",
						TELEGRAM_BOT_TOKEN_SALES: "sales-token",
					},
				}),
			]),
		);
		const [bare, named] = plugin.routes ?? [];
		if (!bare || !named) throw new Error("expected both webhook routes");
		expect(bare.path).toBe("/channels/:provider/webhook");
		expect(named.path).toBe("/channels/:provider/webhook/:name");

		// the unnamed bot answers on the bare path, verified by ITS token-derived secret
		const supportOk = await bare.handler({
			claw: fakeClaw(binds),
			params: { provider: "telegram" },
			request: webhookRequest({
				body: update,
				secret: telegramWebhookSecret("support-token"),
			}),
		});
		expect(supportOk.status).toBe(200);
		expect(binds.at(-1)).toMatchObject({ endpointKey: "default" });

		// the named bot answers on its own segment, verified by its own secret
		const salesOk = await named.handler({
			claw: fakeClaw(binds),
			params: { name: "sales", provider: "telegram" },
			request: webhookRequest({
				body: update,
				secret: telegramWebhookSecret("sales-token"),
			}),
		});
		expect(salesOk.status).toBe(200);
		expect(binds.at(-1)).toMatchObject({ endpointKey: "sales" });

		// the sales secret does not open the support bot's door
		const crossed = await bare.handler({
			claw: fakeClaw(binds),
			params: { provider: "telegram" },
			request: webhookRequest({
				body: update,
				secret: telegramWebhookSecret("sales-token"),
			}),
		});
		expect(crossed.status).toBe(401);

		// an unknown name is not a channel
		const unknown = await named.handler({
			claw: fakeClaw(binds),
			params: { name: "ghost", provider: "telegram" },
			request: webhookRequest({ body: update, secret: "irrelevant" }),
		});
		expect(unknown.status).toBe(404);
	});

	it("runtime-rejects a non-segment bot name (the compile-time walk's mirror)", () => {
		// widened to Channel[] so the literal-name walk can't see it — runtime must
		const bad: Channel[] = [
			telegram({ name: "registrations/sneaky", tokenRef: "SNEAKY" }),
		];
		expect(() => channels(bad)).toThrow(/invalid channel name/);
	});

	it("mounts no named route when every bot is unnamed", () => {
		const plugin = channels([telegram({})]);
		expect(plugin.routes?.map((route) => route.path)).toEqual([
			"/channels/:provider/webhook",
		]);
	});
});
