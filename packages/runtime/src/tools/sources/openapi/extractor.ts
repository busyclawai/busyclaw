// OpenAPI 3.x → governance-stamped tool definitions. A tool SOURCE for the catalog/model
// pipeline ("host tools, MCP, OpenAPI, skills" — see ../../../catalog.ts): a pure transformation
// — no fetching, no storage. Extraction is faithful-but-refusing: local $refs are inlined
// (remote refs are an SSRF vector — refused), circular refs skip the operation, and every
// operation that does NOT become a tool is reported in `skipped` — never silently dropped.
//
// Facts stamped per operation (authz-blueprint D2):
//   GET/HEAD → access "read"; everything else → "write" (fail-closed);
//   POST → "creates", PUT/PATCH → "updates", DELETE → "deletes" (verb groups, method-derived —
//   a spec cannot place itself in them arbitrarily);
//   operation tags → "tag:<name>" groups — namespaced so an uploaded spec can never claim
//   membership in semantic groups like "reads"/"writes"; deprecated → "deprecated" group.
//
// Adapted from the extraction flow of Executor's openapi plugin (MIT) — see
// THIRD_PARTY_NOTICES.md; rewritten without Effect and reduced to euroclaw's scope.

import type {
	JsonObject,
	JsonValue,
	ToolGovernance,
} from "@euroclaw/contracts";
import { validationError } from "@euroclaw/contracts";
import { type } from "arktype";
import {
	HTTP_METHODS,
	type OpenApiAuthScheme,
	type OpenApiBinding,
	type OpenApiDiagnostic,
	type OpenApiExtraction,
	type OpenApiMethod,
	type OpenApiParameterBinding,
	type OpenApiTool,
	openApiDocument,
	openApiParameter,
	openApiRequestBody,
	openApiSecurityRequirement,
	openApiServer,
} from "./binding";

const READ_METHODS = new Set<OpenApiMethod>(["get", "head"]);
const VERB_GROUPS: Partial<Record<OpenApiMethod, string>> = {
	post: "creates",
	put: "updates",
	patch: "updates",
	delete: "deletes",
};
// Non-idempotent verbs: a timed-out effect must NOT be re-fired (a double POST creates two rows).
// This drives `effect.idempotency`, which the runtime effect store reads as `reclaimExpired:
// idempotency !== "none"` — "none" ⇒ an expired lease is left uncertain, never reclaimed/re-run.
const NON_IDEMPOTENT_METHODS = new Set<OpenApiMethod>(["post", "patch"]);

/** Extract every operation of an OpenAPI 3.x document into governance-stamped tool definitions. */
export function toolsFromOpenApi(document: JsonObject): OpenApiExtraction {
	const gate = openApiDocument(document);
	if (gate instanceof type.errors) {
		throw validationError("not an OpenAPI document", gate.summary);
	}
	if (!gate.openapi.startsWith("3")) {
		throw validationError(
			"toolsFromOpenApi supports OpenAPI 3.x documents",
			`openapi: ${JSON.stringify(gate.openapi)}`,
		);
	}
	const paths = asJsonObject(document.paths);
	if (!paths) {
		throw validationError(
			"OpenAPI paths must be an object of path items",
			`paths: ${Array.isArray(document.paths) ? "array" : typeof document.paths}`,
		);
	}

	const tools = new Map<string, OpenApiTool>();
	const skipped: OpenApiDiagnostic[] = [];
	const warnings: OpenApiDiagnostic[] = [];

	for (const [path, rawItem] of Object.entries(paths)) {
		let pathItem: JsonObject;
		try {
			const resolved = resolveNode(document, rawItem);
			if (!isJsonObject(resolved)) {
				skipped.push(diag("*", path, "path item is not an object"));
				continue;
			}
			pathItem = resolved;
		} catch (error) {
			skipped.push(diag("*", path, skipReason(error)));
			continue;
		}

		for (const method of HTTP_METHODS) {
			const rawOperation = pathItem[method];
			if (rawOperation === undefined) continue;
			if (!isJsonObject(rawOperation)) {
				skipped.push(diag(method, path, "operation is not an object"));
				continue;
			}
			try {
				const { tool, notes } = extractOperation(
					document,
					path,
					method,
					pathItem,
					rawOperation,
				);
				const existing = tools.get(tool.name);
				if (existing) {
					skipped.push(
						diag(
							method,
							path,
							`tool name "${tool.name}" already taken by ${existing.binding.method} ${existing.binding.path} — set a unique operationId`,
						),
					);
					continue;
				}
				tools.set(tool.name, tool);
				for (const note of notes) warnings.push(diag(method, path, note));
			} catch (error) {
				skipped.push(diag(method, path, skipReason(error)));
			}
		}
	}

	return { tools: [...tools.values()], skipped, warnings };
}

// ── per-operation extraction ─────────────────────────────────────────────────────────────────

function extractOperation(
	document: JsonObject,
	path: string,
	method: OpenApiMethod,
	pathItem: JsonObject,
	operation: JsonObject,
): { tool: OpenApiTool; notes: string[] } {
	const notes: string[] = [];
	// Property names come from the UNTRUSTED spec ("__proto__", "constructor", …): collect as
	// entries + a name Set (own-name semantics — `in`/direct assignment would walk or mutate the
	// prototype) and build the object with Object.fromEntries, which always creates own props.
	const propertyEntries: [string, JsonValue][] = [];
	const propertyNames = new Set<string>();
	const required: string[] = [];
	const parameters: OpenApiParameterBinding[] = [];

	for (const param of extractParameters(document, pathItem, operation, notes)) {
		propertyEntries.push([param.name, param.schema]);
		propertyNames.add(param.name);
		if (param.required) required.push(param.name);
		parameters.push(param.binding);
	}

	const body = extractBody(document, operation, notes);
	let bodyWrapped: boolean | undefined;
	if (body) {
		const bodyProps = isJsonObject(body.schema)
			? asJsonObject(body.schema.properties)
			: undefined;
		if (bodyProps) {
			const bodyRequired = new Set(
				body.required &&
					isJsonObject(body.schema) &&
					Array.isArray(body.schema.required)
					? body.schema.required.filter(
							(r): r is string => typeof r === "string",
						)
					: [],
			);
			for (const [name, propSchema] of Object.entries(bodyProps)) {
				if (propertyNames.has(name)) {
					throw new OperationSkip(
						`body property "${name}" collides with a parameter of the same name`,
					);
				}
				propertyEntries.push([name, propSchema]);
				propertyNames.add(name);
				if (bodyRequired.has(name)) required.push(name);
			}
		} else {
			// Non-object (or freeform) body — it cannot flatten; carry it under one `body` key.
			if (propertyNames.has("body")) {
				throw new OperationSkip(
					`cannot wrap the request body as "body" — a parameter of that name exists`,
				);
			}
			propertyEntries.push(["body", body.schema ?? {}]);
			propertyNames.add("body");
			if (body.required) required.push("body");
			bodyWrapped = true;
		}
	}

	const inputSchema: JsonObject = {
		type: "object",
		properties: Object.fromEntries(propertyEntries),
		...(required.length > 0 ? { required } : {}),
	};

	const summary = operation.summary;
	const description = operation.description;
	const security = extractSecurity(document, operation, notes);
	const authSchemes = extractAuthSchemes(document, security, notes);
	const server = serverUrl(document, pathItem, operation);
	const tool: OpenApiTool = {
		name: deriveToolName(operation, method, path),
		...(typeof summary === "string" && summary.trim() !== ""
			? { description: summary }
			: typeof description === "string" && description.trim() !== ""
				? { description }
				: {}),
		inputSchema,
		governance: deriveGovernance(method, operation, notes),
		binding: {
			method,
			path,
			...(server !== undefined ? { server } : {}),
			parameters,
			...(body
				? { bodyContentType: body.contentType, bodyRequired: body.required }
				: {}),
			...(bodyWrapped ? { bodyWrapped } : {}),
			...(security !== undefined ? { security } : {}),
			...(authSchemes !== undefined ? { authSchemes } : {}),
			...(operation.deprecated === true ? { deprecated: true } : {}),
		},
	};
	return { tool, notes };
}

type ExtractedParameter = {
	name: string;
	required: boolean;
	schema: JsonValue;
	binding: OpenApiParameterBinding;
};

function extractParameters(
	document: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
	notes: string[],
): ExtractedParameter[] {
	// Path-level parameters apply to every operation; operation-level ones override by (in, name).
	const merged = new Map<
		string,
		{ parsed: typeof openApiParameter.infer; raw: JsonObject }
	>();
	for (const list of [pathItem.parameters, operation.parameters]) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			const raw = resolveNode(document, item);
			if (!isJsonObject(raw)) {
				notes.push("malformed parameter dropped (not an object)");
				continue;
			}
			const parsed = openApiParameter(raw);
			if (parsed instanceof type.errors) {
				notes.push(`malformed parameter dropped (${parsed.summary})`);
				continue;
			}
			merged.set(`${parsed.in}:${parsed.name}`, { parsed, raw });
		}
	}

	const out: ExtractedParameter[] = [];
	for (const { parsed, raw } of merged.values()) {
		const isRequired = parsed.in === "path" ? true : parsed.required === true;
		if (parsed.in === "cookie") {
			if (isRequired) {
				throw new OperationSkip(
					`required parameter "${parsed.name}" has unsupported location "cookie"`,
				);
			}
			notes.push(
				`optional cookie parameter "${parsed.name}" dropped (unsupported location)`,
			);
			continue;
		}
		// Read the schema off the raw (JsonValue-typed) object — arktype types it `unknown`.
		const schema = raw.schema;
		if (schema === undefined) {
			// content-style parameters carry a media-typed schema — out of scope, fail closed.
			if (isRequired) {
				throw new OperationSkip(
					`required parameter "${parsed.name}" has no schema`,
				);
			}
			notes.push(`optional parameter "${parsed.name}" dropped (no schema)`);
			continue;
		}
		out.push({
			name: parsed.name,
			required: isRequired,
			schema: inlineRefs(document, schema, []),
			binding: {
				name: parsed.name,
				in: parsed.in,
				required: isRequired,
				...(parsed.style !== undefined ? { style: parsed.style } : {}),
				...(parsed.explode !== undefined ? { explode: parsed.explode } : {}),
			},
		});
	}
	return out;
}

type ExtractedBody = {
	contentType: string;
	required: boolean;
	schema: JsonValue | undefined;
};

function extractBody(
	document: JsonObject,
	operation: JsonObject,
	notes: string[],
): ExtractedBody | undefined {
	if (operation.requestBody === undefined) return undefined;
	const raw = resolveNode(document, operation.requestBody);
	if (!isJsonObject(raw)) return undefined;
	const parsed = openApiRequestBody(raw);
	if (parsed instanceof type.errors) {
		notes.push(`malformed request body dropped (${parsed.summary})`);
		return undefined;
	}
	const bodyRequired = parsed.required === true;

	const content = asJsonObject(raw.content);
	// First JSON media type in author order (the spec author's preference, like Executor).
	const contentType = Object.keys(content ?? {}).find((mediaType) => {
		const normalized = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
		return normalized === "application/json" || normalized.endsWith("+json");
	});
	if (content === undefined || contentType === undefined) {
		if (bodyRequired) {
			throw new OperationSkip(
				"required request body declares no JSON media type",
			);
		}
		notes.push("optional request body dropped (no JSON media type)");
		return undefined;
	}

	const media = asJsonObject(content[contentType]);
	const schema =
		media?.schema !== undefined
			? inlineRefs(document, media.schema, [])
			: undefined;
	return { contentType, required: bodyRequired, schema };
}

function deriveGovernance(
	method: OpenApiMethod,
	operation: JsonObject,
	notes: string[],
): ToolGovernance {
	const groups: string[] = [];
	const verbGroup = VERB_GROUPS[method];
	if (verbGroup) groups.push(verbGroup);
	if (operation.deprecated === true) groups.push("deprecated");
	if (Array.isArray(operation.tags)) {
		for (const tag of operation.tags) {
			if (typeof tag !== "string") continue;
			// Group ids must stay safe for Cedar rendering, and the tag: namespace keeps an
			// uploaded spec from claiming semantic groups (reads/writes/creates/…).
			const safe = tag
				.replace(/[^A-Za-z0-9_.-]+/g, "_")
				.replace(/^_+|_+$/g, "");
			if (safe === "") {
				notes.push(
					`tag ${JSON.stringify(tag)} dropped (empty after sanitizing)`,
				);
				continue;
			}
			groups.push(`tag:${safe}`);
		}
	}
	const unique = [...new Set(groups)];
	return {
		access: READ_METHODS.has(method) ? "read" : "write",
		...(unique.length > 0 ? { groups: unique } : {}),
		// An external HTTP effect: non-idempotent verbs must never auto-retry on a lost lease.
		effect: {
			kind: "external",
			idempotency: NON_IDEMPOTENT_METHODS.has(method) ? "none" : "optional",
		},
	};
}

// Resolve the scheme DEFINITIONS an operation's requirements reference, denormalized onto the
// binding. A referenced scheme that has no definition, or one euroclaw's invoker can't place, is a
// WARNING — extraction still yields a governed (if uninvokable) tool; the invoker fails loud at call
// time if a REQUIRED scheme is unsupported. Local $refs on a scheme resolve through the shared node
// resolver; a remote/circular ref on a scheme drops that scheme (never the operation).
function extractAuthSchemes(
	document: JsonObject,
	security: OpenApiBinding["security"],
	notes: string[],
): Record<string, OpenApiAuthScheme> | undefined {
	if (!security || security.length === 0) return undefined;
	const names = new Set<string>();
	for (const requirement of security) {
		for (const name of Object.keys(requirement)) names.add(name);
	}
	if (names.size === 0) return undefined;
	const components = asJsonObject(document.components);
	const definitions = asJsonObject(components?.securitySchemes);
	// Own-name entries + fromEntries: a spec-authored scheme name ("__proto__") must land as an own
	// property, never a prototype mutation.
	const entries: [string, OpenApiAuthScheme][] = [];
	for (const name of names) {
		if (!definitions || !Object.hasOwn(definitions, name)) {
			notes.push(
				`security scheme "${name}" has no definition in components.securitySchemes`,
			);
			continue;
		}
		let resolved: JsonValue;
		try {
			resolved = resolveNode(document, definitions[name] ?? null);
		} catch (error) {
			notes.push(
				`security scheme "${name}" dropped (${error instanceof OperationSkip ? error.message : String(error)})`,
			);
			continue;
		}
		const scheme = toAuthScheme(name, resolved, notes);
		if (scheme) entries.push([name, scheme]);
	}
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toAuthScheme(
	name: string,
	raw: JsonValue,
	notes: string[],
): OpenApiAuthScheme | undefined {
	if (!isJsonObject(raw)) {
		notes.push(
			`security scheme "${name}" dropped (definition is not an object)`,
		);
		return undefined;
	}
	const schemeType = raw.type;
	if (schemeType === "apiKey") {
		const location = raw.in;
		const keyName = raw.name;
		if (
			(location === "header" || location === "query") &&
			typeof keyName === "string" &&
			keyName !== ""
		) {
			return { type: "apiKey", in: location, name: keyName };
		}
		notes.push(
			`apiKey scheme "${name}" dropped (unsupported in=${JSON.stringify(location)} or missing name)`,
		);
		return undefined;
	}
	if (schemeType === "http") {
		const httpScheme =
			typeof raw.scheme === "string" ? raw.scheme.toLowerCase() : undefined;
		if (httpScheme === "bearer" || httpScheme === "basic") {
			return { type: "http", scheme: httpScheme };
		}
		notes.push(
			`http scheme "${name}" dropped (unsupported scheme ${JSON.stringify(raw.scheme)}; only bearer/basic)`,
		);
		return undefined;
	}
	if (schemeType === "oauth2" || schemeType === "openIdConnect") {
		return { type: schemeType };
	}
	notes.push(
		`security scheme "${name}" dropped (unsupported type ${JSON.stringify(schemeType)})`,
	);
	return undefined;
}

function extractSecurity(
	document: JsonObject,
	operation: JsonObject,
	notes: string[],
): OpenApiBinding["security"] {
	const declared = operation.security ?? document.security;
	if (!Array.isArray(declared)) return undefined;
	const out: NonNullable<OpenApiBinding["security"]> = [];
	for (const entry of declared) {
		const parsed = openApiSecurityRequirement(entry);
		if (parsed instanceof type.errors) {
			notes.push(`malformed security requirement dropped (${parsed.summary})`);
			continue;
		}
		out.push(parsed);
	}
	return out;
}

function serverUrl(
	document: JsonObject,
	pathItem: JsonObject,
	operation: JsonObject,
): string | undefined {
	const declared = [operation.servers, pathItem.servers, document.servers].find(
		(candidate) => Array.isArray(candidate) && candidate.length > 0,
	);
	if (!Array.isArray(declared)) return undefined;
	const parsed = openApiServer(declared[0]);
	if (parsed instanceof type.errors) return undefined;
	let url = parsed.url;
	const variables = asJsonObject(
		isJsonObject(declared[0]) ? declared[0].variables : undefined,
	);
	if (variables) {
		for (const [name, variable] of Object.entries(variables)) {
			const value = asJsonObject(variable);
			if (value && typeof value.default === "string") {
				url = url.replaceAll(`{${name}}`, value.default);
			}
		}
	}
	return url;
}

function deriveToolName(
	operation: JsonObject,
	method: OpenApiMethod,
	path: string,
): string {
	const id = operation.operationId;
	const seed =
		typeof id === "string" && id.trim() !== "" ? id : `${method}_${path}`;
	const name = seed
		.replace(/[{}]/g, "")
		.replace(/[^a-zA-Z0-9_-]+/g, "_")
		.replace(/_{2,}/g, "_")
		.replace(/^_+|_+$/g, "");
	return name === "" ? `${method}_operation` : name;
}

// ── $ref resolution: local pointers only, cycles refuse the operation ────────────────────────

/** The source-contract diagnostic + OpenAPI's structured locator. */
function diag(method: string, path: string, reason: string): OpenApiDiagnostic {
	return { subject: `${method} ${path}`, method, path, reason };
}

/** Thrown to skip one operation with a reported reason; never escapes toolsFromOpenApi. */
class OperationSkip extends Error {}

function skipReason(error: unknown): string {
	if (error instanceof OperationSkip) return error.message;
	throw error;
}

/** Resolve a possibly-$ref node to its target (without descending into it). */
function resolveNode(document: JsonObject, node: JsonValue): JsonValue {
	let current = node;
	const seen: string[] = [];
	while (isJsonObject(current) && typeof current.$ref === "string") {
		const ref = current.$ref;
		if (!ref.startsWith("#/")) {
			throw new OperationSkip(
				`remote $ref ${JSON.stringify(ref)} refused (local refs only)`,
			);
		}
		if (seen.includes(ref)) {
			throw new OperationSkip(`circular $ref ${JSON.stringify(ref)}`);
		}
		seen.push(ref);
		current = resolvePointer(document, ref);
	}
	return current;
}

// A crafted spec must not expand its way out of a size-capped upload: cycles are refused above,
// but exponential $ref FAN-OUT (two refs per level, 2^N nodes from a linear document) and
// pathological nesting (stack overflow) are bounded here. Hitting a bound skips the operation
// loudly — never a hang, never an uncontrolled throw.
const MAX_INLINED_NODES = 10_000;
const MAX_INLINE_DEPTH = 64;

/** Deep-copy a schema with every local $ref inlined; cycles/bombs skip the operation. */
function inlineRefs(
	document: JsonObject,
	node: JsonValue,
	stack: readonly string[],
	budget: { nodes: number } = { nodes: 0 },
	depth = 0,
): JsonValue {
	budget.nodes += 1;
	if (budget.nodes > MAX_INLINED_NODES) {
		throw new OperationSkip(
			`schema expands past ${MAX_INLINED_NODES} nodes when $refs inline (possible $ref bomb)`,
		);
	}
	if (depth > MAX_INLINE_DEPTH) {
		throw new OperationSkip(
			`schema nests deeper than ${MAX_INLINE_DEPTH} levels`,
		);
	}
	if (Array.isArray(node)) {
		return node.map((item) =>
			inlineRefs(document, item, stack, budget, depth + 1),
		);
	}
	if (!isJsonObject(node)) return node;
	const ref = node.$ref;
	if (typeof ref === "string") {
		if (!ref.startsWith("#/")) {
			throw new OperationSkip(
				`remote $ref ${JSON.stringify(ref)} refused (local refs only)`,
			);
		}
		if (stack.includes(ref)) {
			throw new OperationSkip(`circular $ref ${JSON.stringify(ref)}`);
		}
		// The inlined target nests at the SAME output depth — depth tracks the copy, not the walk.
		return inlineRefs(
			document,
			resolvePointer(document, ref),
			[...stack, ref],
			budget,
			depth,
		);
	}
	// fromEntries: a key like "__proto__" must become an OWN property of the copy, never a
	// prototype mutation mid-walk.
	return Object.fromEntries(
		Object.entries(node).map(([key, value]) => [
			key,
			inlineRefs(document, value, stack, budget, depth + 1),
		]),
	);
}

function resolvePointer(document: JsonObject, ref: string): JsonValue {
	let current: JsonValue = document;
	for (const segment of ref.slice(2).split("/")) {
		const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
		// Object.hasOwn, NOT `in`: a pointer like #/x/__proto__/constructor must not walk the
		// prototype chain into host objects.
		if (!isJsonObject(current) || !Object.hasOwn(current, key)) {
			throw new OperationSkip(`unresolvable $ref ${JSON.stringify(ref)}`);
		}
		current = current[key] ?? null;
	}
	return current;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}
