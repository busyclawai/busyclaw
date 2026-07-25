import type {
	JsonObject,
	RegisteredToolRecord,
	Secrets,
	ToolDefinitionSet,
} from "@euroclaw/contracts";
import { buildSecrets } from "@euroclaw/secrets";
import { describe, expect, it } from "vitest";
import { modelToolProjection, toolExecutor } from "../src/tools";
import { type EgressLookup, pinnedLookup } from "../src/tools/invoke/egress";
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

const exec = async (
	tools: ToolDefinitionSet,
	name: string,
	args: JsonObject,
): Promise<InvokerResponse> => {
	const tool = tools[name];
	const execute = tool && toolExecutor(tool);
	if (!execute) throw new Error(`no executable tool "${name}"`);
	return (await execute(args, {})) as InvokerResponse;
};

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

	// The floor resolves and vets an address, but `fetch` takes a URL: unless the socket is pinned to
	// that address it resolves the NAME again, and the second answer is not the one that was checked
	// (DNS rebinding — and the request carries the org credential). Regression for the decision being
	// computed and thrown away, which left the floor's verdict describing an address never dialled.
	it("pins the connection to the vetted address", async () => {
		const { fn, calls } = fakeFetch(
			() =>
				new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider([row({})], { organizationId: "org-a" });
		await exec(tools, "petstore.getPet", { petId: 7 });

		// The hostname is untouched, so TLS SNI / certificate validation still use the real name...
		expect(calls[0]?.url).toBe("https://api.example/v1/pets/7");
		// ...while the connection strategy carries the pin.
		expect(
			(calls[0]?.init as { dispatcher?: unknown } | undefined)?.dispatcher,
		).toBeDefined();
	});

	// The pinning rule itself, without a socket: whatever name is asked about, the answer is the one
	// address the floor already vetted.
	it("pinnedLookup answers the vetted address for any hostname", () => {
		const lookup = pinnedLookup({
			url: "https://api.example/v1",
			pinnedAddress: "93.184.216.34",
			family: 4,
		});

		let single: unknown[] = [];
		lookup("attacker-rebound.example", undefined, (...args) => {
			single = args;
		});
		expect(single).toEqual([null, "93.184.216.34", 4]);

		let all: unknown[] = [];
		lookup("attacker-rebound.example", { all: true }, (...args) => {
			all = args;
		});
		expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
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
		// A registered tool is addressed by its dotted PATH and offered under the SAME flattened
		// wire name a plugin tool gets — one naming scheme, so nothing reaches a provider with a
		// dot in it any more.
		const projection = modelToolProjection(tools);
		expect(Object.keys(projection.tools)).toEqual(["petstore__getPet"]);
		expect(
			projection.resolveCall({ name: "petstore__getPet", input: {} }).path,
		).toBe("petstore.getPet");
		const view = projection.tools["petstore__getPet"] as Record<
			string,
			unknown
		>;
		expect(Object.keys(view).sort()).toEqual(["description", "inputSchema"]);
		expect(view).not.toHaveProperty("execute");
		expect(view).not.toHaveProperty("invocation");
		expect(view).not.toHaveProperty("governance");
		// The origin the model must never see is not reachable anywhere in the model-facing view.
		expect(JSON.stringify(view)).not.toContain("secret-internal.example");
	});

	it("a row becomes a `binding` tool — the declarative binding rides in the descriptor", () => {
		const provider = createRegisteredToolProvider({ secrets: noSecrets });
		const tool = provider([row({})], { organizationId: "org-a" })[
			"petstore.getPet"
		];
		// The tag is the line SSOT cannot erase: this tool exists as DATA (a row), so it is storable
		// and its outbound target is describable — unlike a host closure, which is neither.
		expect(tool?.invocation.kind).toBe("binding");
		if (tool?.invocation.kind !== "binding")
			throw new Error("expected binding");
		expect(tool.invocation.provider).toBe("openapi");
		expect(tool.invocation.binding).toMatchObject({
			method: "get",
			server: "https://api.example/v1",
		});
		// Governance came off the row as a typed field — nothing re-validates it downstream.
		expect(tool.governance.access).toBe("read");
	});
});
