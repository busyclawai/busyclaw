// The secrets assembly-wiring proof: `createClaw` builds the one-door `@euroclaw/secrets` reader
// (over the assembly's zero-config `[env()]` base plus any plugin-contributed providers) and flows it
// two ways — it backs registered-tool credential resolution (env-backed by default, keyed by the
// registration `source`), and it is injected into the plugin `configure` context. The POSTURE: with no
// provider configured the invoker reads env; a still-unresolved value fails loud.
//
// The registered-tool cases drive a full createClaw run so the env default reaches a LIVE tool call:
// a public-IP-literal server clears the egress floor without DNS, and the global `fetch` is stubbed
// so the credential the invoker placed is observable on the request. An unset credential must never
// send an unauthenticated request.

import type { EuroclawPlugin, JsonObject, Secrets } from "@euroclaw/contracts";
import { cedarPolicyPlugin } from "@euroclaw/policy-cedar";
import { createSpecRegistry, type RuntimeModel } from "@euroclaw/runtime";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createRegistryStores } from "@euroclaw/storage-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assembleOrgActions,
	createClaw,
	serverForActionFromRegisteredTools,
} from "../src/index";
import { textModel } from "./fixtures";

// A public IP LITERAL server: the egress floor validates it directly (no DNS) and allows it, so a
// full run reaches `fetch` deterministically without touching the network.
const PUBLIC_SERVER = "https://93.184.216.34/v1";

const petstore = (server = PUBLIC_SERVER): JsonObject => ({
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

/** A model that calls petstore.getPet once with the given petId, then stops. */
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
							toolName: "petstore.getPet",
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

const PERMIT = `permit(principal, action == Action::"petstore.getPet", resource);`;
const runCtx = { org: "org-a", principal: "alice" };

/** Register the petstore spec and build the cedar plugin over its rows. The registry stores are
 *  handed to createClaw via `stores` (not `database`) — resolveTools needs them, but the runtime
 *  itself stays database-free so the test needn't stand up approvals/durable redaction, which are
 *  orthogonal to the credential wiring under test. */
async function registeredPetstore() {
	const stores = createRegistryStores(memoryAdapter());
	const registry = createSpecRegistry(stores);
	await registry.registerOpenApiSpec({
		organizationId: "org-a",
		source: "petstore",
		document: petstore(),
		registeredBy: "user:alice",
	});
	const rows = await stores.registeredTools.listByOrganization("org-a");
	const { model } = assembleOrgActions({ registeredTools: rows });
	const policyPlugin = cedarPolicyPlugin({
		model,
		policies: PERMIT,
		serverForAction: serverForActionFromRegisteredTools(rows),
	});
	return { stores, policyPlugin };
}

// The header the invoker placed onto the (stubbed) outbound request.
function apiKeyHeaderOf(call: Call | undefined): string | undefined {
	return (call?.init.headers as Record<string, string> | undefined)?.[
		"X-API-Key"
	];
}

describe("secrets assembly wiring (createClaw)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("(a) with no provider configured: a registered tool's credential resolves through the env default", async () => {
		const { stores, policyPlugin } = await registeredPetstore();
		// The credential NAME is the registration source ("petstore"), read from the env global.
		vi.stubEnv("petstore", "env-secret-key");
		const { fn, calls } = fakeFetch(
			() =>
				new Response(JSON.stringify({ id: 7, name: "Rex" }), {
					headers: { "content-type": "application/json" },
				}),
		);
		// Stub BEFORE createClaw — the invoker's provider captures the global fetch at build time.
		vi.stubGlobal("fetch", fn);

		const claw = createClaw({
			model: getPetModel("7"),
			stores: { registry: stores },
			organization: (ctx) =>
				typeof ctx.org === "string" ? ctx.org : undefined,
			plugins: [policyPlugin],
			// no secrets() base plugin ⇒ the assembly's [env()] default backs the credential.
		});

		const result = await claw.$context.runtime.generate("get pet 7", runCtx);
		expect(result.status).toBe("completed");
		expect(calls).toHaveLength(1);
		expect(apiKeyHeaderOf(calls[0])).toBe("env-secret-key");
	});

	it("(b) an unset credential still fails loud: no unauthenticated request is sent", async () => {
		const { stores, policyPlugin } = await registeredPetstore();
		// "petstore" is deliberately NOT in the env → the reader returns null material.
		const { fn, calls } = fakeFetch(() => new Response("{}"));
		vi.stubGlobal("fetch", fn);

		const claw = createClaw({
			model: getPetModel("7"),
			stores: { registry: stores },
			organization: (ctx) =>
				typeof ctx.org === "string" ? ctx.org : undefined,
			plugins: [policyPlugin],
		});

		// The invoker refuses loud (configurationError) BEFORE egress/fetch — an actionable
		// configure-your-credential error, never a silent unauthenticated request.
		await expect(
			claw.$context.runtime.generate("get pet 7", runCtx),
		).rejects.toMatchObject({
			code: "EUROCLAW_CONFIGURATION_ERROR",
			details: { source: "petstore" },
		});
		expect(calls).toHaveLength(0);
	});

	it("(c) the one-door reader is injected into the plugin configure context", async () => {
		let received: Secrets | undefined;
		const probe: EuroclawPlugin = {
			id: "secrets-probe",
			configure: (context) => {
				received = context.secrets;
				return undefined;
			},
		};
		vi.stubEnv("some-credential", "value-in-env");

		// No database needed — the reader is built regardless of storage.
		createClaw({ model: textModel("done"), plugins: [probe] });

		expect(received).toBeDefined();
		expect(typeof received?.get).toBe("function");
		// It is the REAL env-backed reader, not a placeholder.
		expect(await received?.get("some-credential")).toEqual({
			kind: "token",
			value: "value-in-env",
		});
	});
});
