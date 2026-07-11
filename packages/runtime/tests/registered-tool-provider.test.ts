import type {
	JsonObject,
	RegisteredToolRecord,
	Secrets,
} from "@euroclaw/contracts";
import { buildSecrets } from "@euroclaw/secrets";
import { describe, expect, it } from "vitest";
import { modelFacingTools } from "../src/tools";
import type { EgressLookup } from "../src/tools/invoke/egress";
import {
	createRegisteredToolProvider,
	type InvokerResponse,
} from "../src/tools/invoke/provider";

const publicLookup: EgressLookup = async () => [
	{ address: "93.184.216.34", family: 4 },
];

/** A reader resolving nothing, and one resolving any source name to a token — the invoker keys the
 *  credential by the registration SOURCE, so a per-name reader is a per-registration credential. */
const noSecrets = buildSecrets([]);
const anySecret = (value: string): Secrets =>
	buildSecrets([
		{
			name: "test",
			capability: { manage: false },
			get: async () => ({ kind: "token", value }),
		},
	]);

function row(overrides: Partial<RegisteredToolRecord>): RegisteredToolRecord {
	return {
		id: "rt_1",
		organizationId: "org-a",
		source: "petstore",
		name: "getPet",
		address: "petstore.getPet",
		description: "Get a pet",
		inputSchema: {
			type: "object",
			properties: { petId: { type: "integer" } },
		},
		governance: {
			access: "read",
			effect: { kind: "external", idempotency: "optional" },
		},
		binding: {
			method: "get",
			path: "/pets/{petId}",
			server: "https://api.example/v1",
			parameters: [{ name: "petId", in: "path", required: true }],
		},
		contentVersion: "v1",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as RegisteredToolRecord;
}

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response): {
	fn: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		fn: (async (url: string, init: RequestInit) => {
			calls.push({ url: String(url), init });
			return handler(String(url), init);
		}) as unknown as typeof fetch,
	};
}

const exec = (tools: Record<string, unknown>, name: string, args: JsonObject) =>
	(
		tools[name] as {
			execute: (a: unknown, o: unknown) => Promise<InvokerResponse>;
		}
	).execute(args, {});

describe("createRegisteredToolProvider", () => {
	it("a GET builds the right URL and returns the parsed body", async () => {
		const { fn, calls } = fakeFetch(
			() =>
				new Response(JSON.stringify({ id: 7, name: "Rex" }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider([row({})], { organizationId: "org-a" });
		const result = await exec(tools, "petstore.getPet", { petId: 7 });
		expect(calls[0]?.url).toBe("https://api.example/v1/pets/7");
		expect(calls[0]?.init.method).toBe("GET");
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ id: 7, name: "Rex" });
	});

	it("a POST applies a bearer token and sends the JSON body", async () => {
		const { fn, calls } = fakeFetch(
			() =>
				new Response("{}", {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createRegisteredToolProvider({
			secrets: anySecret("tok"),
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider(
			[
				row({
					name: "addPet",
					address: "petstore.addPet",
					governance: {
						access: "write",
						effect: { kind: "external", idempotency: "none" },
					},
					inputSchema: {
						type: "object",
						properties: { name: { type: "string" } },
					},
					binding: {
						method: "post",
						path: "/pets",
						server: "https://api.example/v1",
						parameters: [],
						security: [{ bearerAuth: [] }],
						authSchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
					},
				}),
			],
			{ organizationId: "org-a" },
		);
		const result = await exec(tools, "petstore.addPet", { name: "Rex" });
		expect(calls[0]?.init.method).toBe("POST");
		expect(
			(calls[0]?.init.headers as Record<string, string>).authorization,
		).toBe("Bearer tok");
		expect(calls[0]?.init.body).toBe(JSON.stringify({ name: "Rex" }));
		expect(result.status).toBe(201);
	});

	it("a non-2xx status is RETURNED, never thrown", async () => {
		const { fn } = fakeFetch(() => new Response("not found", { status: 404 }));
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider([row({})], { organizationId: "org-a" });
		const result = await exec(tools, "petstore.getPet", { petId: 7 });
		expect(result.status).toBe(404);
		expect(result.body).toBe("not found");
	});

	it("a blocked egress target throws (private IP literal, no DNS)", async () => {
		const { fn } = fakeFetch(() => new Response("{}"));
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
		});
		const tools = provider(
			[
				row({
					binding: {
						method: "get",
						path: "/x",
						server: "https://10.0.0.1",
						parameters: [],
					},
				}),
			],
			{ organizationId: "org-a" },
		);
		await expect(exec(tools, "petstore.getPet", {})).rejects.toThrow(
			/disallowed address/,
		);
	});

	it("a timeout aborts the request", async () => {
		// A fetch that only settles when its abort signal fires — the timeout must end it.
		const abortingFetch: typeof fetch = (async (
			_url: string,
			init: RequestInit,
		) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			})) as unknown as typeof fetch;
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: abortingFetch,
			lookup: publicLookup,
			timeoutMs: 10,
		});
		const tools = provider([row({})], { organizationId: "org-a" });
		await expect(exec(tools, "petstore.getPet", { petId: 7 })).rejects.toThrow(
			/timed out/,
		);
	});

	it("an oversized response is capped", async () => {
		const { fn } = fakeFetch(() => new Response("x".repeat(5000)));
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
			maxResponseBytes: 1000,
		});
		const tools = provider([row({})], { organizationId: "org-a" });
		await expect(exec(tools, "petstore.getPet", { petId: 7 })).rejects.toThrow(
			/size cap/,
		);
	});

	it("the model-facing view carries neither the binding nor credentials", async () => {
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fakeFetch(() => new Response("{}")).fn,
			lookup: publicLookup,
		});
		const tools = provider(
			[
				row({
					binding: {
						method: "get",
						path: "/pets/{petId}",
						server: "https://secret-internal.example/v1",
						parameters: [{ name: "petId", in: "path", required: true }],
						security: [{ bearerAuth: [] }],
						authSchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
					},
				}),
			],
			{ organizationId: "org-a" },
		);
		const view = modelFacingTools(tools)["petstore.getPet"] as Record<
			string,
			unknown
		>;
		expect(Object.keys(view).sort()).toEqual(["description", "inputSchema"]);
		expect(view).not.toHaveProperty("execute");
		expect(view).not.toHaveProperty("euroclaw");
		expect(view).not.toHaveProperty("binding");
		// The origin the model must never see is not reachable anywhere in the model-facing view.
		expect(JSON.stringify(view)).not.toContain("secret-internal.example");
	});
});
