// `context.server` — the egress origin fact — reaches the always-on FLOOR.
//
// The mapper has always accepted a `serverForAction` provider and the Cedar schema has always
// declared `server?: String`, but the assembly never passed one: the only thing in the repo that
// built a provider was a test fixture. So a policy written about where a tool may reach compiled
// fine, matched nothing, and denied nothing — a governance fact that exists in the schema and never
// in a request is worse than an absent one, because it reads as enforcement.
//
// These drive a REAL registered tool through a real claw and discriminate on where the run ends:
// forbidden at the origin the tool actually declares → the floor refuses and the run completes with
// the model reading a denial; forbidden at some OTHER origin → the rule does not match, the call is
// permitted, and it travels on to the invoker, which fails loud on the unconfigured credential. The
// pair is the point — the first alone would also pass if `context.server` were stamped with the
// wrong value, or if the forbid matched everything.

import type { JsonObject } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { cedar } from "@busyclaw/policy-cedar";
import {
	createSpecRegistry,
	runtimeRunOptionsWithCaller,
} from "@busyclaw/runtime";
import { memoryAdapter } from "@busyclaw/storage-core";
import { createRegistryStores } from "@busyclaw/storage-durable";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import type { MockModel, V2Model } from "./fixtures";

/** A public IP LITERAL server: the egress floor validates it without DNS, so nothing here resolves
 *  a name or touches the network. This is the origin the registered tool DECLARES. */
const DECLARED_ORIGIN = "https://93.184.216.34";

const petstore = (): JsonObject => ({
	openapi: "3.1.0",
	info: { title: "petstore", version: "1.0.0" },
	servers: [{ url: `${DECLARED_ORIGIN}/v1` }],
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

/** Calls `path` once with `args`, then answers "done". */
function callToolModel(path: string, args: Record<string, unknown>): MockModel {
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
							toolName: path.replace(/\./g, "__"),
							input: JSON.stringify(args),
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
	} as unknown as MockModel;
}

/** Calls the registered petstore tool once, then answers "done". */
function getPetModel(): MockModel {
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
							// The WIRE name — the run loop translates it back to `petstore.getPet`.
							toolName: "petstore__getPet",
							input: JSON.stringify({ petId: "7" }),
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
	} as unknown as MockModel;
}

/** Register the petstore spec and build a claw whose only policy SOURCE forbids reaching `origin`. */
async function clawForbiddingOrigin(origin: string) {
	const stores = createRegistryStores(memoryAdapter());
	await createSpecRegistry(stores).registerOpenApiSpec({
		scope: "organization",
		scopeId: "org-a",
		source: "petstore",
		document: petstore(),
		registeredBy: "user:alice",
	});
	return createClaw({
		model: getPetModel(),
		stores: { registry: stores },
		configScope: (ctx) =>
			typeof ctx.org === "string"
				? { scope: "organization", scopeId: ctx.org }
				: undefined,
		plugins: [
			cedar({
				policies: `forbid(principal, action, resource) when { context.server == "${origin}" };`,
			}),
		],
	});
}

const run = (claw: Awaited<ReturnType<typeof clawForbiddingOrigin>>) =>
	claw.$context.runtime.generate(
		"get pet 7",
		{ org: "org-a" },
		runtimeRunOptionsWithCaller(undefined, userPrincipal("alice")),
	);

describe("context.server reaches the floor", () => {
	it("a forbid on the origin a registered tool DECLARES refuses the call", async () => {
		const claw = await clawForbiddingOrigin(DECLARED_ORIGIN);
		// Denied at the floor: the model reads a refusal and finishes. It never reached the invoker,
		// so the unconfigured credential never became an error — that is the discriminator below.
		await expect(run(claw)).resolves.toMatchObject({ status: "completed" });
	});

	it("a forbid on a DIFFERENT origin does not match — the same call is permitted", async () => {
		const claw = await clawForbiddingOrigin("https://not-the-petstore.example");
		// Permitted, so it travels on and fails loud at the credential. Reaching THIS error is the
		// proof the previous test's refusal came from the origin fact and not from the rule matching
		// everything: same claw, same call, one literal different.
		await expect(run(claw)).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
			details: { source: "petstore" },
		});
	});

	// The other half of the resolver. A registered tool arrives per RUN, but `RuntimeConfig.tools`
	// takes the same descriptor, and a `binding` invocation is as spellable there as a `local` one —
	// so a host's own bound tool declares an origin at ASSEMBLY, before any run exists. Reading only
	// the run's descriptors would leave it with no declared destination and its egress rules silently
	// unmatched, which is the same inert-fact failure in a different place.
	it("a STATIC bound tool declares its origin too", async () => {
		let ran = false;
		const claw = createClaw({
			model: getPetModel(),
			tools: {
				"petstore.getPet": {
					inputSchema: jsonSchema({
						type: "object",
						properties: { petId: { type: "string" } },
					}),
					governance: { access: "read" },
					invocation: {
						kind: "binding",
						provider: "openapi",
						binding: { server: `${DECLARED_ORIGIN}/v1` },
						execute: async () => {
							ran = true;
							return { id: 7 };
						},
					},
				},
			},
			plugins: [
				cedar({
					policies: `forbid(principal, action, resource) when { context.server == "${DECLARED_ORIGIN}" };`,
				}),
			],
		});
		await expect(
			claw.$context.runtime.generate(
				"get pet 7",
				{},
				runtimeRunOptionsWithCaller(undefined, userPrincipal("alice")),
			),
		).resolves.toMatchObject({ status: "completed" });
		// Refused at the floor — a read the floor would otherwise permit, stopped by where it reaches.
		expect(ran).toBe(false);
	});
});

// An ARGUMENT-addressed destination. A bound tool declares one server, so `context.server` is a
// property of which action it is; a tool whose purpose is to reach wherever the caller names has a
// different origin per call, and an action-keyed lookup returns one origin for every call or none.
// Both kinds produce the SAME fact, so ONE egress policy governs them together — a rule that covered
// bound tools and silently skipped these would read as "wherever this claw reaches" while covering
// only the destinations that happen to be static.
describe("context.server for an argument-addressed tool", () => {
	const fetchTool = (calls: string[]) => ({
		inputSchema: jsonSchema({
			type: "object",
			properties: { url: { type: "string" } },
		}),
		governance: {
			access: "read" as const,
			// The tool's AUTHOR names the argument. The value is the caller's; which field carries a
			// destination is not, or a caller could nominate another and have its contents believed.
			destination: { arg: "url" },
		},
		invocation: {
			kind: "local" as const,
			execute: async (args: { url: string }) => {
				calls.push(args.url);
				return { ok: true };
			},
		},
	});

	const clawFetching = (url: string, calls: string[]) =>
		createClaw({
			model: callToolModel("http.get", { url }),
			tools: { "http.get": fetchTool(calls) },
			plugins: [
				cedar({
					policies: `forbid(principal, action, resource) unless { context has server && context.server == "${DECLARED_ORIGIN}" };`,
				}),
			],
		});

	const go = (claw: ReturnType<typeof clawFetching>) =>
		claw.$context.runtime.generate(
			"fetch it",
			{},
			runtimeRunOptionsWithCaller(undefined, userPrincipal("alice")),
		);

	it("the permitted origin goes through", async () => {
		const calls: string[] = [];
		await expect(
			go(clawFetching(`${DECLARED_ORIGIN}/pets/7`, calls)),
		).resolves.toMatchObject({ status: "completed" });
		expect(calls).toEqual([`${DECLARED_ORIGIN}/pets/7`]);
	});

	it("a DIFFERENT origin in the same argument is refused — per call, not per action", async () => {
		const calls: string[] = [];
		await expect(
			go(clawFetching("https://evil.example/collect", calls)),
		).resolves.toMatchObject({ status: "completed" });
		// Same tool, same action, one argument different: the tool never ran.
		expect(calls).toEqual([]);
	});

	it("an unreadable destination is refused, not waved through", async () => {
		const calls: string[] = [];
		// No origin can be derived, so no fact is stamped — and the guarded ceiling then REFUSES.
		// Failing to say where you are going is not permission to go.
		await expect(go(clawFetching("not-a-url", calls))).resolves.toMatchObject({
			status: "completed",
		});
		expect(calls).toEqual([]);
	});
});
