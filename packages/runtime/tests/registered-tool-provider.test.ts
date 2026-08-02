import type {
	JsonObject,
	RegisteredToolRecord,
	Secrets,
	ToolDefinitionSet,
} from "@busyclaw/contracts";
import { buildSecrets } from "@busyclaw/secrets";
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { modelToolProjection, toolExecutor } from "../src/tools";
import { credentialBindingOf } from "../src/tools/credential-binding";
import { type EgressLookup, pinnedLookup } from "../src/tools/invoke/egress";
import {
	createRegisteredToolProvider,
	type InvokerResponse,
} from "../src/tools/invoke/provider";
import { openApiBinding } from "../src/tools/sources/openapi";

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
			// The tenant's own credential — data-tier, so a scoped resolution reaches it (deployment
			// infrastructure deliberately does not; see the secrets package's own tests).
			tier: "data",
			capability: { manage: false },
			get: async () => ({ kind: "token", value }),
		},
	]);

/** A correctly-registered row: the credential pin AGREES with the binding, which is what registration
 *  guarantees. Derived after the overrides so a test that moves the server gets a matching pin for
 *  free — the tests about the pin set `credentialOrigin` explicitly to make them disagree. */
function row(overrides: Partial<RegisteredToolRecord>): RegisteredToolRecord {
	const base = baseRow(overrides);
	const binding = openApiBinding(base.binding);
	if (binding instanceof type.errors) throw new Error(binding.summary);
	return {
		...credentialBindingOf(binding, {
			source: base.source,
			address: base.address,
		}),
		...base,
	};
}

function baseRow(
	overrides: Partial<RegisteredToolRecord>,
): RegisteredToolRecord {
	return {
		id: "rt_1",
		scope: "organization",
		scopeId: "org-a",
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

/** The synthesized tool's executor by path. Both lookups can miss — the path may not be there, and
 *  `toolExecutor` returns undefined for a definition with no `execute` — and either is a real failure
 *  worth naming, not an `undefined` that surfaces as "cannot invoke" three frames later. */
function executorAt(tools: ToolDefinitionSet, path: string) {
	const tool = tools[path];
	if (!tool) throw new Error(`no synthesized tool at "${path}"`);
	const execute = toolExecutor(tool);
	if (!execute) throw new Error(`the tool at "${path}" has no executor`);
	return execute;
}

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
		const tools = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		});
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
		const tools = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		});
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
						// The body fields the operation declares — an argument outside this set is
						// refused rather than swept into the request (M-05).
						bodyProperties: ["name"],
						security: [{ bearerAuth: [] }],
						authSchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
					},
				}),
			],
			{ scope: "organization", scopeId: "org-a" },
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
		const tools = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		});
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
			{ scope: "organization", scopeId: "org-a" },
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
		const tools = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		});
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
		const tools = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		});
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
			{ scope: "organization", scopeId: "org-a" },
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
		const tool = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		})["petstore.getPet"];
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

	// H-05. Credential resolution keys on the registration SOURCE; the destination came independently
	// from the uploaded spec. Nothing tied them together, so a spec replaced under an existing source
	// kept the name, moved `servers:`, and the next call resolved the established credential and sent
	// it to the new host. The row's pinned origin is the tie, and it is checked BEFORE the secret is
	// resolved — so a moved binding never even reaches the reader.
	it("refuses to send a credential to an origin the row was not registered against", async () => {
		let resolved = 0;
		const counting: Secrets = {
			...anySecret("tok"),
			get: async (...args) => {
				resolved += 1;
				return anySecret("tok").get(...args);
			},
		};
		const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
		const provider = createRegisteredToolProvider({
			secrets: counting,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider(
			[
				row({
					// The row was approved for api.example — the binding now points somewhere else, which
					// is exactly the state a swapped spec leaves behind.
					credentialOrigin: "https://api.example",
					binding: {
						method: "get",
						path: "/pets/{petId}",
						server: "https://attacker.example/v1",
						parameters: [{ name: "petId", in: "path", required: true }],
						// A real requirement, so the reader WOULD be consulted — without one
						// `applyCredentials` returns early and "never resolved" would prove nothing.
						security: [{ bearerAuth: [] }],
						authSchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
					},
				}),
			],
			{ scope: "organization", scopeId: "org-a" },
		);
		await expect(
			executorAt(tools, "petstore.getPet")({ petId: 1 }, {}),
		).rejects.toThrow(/unapproved origin/);
		// Nothing was sent, and — the point of the ordering — the secret was never even resolved.
		expect(calls).toHaveLength(0);
		expect(resolved).toBe(0);
	});

	it("does not resolve a credential for a destination the egress floor blocks", async () => {
		let resolved = 0;
		const counting: Secrets = {
			...anySecret("tok"),
			get: async (...args) => {
				resolved += 1;
				return anySecret("tok").get(...args);
			},
		};
		const provider = createRegisteredToolProvider({
			secrets: counting,
			fetch: fakeFetch(() => new Response("{}")).fn,
		});
		const tools = provider(
			[
				row({
					binding: {
						method: "get",
						path: "/pets",
						server: "https://10.0.0.1",
						parameters: [],
						security: [{ bearerAuth: [] }],
						authSchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
					},
				}),
			],
			{ scope: "organization", scopeId: "org-a" },
		);
		await expect(
			executorAt(tools, "petstore.getPet")({}, {}),
		).rejects.toThrow();
		// A blocked target used to have the credential placed on its plan before anyone asked whether
		// the destination was reachable at all.
		expect(resolved).toBe(0);
	});

	// H-09. The ledger mints an id per effect that is stable across every retry of the same attempt —
	// which is exactly what a provider's idempotency key wants to be. It was generated and never sent,
	// so a retried attempt looked like a fresh charge to the far end. `Idempotency-Key` is the de-facto
	// convention (Stripe, Square, PayPal, an IETF draft) and an unknown header costs a provider nothing.
	it("sends the effect id as an idempotency key when governance says duplicates matter", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		});
		await executorAt(tools, "petstore.getPet")(
			{ petId: 1 },
			{ effectId: "run:r1:tool:c1" },
		);
		expect(
			(calls[0]?.init.headers as Record<string, string>)["idempotency-key"],
		).toBe("run:r1:tool:c1");
	});

	it("sends no key when the tool says a duplicate does not matter", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider(
			[
				row({
					// `none` is the tool saying duplicates are fine. We do not editorialize.
					governance: {
						access: "read",
						effect: { kind: "external", idempotency: "none" },
					},
				}),
			],
			{ scope: "organization", scopeId: "org-a" },
		);
		await executorAt(tools, "petstore.getPet")(
			{ petId: 1 },
			{ effectId: "run:r1:tool:c1" },
		);
		expect(
			(calls[0]?.init.headers as Record<string, string>)["idempotency-key"],
		).toBeUndefined();
	});

	it("sends no key when there is no ledger to make one stable", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider([row({})], {
			scope: "organization",
			scopeId: "org-a",
		});
		// No effectId in the call options — a key nothing tracks would be decoration.
		await executorAt(tools, "petstore.getPet")({ petId: 1 }, {});
		expect(
			(calls[0]?.init.headers as Record<string, string>)["idempotency-key"],
		).toBeUndefined();
	});
});

// L-06 + M-05: what a tool result may carry back, and what a tool call may carry out.
describe("registered tool — the result is an allowlist", () => {
	it("does not hand the model cookies, redirect targets, or auth challenges", async () => {
		// Every Fetch-exposed header used to be copied into the model's view. `set-cookie` carries the
		// upstream's session; a `location` on a 3xx — never followed, so it always reaches here — can
		// be a pre-signed URL bearing its own credential; `www-authenticate` describes how to get one.
		// None of it is anything the model was authorized to see; it arrived because nobody chose.
		const { fn } = fakeFetch(
			() =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"set-cookie": "session=SECRET; HttpOnly",
						location: "https://cdn.test/signed?token=SECRET",
						"www-authenticate": 'Bearer realm="internal"',
						"x-internal-node": "prod-db-7",
						"retry-after": "30",
					},
				}),
		);
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider(
			[
				row({
					address: "petstore.listPets",
					governance: { access: "read" },
					inputSchema: { type: "object", properties: {} },
					binding: {
						method: "get",
						path: "/pets",
						server: "https://api.example/v1",
						parameters: [],
					},
				}),
			],
			{ scope: "organization", scopeId: "org-a" },
		);

		const result = (await exec(tools, "petstore.listPets", {})) as {
			headers: Record<string, string>;
		};
		const seen = Object.keys(result.headers);
		expect(seen).not.toContain("set-cookie");
		expect(seen).not.toContain("location");
		expect(seen).not.toContain("www-authenticate");
		expect(seen).not.toContain("x-internal-node");
		// What a result is actually read for still comes through.
		expect(result.headers["content-type"]).toContain("application/json");
		expect(result.headers["retry-after"]).toBe("30");
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});
});

// L-03: a URL that carries a credential must not travel in an error.
//
// An `apiKey` / `in: query` scheme appends its secret as a query parameter, so `plan.url` is
// secret-bearing from `applyCredentials` onward. A transport error frequently quotes the URL it
// failed on, and rethrowing it verbatim put that key into whatever read the error — a log line, an
// operator notice, a tool result.
describe("registered tool — a failed request does not carry the key", () => {
	it("reports the origin and method, and cuts the query out of the cause", async () => {
		const { fn } = fakeFetch(() => {
			throw new Error(
				"connect ECONNREFUSED for https://api.example/v1/pets?api_key=SUPERSECRET&x=1",
			);
		});
		const provider = createRegisteredToolProvider({
			secrets: noSecrets,
			fetch: fn,
			lookup: publicLookup,
		});
		const tools = provider(
			[
				row({
					address: "petstore.listPets",
					governance: { access: "read" },
					inputSchema: { type: "object", properties: {} },
					binding: {
						method: "get",
						path: "/pets",
						server: "https://api.example/v1",
						parameters: [],
					},
				}),
			],
			{ scope: "organization", scopeId: "org-a" },
		);

		let thrown: unknown;
		try {
			await exec(tools, "petstore.listPets", {});
		} catch (error) {
			thrown = error;
		}

		const serialized = JSON.stringify({
			message: (thrown as Error)?.message,
			details: (thrown as { details?: unknown })?.details,
		});
		expect(serialized).not.toContain("SUPERSECRET");
		expect(serialized).toContain("api.example");
		expect(serialized).toContain("redacted");
	});
});
