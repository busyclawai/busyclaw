// clawOpenApi — the generated OpenAPI 3.1 document over BOTH routed surfaces: the flat base api
// (clawApiRouteList) and every mounted endpoints() namespace, nested groups included. Schemas emit
// via arktype toJsonSchema() with the degrade-don't-throw fallback, so `.describe()` metadata and
// declared `output` schemas land in the document. The /openapi.json route is OPT-IN and serves the
// bare document (no envelope).

import type { EuroclawPluginConfigureContext } from "@euroclaw/contracts";
import { endpoints } from "@euroclaw/contracts";
import { secrets, storedSecretModels } from "@euroclaw/secrets-plugin";
import { entityAdapter, memoryAdapter } from "@euroclaw/storage-core";
import { type } from "arktype";
import type { Claw } from "euroclaw";
import { describe, expect, it } from "vitest";
import { clawOpenApi, toRequestHandler } from "../src/index";

// 32 bytes hex — the shape the secrets() store master key demands.
const SECRET_STORE_TEST_KEY = "0123456789abcdef".repeat(4);

/** The secrets() plugin api over an in-memory table — the migrated-plugin surface under test. */
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

const skillPackageView = type({ digest: "string", "version?": "string" });

/** A hand-built namespace with a NESTED group + declared output — the skills shape without the
 *  weight of a full createClaw assembly. */
function skillsNamespace() {
	return endpoints({
		packages: {
			create: {
				input: type({ name: "string" }),
				output: skillPackageView,
				description: "Create a skill package",
				handler: async (input: { name: string }) => ({
					digest: `sha256:${input.name}`,
				}),
			},
		},
	});
}

/** The euroclaw doc channel in the wild: rich prose DIVERGING from the error-facing describe()
 *  text on the input, a doc-only output, and a describe()-only read for the fallback arm. */
function docsNamespace() {
	return endpoints({
		create: {
			input: type({ name: "string" })
				.describe("a docs create request")
				.configure({ euroclaw: { doc: "Create a documented thing." } }),
			output: type({ id: "string" }).configure({
				euroclaw: { doc: "The created thing." },
			}),
			handler: async (input: { name: string }) => ({ id: input.name }),
		},
		get: {
			input: type({ id: "string" }).describe("a docs get request"),
			handler: async (input: { id: string }) => ({ id: input.id }),
		},
	});
}

function openApiClaw(): Claw {
	return {
		api: {
			...secretsApiOverMemory(),
			docs: docsNamespace(),
			skills: skillsNamespace(),
		},
	} as unknown as Claw;
}

/** Narrow a schema slot to its object-schema shape, asserting it is one. */
function objectSchema(schema: unknown): {
	properties: Record<string, unknown>;
	required?: string[];
	description?: string;
	euroclaw?: unknown;
} {
	expect(schema).toMatchObject({ type: "object" });
	return schema as {
		properties: Record<string, unknown>;
		required?: string[];
		description?: string;
		euroclaw?: unknown;
	};
}

describe("clawOpenApi — the generated document", () => {
	const document = clawOpenApi(openApiClaw());

	it("emits OpenAPI 3.1 with honest default info, overridable per option", () => {
		expect(document.openapi).toBe("3.1.0");
		expect(document.info).toEqual({ title: "euroclaw api", version: "0.0.0" });

		const titled = clawOpenApi(openApiClaw(), {
			title: "acme claw",
			version: "1.2.3",
			description: "the acme deployment",
		});
		expect(titled.info).toEqual({
			title: "acme claw",
			version: "1.2.3",
			description: "the acme deployment",
		});
	});

	it("documents both surfaces: base methods, plugin endpoints, and NESTED group paths", () => {
		// Flat base api — method names map through the one kebab/verb pair.
		expect(document.paths["/create-claw"]?.post?.operationId).toBe(
			"createClaw",
		);
		expect(document.paths["/get-claw"]?.get?.operationId).toBe("getClaw");
		expect(document.paths["/get-claw"]?.get?.tags).toEqual(["get-claw"]);
		// Migrated plugin endpoints mount under their namespace tag.
		expect(document.paths["/secrets/set"]?.post?.operationId).toBe(
			"secrets.set",
		);
		expect(document.paths["/secrets/set"]?.post?.tags).toEqual(["secrets"]);
		// A nested group flattens into the multi-segment path with the dotted operationId.
		const create = document.paths["/skills/packages/create"]?.post;
		expect(create?.operationId).toBe("skills.packages.create");
		expect(create?.tags).toEqual(["skills"]);
		expect(create?.summary).toBe("Create a skill package");
		// No declared description ⇒ no summary key at all.
		expect(document.paths["/secrets/set"]?.post?.summary).toBeUndefined();
	});

	it("documents GET input as the one ?input= JSON-encoded query parameter (content-style)", () => {
		// listApprovals is a GET with an all-optional input ({ status?, principal? }) — `principal` here is
		// the query FILTER, not the caller identity (identity now rides the resolveCaller seam, never the URL).
		const list = document.paths["/list-approvals"]?.get;
		expect(list?.requestBody).toBeUndefined();
		expect(list?.parameters).toHaveLength(1);
		const parameter = list?.parameters?.[0];
		expect(parameter).toMatchObject({ name: "input", in: "query" });
		expect(parameter?.description).toContain("?input=");
		const schema = objectSchema(parameter?.content["application/json"].schema);
		// An all-optional input: the `principal` filter documents as an OPTIONAL property, no `required`.
		expect(schema.properties.principal).toBeDefined();
		expect(schema.required).toBeUndefined();
	});

	it("documents POST input as the application/json requestBody", () => {
		const set = document.paths["/secrets/set"]?.post;
		expect(set?.parameters).toBeUndefined();
		const schema = objectSchema(
			set?.requestBody?.content["application/json"].schema,
		);
		// `name` + `value` are the only inputs — identity is NOT a body field (it rides the resolveCaller
		// seam), so `principal` never appears in the secrets.set request schema.
		expect(schema.required).toEqual(expect.arrayContaining(["name", "value"]));
		expect(schema.required).not.toContain("principal");
	});

	it("flows field-level .describe() metadata into the emitted schema", () => {
		const set = document.paths["/secrets/set"]?.post;
		const schema = objectSchema(
			set?.requestBody?.content["application/json"].schema,
		);
		// The narrow (predicate) degrades via the fallback; the description survives.
		expect(schema.properties.name).toMatchObject({
			type: "string",
			description: "a non-empty secret name",
		});
	});

	it("surfaces the euroclaw doc channel as the top-level schema description (docOf precedence)", () => {
		const create = document.paths["/docs/create"]?.post;
		const request = objectSchema(
			create?.requestBody?.content["application/json"].schema,
		);
		// The rich doc wins over the .describe() text at the top level of the emitted schema…
		expect(request.description).toBe("Create a documented thing.");
		// …and the raw namespaced key (arktype emits it as an opaque $ark.* registry reference) is
		// consumed into `description`, never leaked into the document.
		expect(request.euroclaw).toBeUndefined();
		// The declared output surfaces the same way as the envelope's `data` description.
		const envelope = objectSchema(
			create?.responses["200"].content["application/json"].schema,
		);
		const data = objectSchema(envelope.properties.data);
		expect(data.description).toBe("The created thing.");
		expect(data.euroclaw).toBeUndefined();
		// No euroclaw.doc ⇒ docOf falls back to the .describe() text (GET parameter arm included).
		const get = document.paths["/docs/get"]?.get;
		const parameter = objectSchema(
			get?.parameters?.[0]?.content["application/json"].schema,
		);
		expect(parameter.description).toBe("a docs get request");
		// No user-authored prose at all ⇒ no top-level description (today's emission, unchanged).
		const set = objectSchema(
			document.paths["/secrets/set"]?.post?.requestBody?.content[
				"application/json"
			].schema,
		);
		expect(set.description).toBeUndefined();
	});

	it("documents 200 as the success envelope: declared output as data, else data: true", () => {
		const create = document.paths["/skills/packages/create"]?.post;
		const envelope = objectSchema(
			create?.responses["200"].content["application/json"].schema,
		);
		expect(envelope.required).toEqual(["ok"]);
		expect(envelope.properties.ok).toEqual({ const: true });
		const data = objectSchema(envelope.properties.data);
		expect(data.required).toEqual(["digest"]);

		// A base api method declares no output schema — data documents as `true` (unspecified).
		const baseEnvelope = objectSchema(
			document.paths["/create-claw"]?.post?.responses["200"].content[
				"application/json"
			].schema,
		);
		expect(baseEnvelope.properties.data).toBe(true);
	});

	it("references the ONE shared error envelope component as every operation's default", () => {
		const error = document.components.responses.Error;
		const schema = objectSchema(error.content["application/json"].schema);
		expect(schema.required).toEqual(["ok", "error"]);
		expect(schema.properties.ok).toEqual({ const: false });
		expect(objectSchema(schema.properties.error).required).toEqual(["message"]);

		for (const operation of [
			document.paths["/create-claw"]?.post,
			document.paths["/secrets/list"]?.get,
			document.paths["/skills/packages/create"]?.post,
		]) {
			expect(operation?.responses.default).toEqual({
				$ref: "#/components/responses/Error",
			});
		}
	});
});

describe("GET /openapi.json — the opt-in route", () => {
	const specUrl = "https://app.test/api/euroclaw/openapi.json";

	it("is absent by default (no option, no route)", async () => {
		const handler = toRequestHandler(openApiClaw());
		const response = await handler(new Request(specUrl, { method: "GET" }));
		expect(response.status).toBe(404);
	});

	it("serves the bare document when enabled — plain JSON, NO envelope", async () => {
		const handler = toRequestHandler(openApiClaw(), { openApi: true });
		const response = await handler(new Request(specUrl, { method: "GET" }));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.openapi).toBe("3.1.0");
		// The spec document is the whole body — not wrapped in { ok, data }.
		expect(body.ok).toBeUndefined();
		expect(body.data).toBeUndefined();
		expect(
			(body.paths as Record<string, unknown>)["/secrets/set"],
		).toBeDefined();
	});

	it("honors info through the enabled form", async () => {
		const handler = toRequestHandler(openApiClaw(), {
			openApi: {
				enabled: true,
				info: { title: "acme claw", version: "9.9.9" },
			},
		});
		const response = await handler(new Request(specUrl, { method: "GET" }));
		const body = (await response.json()) as { info: unknown };
		expect(body.info).toEqual({ title: "acme claw", version: "9.9.9" });
	});

	it("is conflict-checked like every route", () => {
		expect(() =>
			toRequestHandler(openApiClaw(), {
				openApi: true,
				plugins: [
					{
						id: "rogue",
						routes: [
							{
								method: "GET",
								path: "/openapi.json",
								handler: async () => ({ body: { ok: true } }),
							},
						],
					},
				],
			}),
		).toThrow(/route conflict/);
	});
});
