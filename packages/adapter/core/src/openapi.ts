// Generated OpenAPI 3.1 for a claw's HTTP surface (docs/plans/claw-client-plan.md, slice 4).
// One generator covers the WHOLE routed api: the flat base methods (clawApiRouteList — the same
// table toRequestHandler mounts) and every endpoints() namespace mounted under claw.api (the same
// discovery the route table uses, so document and dispatch cannot disagree). Target is 3.1 because
// it embeds JSON Schema natively — arktype's toJsonSchema() output drops in without a 3.0 downcast.
// Webhook routes (plugin.routes) are provider-shaped ingress, not product api — not documented.

import type { EndpointInputSchema, EndpointRoute } from "@euroclaw/contracts";
import type { JsonSchema } from "arktype";
import type { Claw } from "euroclaw";
import { clawApiRouteList } from "euroclaw";
import { mountedEndpointNamespaces } from "./endpoints";

/** `info` for the emitted document. Defaults are honest: euroclaw is pre-alpha, version "0.0.0". */
export type ClawOpenApiOptions = {
	title?: string;
	version?: string;
	description?: string;
};

/** A schema slot in the document — exactly what this generator produces: arktype's `toJsonSchema()`
 *  output, the boolean `true` schema ("anything" — an unspecifiable input or an undeclared output),
 *  or the generator's own envelope literals (typed structurally because arktype's `JsonSchema`
 *  doesn't admit a boolean property schema like the envelope's unspecified `data: true`). */
export type ClawOpenApiSchema =
	| boolean
	| JsonSchema
	| {
			type: "object";
			properties: Record<string, ClawOpenApiSchema>;
			required?: string[];
	  };

export type ClawOpenApiOperation = {
	operationId: string;
	tags: [string];
	summary?: string;
	parameters?: [
		{
			name: "input";
			in: "query";
			description: string;
			content: { "application/json": { schema: ClawOpenApiSchema } };
		},
	];
	requestBody?: {
		content: { "application/json": { schema: ClawOpenApiSchema } };
	};
	responses: {
		"200": {
			description: string;
			content: { "application/json": { schema: ClawOpenApiSchema } };
		};
		default: { $ref: "#/components/responses/Error" };
	};
};

export type ClawOpenApiDocument = {
	openapi: "3.1.0";
	info: { title: string; version: string; description?: string };
	paths: Record<string, Partial<Record<"get" | "post", ClawOpenApiOperation>>>;
	components: {
		responses: {
			Error: {
				description: string;
				content: { "application/json": { schema: ClawOpenApiSchema } };
			};
		};
	};
};

/** The runtime duck-type for an arktype schema: route tables type validators as loose callables
 *  (`EndpointInputSchema`), so the generator asks the VALUE whether it can emit JSON Schema. */
type JsonSchemaSource = {
	toJsonSchema: (options: {
		dialect: null;
		fallback: (ctx: { base: JsonSchema }) => JsonSchema;
	}) => JsonSchema;
};

function isJsonSchemaSource(schema: unknown): schema is JsonSchemaSource {
	return (
		(typeof schema === "function" || typeof schema === "object") &&
		schema !== null &&
		typeof (schema as { toJsonSchema?: unknown }).toJsonSchema === "function"
	);
}

/** Emit a validator's JSON Schema, degraded but never throwing:
 *  - `dialect: null` — embedded in an OpenAPI 3.1 document, whose default dialect IS 2020-12, so a
 *    per-schema `$schema` key would be noise.
 *  - `fallback: (ctx) => ctx.base` — the universal fallback: every unjsonifiable fragment emits
 *    arktype's own closest JSON Schema approximation instead of throwing. Load-bearing well beyond
 *    exotic morphs: the house `"key?": "T | undefined"` optional style makes `undefined` a unit
 *    branch in ordinary input schemas (degrades to `anyOf: [T, {}]`), and narrowed types
 *    (predicates) degrade to their base domain.
 *  A validator that is not an arktype type documents as `true` (unspecified — accepts anything). */
function schemaJson(schema: EndpointInputSchema | unknown): ClawOpenApiSchema {
	if (!isJsonSchemaSource(schema)) return true;
	return schema.toJsonSchema({ dialect: null, fallback: (ctx) => ctx.base });
}

/** The 200 body: the success envelope with `data` = the declared output schema, or `true` when the
 *  operation declares none (base api methods carry no output schemas today). */
function successEnvelopeSchema(output: unknown): ClawOpenApiSchema {
	return {
		type: "object",
		properties: {
			ok: { const: true },
			// `data` may be absent on the wire (a void handler result serializes away), so it is
			// documented but not required.
			data: output === undefined ? true : schemaJson(output),
		},
		required: ["ok"],
	};
}

function buildOperation(input: {
	operationId: string;
	path: string;
	method: "GET" | "POST";
	input: EndpointInputSchema;
	summary?: string;
	output?: EndpointRoute["output"];
}): ClawOpenApiOperation {
	// Tags group by the first path segment: plugin namespaces cluster under their mount
	// (`secrets`, `skills`); flat base methods are single-segment, so each tags as itself.
	const firstSegment = input.path.split("/")[1] ?? "";
	const inputSchema = schemaJson(input.input);
	return {
		operationId: input.operationId,
		tags: [firstSegment],
		...(input.summary !== undefined ? { summary: input.summary } : {}),
		// GET reads carry their input as the ONE `?input=<json>` query parameter (the adapter's
		// convention) — documented content-style, i.e. a JSON-encoded string whose payload matches
		// the declared schema. POST writes carry the same shape as a plain JSON body.
		...(input.method === "GET"
			? {
					parameters: [
						{
							name: "input" as const,
							in: "query" as const,
							description:
								"The call input, JSON-encoded (the euroclaw `?input=<json>` convention).",
							content: { "application/json": { schema: inputSchema } },
						},
					],
				}
			: {
					requestBody: {
						content: { "application/json": { schema: inputSchema } },
					},
				}),
		responses: {
			"200": {
				description: "The euroclaw success envelope.",
				content: {
					"application/json": { schema: successEnvelopeSchema(input.output) },
				},
			},
			default: { $ref: "#/components/responses/Error" },
		},
	};
}

/**
 * Generate the OpenAPI 3.1 document for a claw's routed api surface. Paths are RELATIVE to the
 * adapter's basePath (exactly the paths toRequestHandler mounts under it). Input schemas — and
 * declared endpoint `output` schemas — emit via arktype's `toJsonSchema()`, so field-level
 * `.describe()` metadata flows into the document.
 */
export function clawOpenApi(
	claw: Claw,
	options: ClawOpenApiOptions = {},
): ClawOpenApiDocument {
	const paths: ClawOpenApiDocument["paths"] = {};
	const add = (
		path: string,
		method: "GET" | "POST",
		operation: ClawOpenApiOperation,
	): void => {
		const item = paths[path] ?? {};
		item[method === "GET" ? "get" : "post"] = operation;
		paths[path] = item;
	};
	for (const route of clawApiRouteList) {
		add(
			route.path,
			route.httpMethod,
			buildOperation({
				operationId: route.apiMethod,
				path: route.path,
				method: route.httpMethod,
				input: route.inputSchema,
			}),
		);
	}
	for (const namespace of mountedEndpointNamespaces(claw.api ?? {})) {
		for (const route of namespace.routes) {
			const path = `${namespace.prefix}${route.path}`;
			add(
				path,
				route.method,
				buildOperation({
					operationId: `${namespace.name}.${route.name}`,
					path,
					method: route.method,
					input: route.input,
					...(route.description !== undefined
						? { summary: route.description }
						: {}),
					...(route.output !== undefined ? { output: route.output } : {}),
				}),
			);
		}
	}
	return {
		openapi: "3.1.0",
		info: {
			title: options.title ?? "euroclaw api",
			version: options.version ?? "0.0.0",
			...(options.description !== undefined
				? { description: options.description }
				: {}),
		},
		paths,
		components: {
			responses: {
				// The ONE shared error shape: every 4xx/5xx failure carries the euroclaw error
				// envelope, so each operation references this response as its `default`.
				Error: {
					description:
						"The euroclaw error envelope — every 4xx/5xx failure carries it.",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									ok: { const: false },
									error: {
										type: "object",
										properties: {
											message: { type: "string" },
											code: { type: "string" },
										},
										required: ["message"],
									},
								},
								required: ["ok", "error"],
							},
						},
					},
				},
			},
		},
	};
}
