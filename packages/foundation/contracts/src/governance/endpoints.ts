// Declared, routable plugin api endpoints (docs/plans/claw-client-plan.md, slice 1). A plugin api
// namespace built with `endpoints()` IS the plain callable object it always was — each method is the
// handler itself, so the in-process path (`claw.api.secrets.set(...)`) stays a typed TS call with
// zero wrapping — while the route table an HTTP adapter needs (path, verb, boundary schema) rides
// along as NON-ENUMERABLE metadata. Non-enumerable is load-bearing twice over: the namespace stays
// shape-identical to a hand-built api object (merges/asserts/tests see the same keys), and a spread
// (`{ ...ns }`) silently DROPS the metadata — so composition happens on definition records (spread
// the defs, call `endpoints()` once), never on built namespaces.

import { configurationError } from "@euroclaw/errors";
import type { ClawApiCaller } from "./principal";
import type { RouteAuthz, RouteDefinition } from "./route";

/** The verbs a routed endpoint may declare. The DEFAULT derivation is RPC-shaped — reads ride GET
 *  (input in the query), everything else POST — but a route may declare any of these explicitly with
 *  `.method(...)`, so a resource-shaped api can say PUT/PATCH/DELETE and have the generated OpenAPI
 *  document, the adapter's route table, and any gateway in front of them all agree. The adapter has
 *  always accepted the full set (`ClawHttpMethod`); only the declaration side was narrower. */
export type EndpointHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

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

/** A definition is a route BUILT by `route.…​.handler()`. The builder owns input/output typing and the
 *  authz gate; this module only collects. */
export type EndpointDefinition = RouteDefinition<never, unknown>;

/** A record of built routes, optionally grouped: a nested record is a GROUP whose key becomes a path
 *  segment, so a namespace can mirror shapes like `skills.packages.create` → `/packages/create`. */
export type EndpointDefinitions = {
	// biome-ignore lint/suspicious/noExplicitAny: a route's In/Out vary per entry; `any` here is the
	// only way to accept a heterogeneous record without erasing each entry's own types, which
	// `InferEndpoints` reads back below.
	readonly [name: string]: RouteDefinition<any, any> | EndpointDefinitions;
};

/**
 * The callable namespace `endpoints()` returns. Each route becomes `(input, caller?) => Promise<Out>`
 * — the signature a CONSUMER sees. The stored handler's second parameter is the {@link AuthzContext},
 * not the caller: the PEP builds that context per call (it needs the policy engine, which does not
 * exist at definition time) and substitutes it when it wraps the namespace. So this type describes the
 * governed method, which is the only one ever exposed — the same arrangement the route table already
 * relies on to keep one door.
 */
export type InferEndpoints<Defs> = {
	[K in keyof Defs]: Defs[K] extends RouteDefinition<infer In, infer Out>
		? (input: In, caller?: ClawApiCaller) => Promise<Out>
		: InferEndpoints<Defs[K]>;
};

// `ValidateEndpointOutputs` and `ValidateEndpointResources` used to live here: two mapped types that
// intersected the argument of `endpoints()` to pin each handler's return to its declared `output` and
// each resource binding's keys to its handler's input. The route builder now does both jobs at the
// point of declaration — `.output()` pins the return, `.authz()`'s resolver is typed from `.input()` —
// so a validator that re-derives them from a finished record is a second source of truth with nothing
// left to say. This module went back to being a collector.

/** One declared route, PATH-RELATIVE to its namespace mount (the adapter prefixes the api key). */
export type EndpointRoute = {
	/** Dot-joined definition keys relative to the namespace root (e.g. `"set"`, `"packages.create"`). */
	name: string;
	/** Kebab-cased relative path (e.g. `"/set"`, `"/packages/create"`). */
	path: `/${string}`;
	method: EndpointHttpMethod;
	input: EndpointInputSchema;
	handler: EndpointDefinition["handler"];
	description?: string;
	/** The declared response schema as passed — documentation + typing only, never run. */
	output?: EndpointOutputSchema;
	/** How this route resolves its authorization, as declared by `.authz()`. REQUIRED: a route with no
	 *  authz cannot be built, so a route table entry always carries one. The PEP evaluates it before the
	 *  handler runs; the boot-time coverage walk reads it to enumerate every route that authorizes
	 *  against nothing but the caller, together with the reason each one gave. */
	authz: RouteAuthz;
};

/**
 * The ONE camelCase→kebab splitter for route paths — the base api's method→path derivation and the
 * plugin endpoint mounts both use it, and the client (slice 2) derives paths from the same function.
 * Two splitters disagreeing means silent 404s, so there is exactly one.
 */
export function toKebabCase(value: string): string {
	return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** The DEFAULT name→verb rule, shared with the base api routes: `get*`/`list*` reads ride GET, all else
 *  POST. A declared `.method(...)` wins — the rule is a convenience for RPC-shaped names, not a
 *  constraint on what a route may be. */
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
			// The builder cannot produce a route without an authz, but a hand-rolled object literal can
			// reach here. Refuse at declaration: this is the exact state the whole mechanism exists to
			// make impossible, and it must not degrade into "no check".
			if (value.authz === undefined) {
				throw configurationError("euroclaw endpoint declares no authz", {
					endpoint: [...names, name].join("."),
					reason:
						"build routes with `route.input(…).authz(…).handler(…)` — a route must say what it authorizes against",
				});
			}
			namespace[name] = value.handler;
			routes.push({
				name: [...names, name].join("."),
				path: `/${path.join("/")}`,
				method: value.method ?? endpointHttpMethod(name),
				input: value.input,
				handler: value.handler,
				// Read by the PEP before the handler runs, and by the boot coverage walk.
				authz: value.authz,
				...(value.description !== undefined
					? { description: value.description }
					: {}),
				// Carried for the OpenAPI generator only — the route handler never validates against it
				// (outputs are trusted server code; arktype guards boundaries, not our own returns).
				...(value.output !== undefined ? { output: value.output } : {}),
			});
		} else {
			namespace[name] = buildNamespace(value, [...names, name], path, routes);
		}
	}
	return namespace;
}

/**
 * Collect a namespace from routes built with `route.input(…).output(…).authz(…).handler(…)`, nested
 * records as groups. Returns the CALLABLE namespace (methods are the handlers, identity-preserved) with
 * the flattened {@link EndpointRoute} table attached non-enumerably under {@link ENDPOINTS_METADATA} —
 * read it with {@link endpointRoutesOf}.
 *
 * The NAME of each route is the record key, written once. Typing and the authz gate belong to the
 * builder; this function only collects, which is why it no longer takes validator intersections.
 */
export function endpoints<const Defs extends EndpointDefinitions>(
	defs: Defs,
): InferEndpoints<Defs> {
	const routes: EndpointRoute[] = [];
	const namespace = buildNamespace(defs, [], [], routes);
	Object.defineProperty(namespace, ENDPOINTS_METADATA, { value: routes });
	return namespace as InferEndpoints<Defs>;
}
