import type {
	EuroclawPlugin,
	EuroclawPluginConfigureContext,
} from "@euroclaw/contracts";
import { endpoints } from "@euroclaw/contracts";
import { secrets, storedSecretModels } from "@euroclaw/secrets-plugin";
import { entityAdapter, memoryAdapter } from "@euroclaw/storage-core";
import { type } from "arktype";
import { type Claw, createClaw } from "euroclaw";
import { describe, expect, it } from "vitest";
import { createClawClient, toRequestHandler } from "../src/index";

describe("@euroclaw/adapter-core", () => {
	it("dispatches claw api calls through derived routes", async () => {
		const claw = {
			api: {
				createClaw: async (input: unknown) => input,
				getClaw: async (input: unknown) => input,
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);
		const post = await handler(
			new Request("https://app.test/api/euroclaw/create-claw", {
				body: JSON.stringify({
					id: "claw-1",
					createdBy: "user-1",
				}),
				method: "POST",
			}),
		);

		expect(post.status).toBe(200);
		await expect(post.json()).resolves.toMatchObject({
			data: { id: "claw-1", createdBy: "user-1" },
			ok: true,
		});
		const get = await handler(
			new Request("https://app.test/api/euroclaw/get-claw?id=claw-1", {
				method: "GET",
			}),
		);

		expect(get.status).toBe(200);
		await expect(get.json()).resolves.toMatchObject({
			data: { id: "claw-1" },
			ok: true,
		});
		await expect(
			handler(
				new Request("https://app.test/api/euroclaw/work", { method: "POST" }),
			).then((response) => response.status),
		).resolves.toBe(404);
	});

	it("supports plugin routes and rejects conflicts", async () => {
		const plugin: EuroclawPlugin = {
			id: "telegram",
			routes: [
				{
					method: "POST",
					path: "/telegram/webhook",
					handler: async () => ({ body: { ok: true, route: "telegram" } }),
				},
			],
		};
		const claw = { api: {} } as unknown as Claw;
		const handler = toRequestHandler(claw, { plugins: [plugin] });

		const response = await handler(
			new Request("https://app.test/api/euroclaw/telegram/webhook", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			route: "telegram",
		});
		expect(() =>
			toRequestHandler(claw, {
				plugins: [
					plugin,
					{
						id: "other",
						routes: plugin.routes,
					},
				],
			}),
		).toThrow(/route conflict/);
	});

	it("matches a parameterized route and binds path params to ctx.params", async () => {
		const plugin: EuroclawPlugin = {
			id: "channels",
			routes: [
				{
					method: "POST",
					path: "/channels/:provider/:endpointKey/webhook",
					handler: async ({ params }) => ({ body: { ok: true, params } }),
				},
			],
		};
		const claw = { api: {} } as unknown as Claw;
		const handler = toRequestHandler(claw, { plugins: [plugin] });

		const response = await handler(
			new Request(
				"https://app.test/api/euroclaw/channels/telegram/main/webhook",
				{ method: "POST" },
			),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			params: { provider: "telegram", endpointKey: "main" },
		});
	});

	it("prefers a static route over an overlapping pattern", async () => {
		const plugin: EuroclawPlugin = {
			id: "channels",
			routes: [
				{
					method: "POST",
					path: "/channels/:provider/webhook",
					handler: async () => ({ body: { ok: true, matched: "pattern" } }),
				},
				{
					method: "POST",
					path: "/channels/telegram/webhook",
					handler: async () => ({ body: { ok: true, matched: "static" } }),
				},
			],
		};
		const claw = { api: {} } as unknown as Claw;
		const handler = toRequestHandler(claw, { plugins: [plugin] });

		const response = await handler(
			new Request("https://app.test/api/euroclaw/channels/telegram/webhook", {
				method: "POST",
			}),
		);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			matched: "static",
		});
	});

	it("rejects two patterns with the same shape as a conflict", () => {
		const claw = { api: {} } as unknown as Claw;
		expect(() =>
			toRequestHandler(claw, {
				plugins: [
					{
						id: "a",
						routes: [
							{
								method: "POST",
								path: "/channels/:a/webhook",
								handler: async () => ({ body: { ok: true } }),
							},
						],
					},
					{
						id: "b",
						routes: [
							{
								method: "POST",
								path: "/channels/:b/webhook",
								handler: async () => ({ body: { ok: true } }),
							},
						],
					},
				],
			}),
		).toThrow(/route conflict/);
	});

	it("url-decodes param values and does not over-match on segment count", async () => {
		const plugin: EuroclawPlugin = {
			id: "channels",
			routes: [
				{
					method: "POST",
					path: "/channels/:provider/webhook",
					handler: async ({ params }) => ({ body: { ok: true, params } }),
				},
			],
		};
		const claw = { api: {} } as unknown as Claw;
		const handler = toRequestHandler(claw, { plugins: [plugin] });

		const decoded = await handler(
			new Request("https://app.test/api/euroclaw/channels/main%20bot/webhook", {
				method: "POST",
			}),
		);
		await expect(decoded.json()).resolves.toEqual({
			ok: true,
			params: { provider: "main bot" },
		});

		// one segment too many must NOT bind to the two-segment pattern
		const overlong = await handler(
			new Request(
				"https://app.test/api/euroclaw/channels/telegram/webhook/extra",
				{ method: "POST" },
			),
		);
		expect(overlong.status).toBe(404);
	});

	it("runs plugin cron tasks through the built-in cron route", async () => {
		const seen: Array<{ id: string; limit?: number }> = [];
		const plugin: EuroclawPlugin = {
			id: "channel:telegram",
			cron: [
				{
					id: "channel:telegram:poll",
					handler: ({ limit }) => {
						seen.push({ id: "channel:telegram:poll", limit });
						return {
							data: { provider: "telegram" },
							processed: 2,
							status: "processed",
						};
					},
				},
			],
		};
		const claw = {
			api: {},
			$context: {
				cronHandler: { limit: 7, secret: "secret" },
				plugins: [plugin],
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);

		const unauthorized = await handler(
			new Request("https://app.test/api/euroclaw/cron", { method: "POST" }),
		);
		const authorized = await handler(
			new Request("https://app.test/api/euroclaw/cron", {
				headers: { "x-euroclaw-cron-secret": "secret" },
				method: "POST",
			}),
		);

		expect(unauthorized.status).toBe(401);
		expect(authorized.status).toBe(200);
		await expect(authorized.json()).resolves.toEqual({
			data: {
				tasks: [
					{
						data: { provider: "telegram" },
						id: "channel:telegram:poll",
						processed: 2,
						status: "processed",
					},
				],
			},
			ok: true,
		});
		expect(seen).toEqual([{ id: "channel:telegram:poll", limit: 7 }]);
	});

	it("validates derived route input before dispatch", async () => {
		const claw = {
			api: {
				createClaw: async () => {
					throw new Error("should not dispatch invalid input");
				},
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);

		const response = await handler(
			new Request("https://app.test/api/euroclaw/create-claw", {
				// id must be a string — type-invalid input is rejected before the api is touched
				body: JSON.stringify({ id: 42 }),
				method: "POST",
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: {
				message: expect.stringContaining("claw.api.createClaw input"),
			},
			ok: false,
		});
	});

	it("creates a typed client for manifest-derived routes", async () => {
		let fetches = 0;
		const claw = {
			api: {
				getClaw: async (input: unknown) => input,
				listMessages: async (input: unknown) => [input],
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);
		const client = createClawClient({
			baseUrl: "https://app.test/api/euroclaw",
			fetch: (input, init) => {
				fetches++;
				return handler(new Request(input, init));
			},
		});

		await expect(client.getClaw({ id: "claw-1" })).resolves.toEqual({
			id: "claw-1",
		});
		await expect(
			client.listMessages({ afterSequence: 2, limit: 5, threadId: "thread-1" }),
		).resolves.toEqual([{ afterSequence: 2, limit: 5, threadId: "thread-1" }]);
		expect(fetches).toBe(2);
	});

	it("client validates input before fetch", async () => {
		const client = createClawClient({
			fetch: () => {
				throw new Error("should not fetch invalid input");
			},
		});

		await expect(client.createClaw({ id: 42 } as never)).rejects.toThrow(
			/claw\.api\.createClaw input/,
		);
	});

	it("emits a uniform { error: { message } } envelope for auth failures", async () => {
		const claw = {
			api: {},
			$context: { cronHandler: { secret: "secret" } },
		} as unknown as Claw;
		const handler = toRequestHandler(claw);

		const unauthorized = await handler(
			new Request("https://app.test/api/euroclaw/cron", { method: "POST" }),
		);

		expect(unauthorized.status).toBe(401);
		// Previously this path emitted `error: "unauthorized"` (a bare string), which the client's
		// `error.message` read silently dropped. The envelope is now uniform across all errors.
		await expect(unauthorized.json()).resolves.toEqual({
			error: { message: "unauthorized" },
			ok: false,
		});
	});

	it("surfaces the server error message to the client via the parsed envelope", async () => {
		const claw = {
			api: {
				getClaw: async () => {
					throw new Error("boom from server");
				},
			},
		} as unknown as Claw;
		const handler = toRequestHandler(claw);
		const client = createClawClient({
			baseUrl: "https://app.test/api/euroclaw",
			fetch: (input, init) => handler(new Request(input, init)),
		});

		await expect(client.getClaw({ id: "claw-1" })).rejects.toThrow(
			/boom from server/,
		);
	});
});

// 32 bytes hex — the shape the secrets() store master key demands.
const SECRET_STORE_TEST_KEY = "0123456789abcdef".repeat(4);

/** The secrets() plugin api over an in-memory table — the createClaw wiring at the unit seam. */
function secretsApiOverMemory() {
	const plugin = secrets([], { store: { key: SECRET_STORE_TEST_KEY } });
	const adapter = entityAdapter(memoryAdapter(), storedSecretModels);
	const runtime = plugin.configure?.({
		adapter,
	} as EuroclawPluginConfigureContext);
	const api = runtime?.api?.(undefined);
	if (!api) throw new Error("expected the secrets plugin to contribute an api");
	return api;
}

function encodedInputUrl(path: string, input: unknown): string {
	return `https://app.test/api/euroclaw${path}?input=${encodeURIComponent(
		JSON.stringify(input),
	)}`;
}

describe("plugin endpoint routes (declared endpoints() namespaces)", () => {
	it("routes a migrated plugin api over HTTP while the in-process call stays direct", async () => {
		const api = secretsApiOverMemory();
		const handler = toRequestHandler({ api } as unknown as Claw);

		// The in-process path is untouched: the namespace method is the handler itself.
		await expect(
			api.secrets.set({ name: "SEEDED", value: "v0", actor: "alice" }),
		).resolves.toMatchObject({ name: "SEEDED", kind: "value" });

		const set = await handler(
			new Request("https://app.test/api/euroclaw/secrets/set", {
				body: JSON.stringify({
					name: "NOTION",
					value: "tok-1",
					actor: "alice",
				}),
				method: "POST",
			}),
		);
		expect(set.status).toBe(200);
		const setBody = (await set.json()) as {
			ok: boolean;
			data: Record<string, unknown>;
		};
		expect(setBody.ok).toBe(true);
		expect(setBody.data).toMatchObject({
			name: "NOTION",
			kind: "value",
			createdBy: "user:alice",
		});
		// Values are write-only: the routed surface returns the metadata VIEW, never the material.
		expect(setBody.data.value).toBeUndefined();

		// list is a GET by the name rule; input rides the ?input= JSON convention.
		const list = await handler(
			new Request(encodedInputUrl("/secrets/list", { actor: "alice" }), {
				method: "GET",
			}),
		);
		expect(list.status).toBe(200);
		await expect(list.json()).resolves.toMatchObject({
			data: [{ name: "SEEDED" }, { name: "NOTION" }],
			ok: true,
		});

		const remove = await handler(
			new Request("https://app.test/api/euroclaw/secrets/delete", {
				body: JSON.stringify({ name: "NOTION", actor: "alice" }),
				method: "POST",
			}),
		);
		expect(remove.status).toBe(200);
		const afterDelete = await handler(
			new Request(encodedInputUrl("/secrets/list", { actor: "alice" }), {
				method: "GET",
			}),
		);
		await expect(afterDelete.json()).resolves.toMatchObject({
			data: [{ name: "SEEDED" }],
			ok: true,
		});
	});

	it("validates endpoint input at the HTTP boundary before the handler runs", async () => {
		const api = secretsApiOverMemory();
		const handler = toRequestHandler({ api } as unknown as Claw);

		const response = await handler(
			new Request("https://app.test/api/euroclaw/secrets/set", {
				// actor must be non-empty — rejected by the declared schema, not the store.
				body: JSON.stringify({ name: "K", value: "v", actor: "" }),
				method: "POST",
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: expect.stringContaining("claw.api.secrets.set input") },
			ok: false,
		});
	});

	it("mounts a namespace nested in a plain object wrapper at its full kebab key path", async () => {
		const registrations = endpoints({
			getByKey: {
				input: type({ key: "string" }),
				handler: async ({ key }: { key: string }) => ({ key }),
			},
		});
		const claw = {
			api: { channels: { registrations } },
		} as unknown as Claw;
		const handler = toRequestHandler(claw);

		// Bare query params (the non-input GET fallback) reach the schema as strings.
		const response = await handler(
			new Request(
				"https://app.test/api/euroclaw/channels/registrations/get-by-key?key=main",
				{ method: "GET" },
			),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: { key: "main" },
			ok: true,
		});
	});

	it("does not mount plain object namespaces (no metadata, no routes)", async () => {
		const claw = { api: { skills: { marker: "a" } } } as unknown as Claw;
		const handler = toRequestHandler(claw);

		const response = await handler(
			new Request("https://app.test/api/euroclaw/skills/marker", {
				method: "POST",
			}),
		);
		expect(response.status).toBe(404);
	});

	it("fails loud when a plugin route collides with a mounted endpoint", () => {
		const api = secretsApiOverMemory();
		const rogue: EuroclawPlugin = {
			id: "rogue",
			routes: [
				{
					method: "POST",
					path: "/secrets/set",
					handler: async () => ({ body: { ok: true } }),
				},
			],
		};

		expect(() =>
			toRequestHandler({ api } as unknown as Claw, { plugins: [rogue] }),
		).toThrow(/route conflict/);
	});

	it("routes a createClaw-assembled namespace end-to-end (merge preserves the metadata)", async () => {
		// The scripted-model shape the runtime accepts (fixtures.ts pattern); never invoked here.
		const model = {
			specificationVersion: "v4",
			provider: "mock",
			modelId: "mock",
			supportedUrls: {},
			doGenerate: async () => ({
				content: [{ type: "text", text: "done" }],
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
		const claw = createClaw({
			database: memoryAdapter(),
			model: model as never,
			redaction: { posture: "raw" },
			plugins: [secrets([], { store: { key: SECRET_STORE_TEST_KEY } })],
		});
		const handler = toRequestHandler(claw as unknown as Claw);

		const set = await handler(
			new Request("https://app.test/api/euroclaw/secrets/set", {
				body: JSON.stringify({ name: "E2E", value: "v", actor: "alice" }),
				method: "POST",
			}),
		);
		expect(set.status).toBe(200);
		await expect(set.json()).resolves.toMatchObject({
			data: { name: "E2E", kind: "value" },
			ok: true,
		});
		// The same assembled claw's in-process surface saw the HTTP write — one namespace, two doors.
		await expect(
			claw.api.secrets.list({ actor: "alice" }),
		).resolves.toMatchObject([{ name: "E2E" }]);
	});
});
