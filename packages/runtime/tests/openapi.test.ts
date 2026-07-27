import type { JsonObject } from "@busyclaw/contracts";
import { toolGovernance } from "@busyclaw/contracts";
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { toolsFromOpenApi } from "../src/index";

/** Minimal valid 3.x document around the paths under test. */
function doc(paths: JsonObject, extra: JsonObject = {}): JsonObject {
	return {
		openapi: "3.1.0",
		info: { title: "fixture", version: "1" },
		paths,
		...extra,
	};
}

describe("toolsFromOpenApi — document gate", () => {
	it("refuses swagger 2.0 and non-3.x documents", () => {
		expect(() => toolsFromOpenApi({ swagger: "2.0", paths: {} })).toThrow(
			/not an OpenAPI document/,
		);
		expect(() => toolsFromOpenApi({ openapi: "2.0", paths: {} })).toThrow(
			/OpenAPI 3\.x/,
		);
	});

	it("refuses a document whose paths is not an object", () => {
		expect(() => toolsFromOpenApi({ openapi: "3.0.0", paths: [] })).toThrow(
			/paths/,
		);
	});
});

describe("toolsFromOpenApi — verb → access and verb groups (D2)", () => {
	const extraction = toolsFromOpenApi(
		doc({
			"/pets": {
				get: { operationId: "listPets" },
				post: { operationId: "addPet" },
			},
			"/pets/{petId}": {
				parameters: [
					{ name: "petId", in: "path", schema: { type: "integer" } },
				],
				put: { operationId: "replacePet" },
				patch: { operationId: "tweakPet" },
				delete: { operationId: "removePet" },
				head: { operationId: "peekPet" },
			},
		}),
	);
	const byName = new Map(extraction.tools.map((t) => [t.name, t]));

	it("GET/HEAD read, everything else write — fail-closed", () => {
		expect(byName.get("listPets")?.governance.access).toBe("read");
		expect(byName.get("peekPet")?.governance.access).toBe("read");
		expect(byName.get("addPet")?.governance.access).toBe("write");
		expect(byName.get("replacePet")?.governance.access).toBe("write");
		expect(byName.get("tweakPet")?.governance.access).toBe("write");
		expect(byName.get("removePet")?.governance.access).toBe("write");
	});

	it("POST creates, PUT/PATCH updates, DELETE deletes; reads carry no verb group", () => {
		expect(byName.get("addPet")?.governance.groups).toEqual(["creates"]);
		expect(byName.get("replacePet")?.governance.groups).toEqual(["updates"]);
		expect(byName.get("tweakPet")?.governance.groups).toEqual(["updates"]);
		expect(byName.get("removePet")?.governance.groups).toEqual(["deletes"]);
		expect(byName.get("listPets")?.governance.groups).toBeUndefined();
	});

	it("every stamp validates against the contracts toolGovernance schema", () => {
		for (const tool of extraction.tools) {
			expect(toolGovernance(tool.governance)).not.toBeInstanceOf(type.errors);
		}
	});
});

describe("toolsFromOpenApi — tags and deprecated", () => {
	it("tags become tag:-namespaced groups — a spec can never claim semantic groups", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/x": {
					post: {
						operationId: "op",
						tags: ["payments", "writes", 'pay"ments'],
					},
				},
			}),
		);
		expect(tools[0]?.governance.groups).toEqual([
			"creates",
			"tag:payments",
			"tag:writes", // NOT "writes" — namespaced, so it cannot grant write-group membership
			"tag:pay_ments", // quote sanitized — cannot inject into rendered Cedar text
		]);
	});

	it("deprecated operations stay extracted, flagged as a group and on the binding", () => {
		const { tools } = toolsFromOpenApi(
			doc({ "/x": { get: { operationId: "old", deprecated: true } } }),
		);
		expect(tools[0]?.governance.groups).toEqual(["deprecated"]);
		expect(tools[0]?.binding.deprecated).toBe(true);
	});
});

describe("toolsFromOpenApi — parameters", () => {
	it("merges path-level and operation-level parameters; operation wins; path params forced required", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/pets/{petId}": {
					parameters: [
						{ name: "petId", in: "path", schema: { type: "integer" } },
						{
							name: "verbose",
							in: "query",
							schema: { type: "boolean" },
							required: true,
						},
					],
					get: {
						operationId: "getPet",
						parameters: [
							{ name: "verbose", in: "query", schema: { type: "string" } },
						],
					},
				},
			}),
		);
		const tool = tools[0];
		expect(tool?.inputSchema.properties).toEqual({
			petId: { type: "integer" },
			verbose: { type: "string" }, // operation-level override
		});
		expect(tool?.inputSchema.required).toEqual(["petId"]); // path always; override dropped required
		expect(tool?.binding.parameters).toEqual([
			{ name: "petId", in: "path", required: true },
			{ name: "verbose", in: "query", required: false },
		]);
	});

	it("captures style/explode serialization hints verbatim", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/x": {
					get: {
						operationId: "op",
						parameters: [
							{
								name: "ids",
								in: "query",
								schema: { type: "array", items: { type: "string" } },
								style: "form",
								explode: false,
							},
						],
					},
				},
			}),
		);
		expect(tools[0]?.binding.parameters[0]).toEqual({
			name: "ids",
			in: "query",
			required: false,
			style: "form",
			explode: false,
		});
	});

	it("optional cookie params drop with a warning; required cookie params skip the operation", () => {
		const result = toolsFromOpenApi(
			doc({
				"/a": {
					get: {
						operationId: "softCookie",
						parameters: [
							{ name: "session", in: "cookie", schema: { type: "string" } },
						],
					},
				},
				"/b": {
					get: {
						operationId: "hardCookie",
						parameters: [
							{
								name: "session",
								in: "cookie",
								required: true,
								schema: { type: "string" },
							},
						],
					},
				},
			}),
		);
		expect(result.tools.map((t) => t.name)).toEqual(["softCookie"]);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({
				method: "get",
				path: "/a",
				reason: expect.stringContaining("cookie"),
			}),
		);
		expect(result.skipped).toContainEqual(
			expect.objectContaining({
				method: "get",
				path: "/b",
				reason: expect.stringContaining("cookie"),
			}),
		);
	});

	it("a required schemaless parameter skips the operation; an optional one drops with a warning", () => {
		const result = toolsFromOpenApi(
			doc({
				"/a": {
					get: {
						operationId: "soft",
						parameters: [{ name: "filter", in: "query" }],
					},
				},
				"/b": {
					get: {
						operationId: "hard",
						parameters: [{ name: "filter", in: "query", required: true }],
					},
				},
			}),
		);
		expect(result.tools.map((t) => t.name)).toEqual(["soft"]);
		expect(result.warnings.some((w) => w.reason.includes("no schema"))).toBe(
			true,
		);
		expect(result.skipped).toContainEqual(
			expect.objectContaining({
				method: "get",
				path: "/b",
				reason: expect.stringContaining("no schema"),
			}),
		);
	});
});

describe("toolsFromOpenApi — request bodies", () => {
	it("flattens an object JSON body into the input schema, propagating required only when the body is required", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/transfer": {
					post: {
						operationId: "transfer",
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: {
											amountCents: { type: "integer" },
											note: { type: "string" },
										},
										required: ["amountCents"],
									},
								},
							},
						},
					},
				},
			}),
		);
		const tool = tools[0];
		expect(tool?.inputSchema.properties).toEqual({
			amountCents: { type: "integer" },
			note: { type: "string" },
		});
		expect(tool?.inputSchema.required).toEqual(["amountCents"]);
		expect(tool?.binding.bodyContentType).toBe("application/json");
		expect(tool?.binding.bodyRequired).toBe(true);
		expect(tool?.binding.bodyWrapped).toBeUndefined();
	});

	it("an optional body does not force its own required list onto the input", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/x": {
					post: {
						operationId: "op",
						requestBody: {
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: { a: { type: "string" } },
										required: ["a"],
									},
								},
							},
						},
					},
				},
			}),
		);
		expect(tools[0]?.inputSchema.required).toBeUndefined();
	});

	it("a non-object body wraps under one `body` key and marks the binding", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/x": {
					post: {
						operationId: "op",
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: { type: "array", items: { type: "string" } },
								},
							},
						},
					},
				},
			}),
		);
		expect(tools[0]?.inputSchema.properties).toEqual({
			body: { type: "array", items: { type: "string" } },
		});
		expect(tools[0]?.inputSchema.required).toEqual(["body"]);
		expect(tools[0]?.binding.bodyWrapped).toBe(true);
	});

	it("a body property colliding with a parameter skips the operation", () => {
		const result = toolsFromOpenApi(
			doc({
				"/x/{id}": {
					post: {
						operationId: "op",
						parameters: [
							{ name: "id", in: "path", schema: { type: "string" } },
						],
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: { id: { type: "integer" } },
									},
								},
							},
						},
					},
				},
			}),
		);
		expect(result.tools).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("collides");
	});

	it("a required non-JSON body skips the operation; an optional one drops with a warning", () => {
		const result = toolsFromOpenApi(
			doc({
				"/upload": {
					post: {
						operationId: "hardUpload",
						requestBody: {
							required: true,
							content: {
								"multipart/form-data": { schema: { type: "object" } },
							},
						},
					},
				},
				"/log": {
					post: {
						operationId: "softLog",
						requestBody: {
							content: { "text/plain": { schema: { type: "string" } } },
						},
					},
				},
			}),
		);
		expect(result.tools.map((t) => t.name)).toEqual(["softLog"]);
		expect(result.skipped[0]?.reason).toContain("no JSON media type");
		expect(
			result.warnings.some((w) => w.reason.includes("no JSON media type")),
		).toBe(true);
	});

	it("prefers the first JSON media type in author order, including +json suffixes", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/x": {
					post: {
						operationId: "op",
						requestBody: {
							content: {
								"text/csv": { schema: { type: "string" } },
								"application/vnd.api+json": {
									schema: {
										type: "object",
										properties: { a: { type: "string" } },
									},
								},
								"application/json": {
									schema: {
										type: "object",
										properties: { b: { type: "string" } },
									},
								},
							},
						},
					},
				},
			}),
		);
		expect(tools[0]?.binding.bodyContentType).toBe("application/vnd.api+json");
		expect(tools[0]?.inputSchema.properties).toEqual({ a: { type: "string" } });
	});
});

describe("toolsFromOpenApi — $ref resolution", () => {
	it("inlines local $ref chains so the projection can see them (integer → Long interlock)", () => {
		const { tools } = toolsFromOpenApi(
			doc(
				{
					"/pets/{petId}": {
						get: {
							operationId: "getPet",
							parameters: [{ $ref: "#/components/parameters/PetId" }],
						},
					},
				},
				{
					components: {
						parameters: {
							PetId: {
								name: "petId",
								in: "path",
								schema: { $ref: "#/components/schemas/Id" },
							},
						},
						schemas: {
							Id: { $ref: "#/components/schemas/RawId" },
							RawId: { type: "integer" },
						},
					},
				},
			),
		);
		// Fully inlined — an undereferenced $ref would be invisible to the Cedar projection.
		expect(tools[0]?.inputSchema.properties).toEqual({
			petId: { type: "integer" },
		});
	});

	it("skips operations with circular $refs instead of hanging", () => {
		const result = toolsFromOpenApi(
			doc(
				{
					"/x": {
						post: {
							operationId: "op",
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: { $ref: "#/components/schemas/Node" },
									},
								},
							},
						},
					},
				},
				{
					components: {
						schemas: {
							Node: {
								type: "object",
								properties: { next: { $ref: "#/components/schemas/Node" } },
							},
						},
					},
				},
			),
		);
		expect(result.tools).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("circular");
	});

	it("refuses remote $refs (SSRF) and reports unresolvable local ones", () => {
		const result = toolsFromOpenApi(
			doc({
				"/a": {
					get: {
						operationId: "remote",
						parameters: [{ $ref: "https://evil.example/param.json" }],
					},
				},
				"/b": {
					get: {
						operationId: "missing",
						parameters: [
							{
								name: "q",
								in: "query",
								required: true,
								schema: { $ref: "#/components/schemas/Nope" },
							},
						],
					},
				},
			}),
		);
		expect(result.tools).toEqual([]);
		expect(result.skipped).toContainEqual(
			expect.objectContaining({
				method: "get",
				path: "/a",
				reason: expect.stringContaining("remote $ref"),
			}),
		);
		expect(result.skipped).toContainEqual(
			expect.objectContaining({
				method: "get",
				path: "/b",
				reason: expect.stringContaining("unresolvable"),
			}),
		);
	});
});

describe("toolsFromOpenApi — naming", () => {
	it("sanitizes operationIds and falls back to method_path slugs", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/pets/{petId}/toys": {
					get: {}, // no operationId
					post: { operationId: "toys.create v2" },
				},
			}),
		);
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_pets_petId_toys",
			"toys_create_v2",
		]);
	});

	it("reports name collisions and keeps the first operation", () => {
		const result = toolsFromOpenApi(
			doc({
				"/a": { get: { operationId: "op" } },
				"/b": { get: { operationId: "op" } },
			}),
		);
		expect(result.tools).toHaveLength(1);
		expect(result.tools[0]?.binding.path).toBe("/a");
		expect(result.skipped[0]?.reason).toContain("already taken");
	});
});

describe("toolsFromOpenApi — servers and security", () => {
	it("resolves the nearest server (operation > path item > document) and substitutes variable defaults", () => {
		const spec = doc(
			{
				"/a": { get: { operationId: "docLevel" } },
				"/b": {
					servers: [{ url: "https://path.example" }],
					get: { operationId: "pathLevel" },
				},
				"/c": {
					get: {
						operationId: "opLevel",
						servers: [
							{
								url: "https://{region}.example/{base}",
								variables: {
									region: { default: "eu" },
									base: { default: "v2" },
								},
							},
						],
					},
				},
			},
			{ servers: [{ url: "https://doc.example" }] },
		);
		const byName = new Map(
			toolsFromOpenApi(spec).tools.map((t) => [t.name, t.binding.server]),
		);
		expect(byName.get("docLevel")).toBe("https://doc.example");
		expect(byName.get("pathLevel")).toBe("https://path.example");
		expect(byName.get("opLevel")).toBe("https://eu.example/v2");
	});

	it("captures security requirements (operation overrides document; [] means public)", () => {
		const spec = doc(
			{
				"/default": { get: { operationId: "inherits" } },
				"/public": { get: { operationId: "open", security: [] } },
				"/scoped": {
					get: {
						operationId: "scoped",
						security: [{ oauth: ["pets:read"] }],
					},
				},
			},
			{ security: [{ apiKey: [] }] },
		);
		const byName = new Map(
			toolsFromOpenApi(spec).tools.map((t) => [t.name, t.binding.security]),
		);
		expect(byName.get("inherits")).toEqual([{ apiKey: [] }]);
		expect(byName.get("open")).toEqual([]);
		expect(byName.get("scoped")).toEqual([{ oauth: ["pets:read"] }]);
	});
});

describe("toolsFromOpenApi — auth-scheme definitions (slice 6a)", () => {
	const securitySchemes = {
		apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
		apiKeyQuery: { type: "apiKey", in: "query", name: "api_key" },
		bearerAuth: { type: "http", scheme: "bearer" },
		basicAuth: { type: "http", scheme: "Basic" }, // case-folded to "basic"
		oauth: { type: "oauth2", flows: {} },
	};

	it("denormalizes the referenced scheme definitions onto the binding", () => {
		const spec = doc(
			{
				"/a": {
					get: {
						operationId: "op",
						security: [{ apiKeyHeader: [] }, { bearerAuth: [] }],
					},
				},
			},
			{ components: { securitySchemes } },
		);
		const tool = toolsFromOpenApi(spec).tools[0];
		expect(tool?.binding.authSchemes).toEqual({
			apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
			bearerAuth: { type: "http", scheme: "bearer" },
		});
	});

	it("captures apiKey-in-query, basic (case-folded), and oauth2 (type only)", () => {
		const spec = doc(
			{
				"/a": {
					get: {
						operationId: "op",
						security: [{ apiKeyQuery: [] }, { basicAuth: [] }, { oauth: [] }],
					},
				},
			},
			{ components: { securitySchemes } },
		);
		const tool = toolsFromOpenApi(spec).tools[0];
		expect(tool?.binding.authSchemes).toEqual({
			apiKeyQuery: { type: "apiKey", in: "query", name: "api_key" },
			basicAuth: { type: "http", scheme: "basic" },
			oauth: { type: "oauth2" },
		});
	});

	it("resolves a local $ref on a scheme definition (shared inliner)", () => {
		const spec = doc(
			{
				"/a": {
					get: { operationId: "op", security: [{ keyRef: [] }] },
				},
			},
			{
				components: {
					securitySchemes: {
						keyRef: { $ref: "#/components/x-schemes/real" },
					},
					"x-schemes": {
						real: { type: "apiKey", in: "header", name: "X-Key" },
					},
				},
			},
		);
		const tool = toolsFromOpenApi(spec).tools[0];
		expect(tool?.binding.authSchemes).toEqual({
			keyRef: { type: "apiKey", in: "header", name: "X-Key" },
		});
	});

	it("warns (does not throw) on an unsupported scheme type; the operation still extracts", () => {
		const spec = doc(
			{
				"/a": { get: { operationId: "op", security: [{ weird: [] }] } },
			},
			{
				components: {
					securitySchemes: { weird: { type: "mutualTLS" } },
				},
			},
		);
		const extraction = toolsFromOpenApi(spec);
		expect(extraction.tools).toHaveLength(1); // governed-but-uninvokable is coherent
		expect(extraction.tools[0]?.binding.authSchemes).toBeUndefined();
		expect(
			extraction.warnings.some((w) => /unsupported type/.test(w.reason)),
		).toBe(true);
	});

	it("warns when a requirement references a scheme with no definition", () => {
		const spec = doc({
			"/a": { get: { operationId: "op", security: [{ ghost: [] }] } },
		});
		const extraction = toolsFromOpenApi(spec);
		expect(extraction.tools[0]?.binding.authSchemes).toBeUndefined();
		expect(
			extraction.warnings.some((w) => /no definition/.test(w.reason)),
		).toBe(true);
	});
});

describe("toolsFromOpenApi — effect idempotency per verb (slice 6a)", () => {
	const byName = new Map(
		toolsFromOpenApi(
			doc({
				"/pets": {
					get: { operationId: "listPets" },
					post: { operationId: "addPet" },
				},
				"/pets/{petId}": {
					parameters: [
						{ name: "petId", in: "path", schema: { type: "integer" } },
					],
					put: { operationId: "replacePet" },
					patch: { operationId: "tweakPet" },
					delete: { operationId: "removePet" },
					head: { operationId: "peekPet" },
				},
			}),
		).tools.map((t) => [t.name, t]),
	);

	it("stamps external effect; POST/PATCH non-idempotent (none), everything else idempotent (optional)", () => {
		// The invariant: a non-idempotent write's expired lease must never be reclaimed/re-run.
		expect(byName.get("addPet")?.governance.effect).toEqual({
			kind: "external",
			idempotency: "none",
		});
		expect(byName.get("tweakPet")?.governance.effect).toEqual({
			kind: "external",
			idempotency: "none",
		});
		for (const name of ["listPets", "replacePet", "removePet", "peekPet"]) {
			expect(byName.get(name)?.governance.effect).toEqual({
				kind: "external",
				idempotency: "optional",
			});
		}
	});
});

describe("toolsFromOpenApi — hostile documents", () => {
	it("a $ref bomb (exponential fan-out, no cycle) is bounded, skipped, and fast", () => {
		const schemas: JsonObject = { L0: { type: "string" } };
		for (let i = 1; i <= 30; i++) {
			schemas[`L${i}`] = {
				type: "object",
				properties: {
					a: { $ref: `#/components/schemas/L${i - 1}` },
					b: { $ref: `#/components/schemas/L${i - 1}` },
				},
			};
		}
		const result = toolsFromOpenApi(
			doc(
				{
					"/bomb": {
						post: {
							operationId: "bomb",
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: { $ref: "#/components/schemas/L30" },
									},
								},
							},
						},
					},
				},
				{ components: { schemas } },
			),
		);
		expect(result.tools).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("$ref bomb");
	});

	it("pathologically deep nesting is refused, not a stack overflow", () => {
		let nested: JsonObject = { type: "string" };
		for (let i = 0; i < 100; i += 1) {
			nested = { type: "object", properties: { n: nested } };
		}
		const result = toolsFromOpenApi(
			doc({
				"/deep": {
					post: {
						operationId: "deep",
						requestBody: {
							required: true,
							content: { "application/json": { schema: nested } },
						},
					},
				},
			}),
		);
		expect(result.tools).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("nests deeper");
	});

	it("a parameter named __proto__ becomes an own property — never a prototype mutation", () => {
		const { tools } = toolsFromOpenApi(
			doc({
				"/x": {
					get: {
						operationId: "op",
						parameters: [
							{ name: "__proto__", in: "query", schema: { type: "string" } },
						],
					},
				},
			}),
		);
		const properties = tools[0]?.inputSchema.properties as JsonObject;
		expect(Object.hasOwn(properties, "__proto__")).toBe(true);
		expect(Object.keys(properties)).toEqual(["__proto__"]);
		// the global prototype stays untouched
		expect(Object.hasOwn(Object.prototype, "type")).toBe(false);
	});

	it("a body property named constructor extracts — own-name semantics, no false collision", () => {
		const { tools, skipped } = toolsFromOpenApi(
			doc({
				"/x": {
					post: {
						operationId: "op",
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: { constructor: { type: "string" } },
									},
								},
							},
						},
					},
				},
			}),
		);
		expect(skipped).toEqual([]);
		const properties = tools[0]?.inputSchema.properties as JsonObject;
		expect(Object.hasOwn(properties, "constructor")).toBe(true);
	});

	it("a $ref pointer cannot walk the prototype chain into host objects", () => {
		const result = toolsFromOpenApi(
			doc({
				"/x": {
					get: {
						operationId: "op",
						parameters: [{ $ref: "#/__proto__/constructor" }],
					},
				},
			}),
		);
		// own-property pointer walk: #/__proto__/… is unresolvable, and since we cannot know
		// whether the unresolvable parameter was required, the operation skips — fail closed
		expect(result.tools).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("unresolvable");
	});

	it("a parameter named body blocks wrapping a non-object request body", () => {
		const result = toolsFromOpenApi(
			doc({
				"/x": {
					post: {
						operationId: "op",
						parameters: [
							{ name: "body", in: "query", schema: { type: "string" } },
						],
						requestBody: {
							required: true,
							content: {
								"application/json": { schema: { type: "string" } },
							},
						},
					},
				},
			}),
		);
		expect(result.tools).toEqual([]);
		expect(result.skipped[0]?.reason).toContain("cannot wrap");
	});
});
