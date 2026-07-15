// Declared, routable plugin api endpoints (docs/plans/claw-client-plan.md, slice 1). A plugin api
// namespace built with `endpoints()` IS the plain callable object it always was — each method is the
// handler itself, so the in-process path (`claw.api.secrets.set(...)`) stays a typed TS call with
// zero wrapping — while the route table an HTTP adapter needs (path, verb, boundary schema) rides
// along as NON-ENUMERABLE metadata. Non-enumerable is load-bearing twice over: the namespace stays
// shape-identical to a hand-built api object (merges/asserts/tests see the same keys), and a spread
// (`{ ...ns }`) silently DROPS the metadata — so composition happens on definition records (spread
// the defs, call `endpoints()` once), never on built namespaces.

import { configurationError } from "@euroclaw/errors";
import type { LooseResourceBinding, ResourceBinding } from "./resource-binding";

/** Routed endpoints are RPC-shaped: reads ride GET (input in the query), everything else POST. */
export type EndpointHttpMethod = "GET" | "POST";

/** The boundary validator an endpoint declares — an arktype type in practice, typed as the same
 *  loose callable euroclaw's `ClawApiInputSchema` uses (call it; an errors instance means invalid). */
export type EndpointInputSchema = (input: unknown) => unknown;

/** The declared response schema — an arktype type in practice, typed structurally against its
 *  `infer` phantom (the one property the type-level handler pin reads). NEVER runtime-validated:
 *  a handler result is produced by trusted server code, and arktype validates only where untrusted
 *  data crosses a boundary — this schema exists to pin the handler's return TYPE and to document
 *  the operation (OpenAPI 200 `data`). */
export type EndpointOutputSchema = {
	readonly infer: unknown;
};

export type EndpointDefinition = {
	/** Validates at the HTTP boundary ONLY: the adapter route parses+validates and hands the handler
	 *  the validated value. In-process calls go straight into the handler, schema untouched. */
	input: EndpointInputSchema;
	handler: (input: never) => unknown;
	/** Verb override for the exceptions; absent ⇒ the shared `get*`/`list*` → GET name rule. */
	method?: EndpointHttpMethod;
	/** Operation summary for the OpenAPI generator — carried in metadata. */
	description?: string;
	/** Declared response schema: pins the handler's return type (see {@link ValidateEndpointOutputs})
	 *  and documents the OpenAPI 200 `data`. Carried in metadata; never runtime-validated. */
	output?: EndpointOutputSchema;
	/** The co-located app-authz resource binding — the plugin-extensible analog of the base api's route
	 *  binding. Typed LOOSELY here (any string key); {@link ValidateEndpointResources} tightens `idKey`/
	 *  `kindKey` to this def's handler INPUT keys at the `endpoints()` call, so a wrong key won't compile.
	 *  Carried into the {@link EndpointRoute} metadata; the PEP reads it to resolve the resource. Absent ⇒
	 *  the method is not resource-anchored (personal scope). */
	resource?: LooseResourceBinding;
};

/** A record of definitions, optionally grouped: a nested record is a GROUP whose key becomes a path
 *  segment, so a namespace can mirror shapes like `skills.packages.create` → `/packages/create`. */
export type EndpointDefinitions = {
	readonly [name: string]: EndpointDefinition | EndpointDefinitions;
};

/** The callable namespace `endpoints()` returns: every definition's handler exposed AS-IS (the
 *  unchanged in-process path), groups mirrored as nested plain objects. */
export type InferEndpoints<Defs> = {
	[K in keyof Defs]: Defs[K] extends {
		handler: infer Handler extends (...args: never[]) => unknown;
	}
		? Handler
		: InferEndpoints<Defs[K]>;
};

/** The type-level half of `output`: a definition that declares an output schema must have a handler
 *  returning that schema's inferred type (sync or promised) — `endpoints()` intersects its argument
 *  with this, so a drifted return shape fails to compile at the definition. Without `output` the
 *  handler return stays free (`unknown` imposes nothing). Purely a compile-time pin — the schema is
 *  never run against the result (see {@link EndpointOutputSchema}). */
export type ValidateEndpointOutputs<Defs> = {
	[K in keyof Defs]: Defs[K] extends { handler: (input: never) => unknown }
		? Defs[K] extends { output: infer Output extends EndpointOutputSchema }
			? {
					handler: (input: never) => Output["infer"] | Promise<Output["infer"]>;
				}
			: unknown
		: ValidateEndpointOutputs<Defs[K]>;
};

/** The type-level half of `resource`: a definition that declares a resource binding must use `idKey`
 *  (and `kindKey`) that are keys of the handler's INPUT — `endpoints()` intersects its argument with
 *  this, so a binding pointing at a non-existent input field fails to compile at the definition. Without
 *  `resource` the def is unconstrained (`unknown` imposes nothing). Compile-time only; the co-located
 *  binding is READ by the app-authz PEP, never run. */
export type ValidateEndpointResources<Defs> = {
	[K in keyof Defs]: Defs[K] extends {
		handler: infer Handler extends (...args: never[]) => unknown;
	}
		? Defs[K] extends { resource: LooseResourceBinding }
			? { resource: ResourceBinding<Parameters<Handler>[0]> }
			: unknown
		: ValidateEndpointResources<Defs[K]>;
};

/** One declared route, PATH-RELATIVE to its namespace mount (the adapter prefixes the api key). */
export type EndpointRoute = {
	/** Dot-joined definition keys relative to the namespace root (e.g. `"set"`, `"packages.create"`). */
	name: string;
	/** Kebab-cased relative path (e.g. `"/set"`, `"/packages/create"`). */
	path: `/${string}`;
	method: EndpointHttpMethod;
	input: EndpointInputSchema;
	handler: (input: never) => unknown;
	description?: string;
	/** The declared response schema as passed — documentation + typing only, never run. */
	output?: EndpointOutputSchema;
	/** The co-located app-authz resource binding as declared — read by the PEP loader, never run. */
	resource?: LooseResourceBinding;
};

/**
 * The ONE camelCase→kebab splitter for route paths — the base api's method→path derivation and the
 * plugin endpoint mounts both use it, and the client (slice 2) derives paths from the same function.
 * Two splitters disagreeing means silent 404s, so there is exactly one.
 */
export function toKebabCase(value: string): string {
	return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** The one name→verb rule, shared with the base api routes: `get*`/`list*` reads ride GET, all else
 *  POST. A per-endpoint `method` override wins (declared, not a heuristic patch table). */
export function endpointHttpMethod(name: string): EndpointHttpMethod {
	return name.startsWith("get") || name.startsWith("list") ? "GET" : "POST";
}

/** Where `endpoints()` parks its route table on the returned namespace. `Symbol.for`, so duplicated
 *  contract module instances in one dependency graph still read each other's metadata. */
export const ENDPOINTS_METADATA: unique symbol =
	Symbol.for("euroclaw.endpoints");

/** Read the declared routes off an api value; `undefined` for anything that isn't an `endpoints()`
 *  namespace (a plain object contribution stays legal — it just isn't routable). */
export function endpointRoutesOf(
	value: unknown,
): readonly EndpointRoute[] | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const routes = (value as { [ENDPOINTS_METADATA]?: unknown })[
		ENDPOINTS_METADATA
	];
	return Array.isArray(routes) ? (routes as EndpointRoute[]) : undefined;
}

// A group can legally contain a member NAMED "handler" (it would be an object); only a function
// marks a definition, so the discrimination is total.
function isEndpointDefinition(
	value: EndpointDefinition | EndpointDefinitions,
): value is EndpointDefinition {
	return typeof (value as { handler?: unknown }).handler === "function";
}

function buildNamespace(
	defs: EndpointDefinitions,
	names: readonly string[],
	segments: readonly string[],
	routes: EndpointRoute[],
): Record<string, unknown> {
	const namespace: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(defs)) {
		const path = [...segments, toKebabCase(name)];
		if (isEndpointDefinition(value)) {
			// A JS caller can omit `input` the types require — refuse at declaration, not first traffic
			// (a schemaless route would pass unvalidated network input into the handler).
			if (typeof value.input !== "function") {
				throw configurationError("euroclaw endpoint has no input schema", {
					endpoint: [...names, name].join("."),
				});
			}
			namespace[name] = value.handler;
			routes.push({
				name: [...names, name].join("."),
				path: `/${path.join("/")}`,
				method: value.method ?? endpointHttpMethod(name),
				input: value.input,
				handler: value.handler,
				...(value.description !== undefined
					? { description: value.description }
					: {}),
				// Carried for the OpenAPI generator only — the route handler never validates against it
				// (outputs are trusted server code; arktype guards boundaries, not our own returns).
				...(value.output !== undefined ? { output: value.output } : {}),
				// The app-authz resource binding rides along so the PEP can read a plugin method's binding
				// off the re-attached route metadata — the plugin-side of the co-located loader registry.
				...(value.resource !== undefined ? { resource: value.resource } : {}),
			});
		} else {
			namespace[name] = buildNamespace(value, [...names, name], path, routes);
		}
	}
	return namespace;
}

/**
 * Declare a plugin api namespace: `{ input, handler, method?, description?, output?, resource? }` per
 * method, nested records as groups. Returns the CALLABLE namespace (methods are the handlers,
 * identity-preserved) with the flattened {@link EndpointRoute} table attached non-enumerably under
 * {@link ENDPOINTS_METADATA} — read it with {@link endpointRoutesOf}. The
 * {@link ValidateEndpointOutputs} intersection pins each handler's return to its declared `output`
 * schema at compile time; {@link ValidateEndpointResources} pins each declared `resource` binding's
 * `idKey`/`kindKey` to the handler's input keys.
 */
export function endpoints<const Defs extends EndpointDefinitions>(
	defs: Defs & ValidateEndpointOutputs<Defs> & ValidateEndpointResources<Defs>,
): InferEndpoints<Defs> {
	const routes: EndpointRoute[] = [];
	const namespace = buildNamespace(defs, [], [], routes);
	Object.defineProperty(namespace, ENDPOINTS_METADATA, { value: routes });
	return namespace as InferEndpoints<Defs>;
}
