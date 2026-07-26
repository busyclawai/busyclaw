// The composed slice-6a proof: a registered OpenAPI operation becomes an EXECUTABLE, governed tool.
// Registration (runtime) → registry rows (storage) → the registered-tool provider synthesizes an
// invoker-backed tool (runtime) → the runtime resolves it per org and dispatches it through the
// governance chokepoint (redact → gate → execute → audit) → the invoker builds the request, injects
// the host-configured credential, clears the egress floor, and calls fetch. The gate precedes
// execute; the model cannot redirect the origin; a missing credential fails loud; a private target
// is blocked by the floor.

import { cedarPolicyPlugin } from "@euroclaw/authz";
import type {
	JsonObject,
	Secrets,
	ToolDefinitionSet,
} from "@euroclaw/contracts";
import {
	createRegisteredToolProvider,
	createRuntime,
	createSpecRegistry,
	type EgressLookup,
	normalizeOrigin,
	type RuntimeModel,
	runtimeRunOptionsWithCaller,
	toolExecutor,
} from "@euroclaw/runtime";
import { buildSecrets } from "@euroclaw/secrets";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createRegistryStores } from "@euroclaw/storage-durable";
import { describe, expect, it } from "vitest";
import {
	assembleOrgActions,
	serverForActionFromRegisteredTools,
} from "../src/index";

/** Drive a synthesized tool the way the chokepoint does — through its invocation's executor. */
const invoke = (tools: ToolDefinitionSet, name: string, args: JsonObject) => {
	const tool = tools[name];
	const execute = tool && toolExecutor(tool);
	if (!execute) throw new Error(`no executable tool "${name}"`);
	return execute(args, {});
};

const petstore = (server = "https://petstore.example/v1"): JsonObject => ({
	openapi: "3.1.0",
	info: { title: "petstore", version: "1.0.0" },
	servers: [{ url: server }],
	paths: {
		"/pets/{petId}": {
			get: {
				operationId: "getPet",
				security: [{ apiKey: [] }],
				parameters: [
					{
						name: "petId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
			},
		},
	},
	components: {
		securitySchemes: {
			apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
		},
	},
});

/** A model that calls the getPet tool once with the given petId, then stops. */
function getPetModel(petId: string): RuntimeModel {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			const usage = {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			};
			if (step++ === 0) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							// The WIRE name — a registered tool is offered under the same flattened projection a
							// plugin tool is, and the run loop translates it back to `petstore.getPet`.
							toolName: "petstore__getPet",
							input: JSON.stringify({ petId }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop", raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

type Call = { url: string; init: RequestInit };
function fakeFetch(response: () => Response): {
	fn: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		fn: (async (url: string, init: RequestInit) => {
			calls.push({ url: String(url), init });
			return response();
		}) as unknown as typeof fetch,
	};
}

const publicLookup: EgressLookup = async () => [
	{ address: "93.184.216.34", family: 4 },
];

// The invoker keys each registration's credential by its SOURCE name, so a per-name reader is a
// per-registration credential. `anySecret` resolves any name; `noSecrets` resolves nothing.
const anySecret = (value: string): Secrets =>
	buildSecrets([
		{
			name: "test",
			capability: { manage: false },
			get: async () => ({ kind: "token", value }),
		},
	]);
const noSecrets = buildSecrets([]);

async function setup(options: {
	petId: string;
	policies: string;
	secrets: Secrets;
	fetch: typeof fetch;
	server?: string;
	lookup?: EgressLookup;
}) {
	const stores = createRegistryStores(memoryAdapter());
	const registry = createSpecRegistry(stores);
	await registry.registerOpenApiSpec({
		scope: "organization",
		scopeId: "org-a",
		source: "petstore",
		document: petstore(options.server),
		registeredBy: "user:alice",
	});
	const rows = await stores.registeredTools.listForScope({
		scope: "organization",
		scopeId: "org-a",
	});
	const { model } = assembleOrgActions({ registeredTools: rows });

	const provider = createRegisteredToolProvider({
		secrets: options.secrets,
		fetch: options.fetch,
		lookup: options.lookup ?? publicLookup,
	});

	const runtime = createRuntime({
		model: getPetModel(options.petId),
		plugins: [
			cedarPolicyPlugin({
				model,
				policies: options.policies,
				serverForAction: serverForActionFromRegisteredTools(rows),
			}),
		],
		configScope: (ctx) =>
			typeof ctx.org === "string"
				? { scope: "organization", scopeId: ctx.org }
				: undefined,
		resolveTools: async (ctx) =>
			ctx.euroclaw__configScopeId === "org-a"
				? provider(rows, { scope: "organization", scopeId: "org-a" })
				: {},
	});
	return { runtime, rows, provider, stores };
}

const PERMIT = `permit(principal, action == Action::"petstore.getPet", resource);`;
const runCtx = { org: "org-a" };
// The authenticated caller seeds the run's principal (`euroclaw__principal`) via the forge-proof
// runtime option — exactly how the api handler threads it. The mapper reads this stamp, never a ctx
// field (audit #7), so the principal lives here, not on `runCtx`.
const asAlice = runtimeRunOptionsWithCaller(undefined, "alice");

describe("invoker blueprint (composed slice 6a)", () => {
	it("registers apiKey petstore, dispatches getPet, and shapes the authed request", async () => {
		const { fn, calls } = fakeFetch(
			() =>
				new Response(JSON.stringify({ id: 7, name: "Rex" }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const { runtime } = await setup({
			petId: "7",
			policies: PERMIT,
			secrets: anySecret("secret-key"),
			fetch: fn,
		});
		const result = await runtime.generate("get pet 7", runCtx, asAlice);
		expect(result.status).toBe("completed");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://petstore.example/v1/pets/7");
		expect(calls[0]?.init.method).toBe("GET");
		expect(
			(calls[0]?.init.headers as Record<string, string>)["X-API-Key"],
		).toBe("secret-key");
	});

	it("a forbid on the action denies BEFORE any HTTP happens (gate precedes execute)", async () => {
		const fetchThatMustNotRun = (async () => {
			throw new Error("fetch must not be called when the gate denies");
		}) as unknown as typeof fetch;
		const { runtime } = await setup({
			petId: "7",
			// getPet is not permitted (deny-by-default); a different action is.
			policies: `permit(principal, action == Action::"other", resource);`,
			secrets: anySecret("secret-key"),
			fetch: fetchThatMustNotRun,
		});
		const result = await runtime.generate("get pet 7", runCtx, asAlice);
		// The run completes: the gate denied the tool, the model saw the denial, no HTTP occurred.
		expect(result.status).toBe("completed");
	});

	it("a missing credential fails the call with an actionable error", async () => {
		const { provider, rows } = await setup({
			petId: "7",
			policies: PERMIT,
			secrets: noSecrets, // nothing configured
			fetch: fakeFetch(() => new Response("{}")).fn,
		});
		// Drive the synthesized tool directly — the invoker must refuse rather than send unauthenticated.
		const tools = provider(rows, { scope: "organization", scopeId: "org-a" });
		await expect(
			invoke(tools, "petstore.getPet", { petId: "7" }),
		).rejects.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
			details: { source: "petstore" },
		});
	});

	it("the model cannot redirect the origin — a ../../ path value stays in the path", async () => {
		const { fn, calls } = fakeFetch(() => new Response("{}"));
		const { runtime } = await setup({
			petId: "../../evil.com/x",
			policies: PERMIT,
			secrets: anySecret("secret-key"),
			fetch: fn,
		});
		await runtime.generate("get a weird pet", runCtx, asAlice);
		expect(calls[0]?.url).toBe(
			"https://petstore.example/v1/pets/..%2F..%2Fevil.com%2Fx",
		);
		// The host is never redirected — the origin is exactly the registered server's origin.
		expect(new URL(calls[0]?.url ?? "").host).toBe("petstore.example");
	});

	it("a registered tool targeting a private IP is blocked by the egress floor", async () => {
		const { provider, rows } = await setup({
			petId: "7",
			policies: PERMIT,
			secrets: anySecret("secret-key"),
			fetch: fakeFetch(() => new Response("{}")).fn,
			server: "https://10.0.0.1/v1", // a private IP literal — the floor blocks it without DNS
		});
		expect(normalizeOrigin("https://10.0.0.1/v1")).toBe("https://10.0.0.1");
		const tools = provider(rows, { scope: "organization", scopeId: "org-a" });
		await expect(
			invoke(tools, "petstore.getPet", { petId: "7" }),
		).rejects.toThrow(/disallowed address/);
	});
});
