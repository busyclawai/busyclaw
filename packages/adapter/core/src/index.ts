import type {
	ClawApiCaller,
	ClawResponseEnvelope,
	EuroclawCronResult,
	EuroclawCronTask,
	EuroclawPlugin,
	EuroclawRoute,
	EuroclawRouteRequest,
} from "@euroclaw/contracts";
import {
	configurationError,
	EuroclawError,
	errorMessage,
	parseClawResponseEnvelope,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import type { Claw, ClawApi, ClawApiHttpMethod, ClawApiMethod } from "euroclaw";
import { clawApiRouteList, parseClawApiInput } from "euroclaw";
import { mountedEndpointNamespaces } from "./endpoints";
import { type ClawOpenApiOptions, clawOpenApi } from "./openapi";

export type ClawHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

// The response envelope is wire PROTOCOL, so it lives in @euroclaw/contracts (the client parses it
// without importing any server package); re-exported here for existing consumers.
export type { ClawResponseEnvelope } from "@euroclaw/contracts";
export { clawResponseEnvelope } from "@euroclaw/contracts";
export type {
	ClawOpenApiDocument,
	ClawOpenApiOperation,
	ClawOpenApiOptions,
	ClawOpenApiSchema,
} from "./openapi";
export { clawOpenApi } from "./openapi";

export type ClawRequestHandlerOptions = {
	basePath?: string;
	plugins?: readonly EuroclawPlugin[];
	/** Opt-in `GET /openapi.json` serving the generated document — absent ⇒ no route. `true` for
	 *  default info; `{ enabled: true, info }` to title/version the document. */
	openApi?: true | { enabled: true; info?: ClawOpenApiOptions };
	/** The identity seam: resolve the authenticated caller from the request (the host extracts the
	 *  principal from its session/token), threaded to every governed api method and plugin endpoint
	 *  handler as their out-of-band 2nd argument — the over-the-wire analog of the in-process
	 *  `{ principal }`. This is the ONLY over-the-wire identity path: request BODIES never carry a
	 *  who/where field (docs/plans/stamped-fields.md). Absent ⇒ no caller is threaded (governed methods
	 *  then rely on the actor floor / their own fail-closed owner check). Returning `undefined` is the
	 *  same as an unauthenticated request. */
	resolveCaller?: (
		request: Request,
	) => ClawApiCaller | undefined | Promise<ClawApiCaller | undefined>;
};

type CronTaskResult = EuroclawCronResult & { id: string };

function json(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...(init?.headers ?? {}),
		},
	});
}

function statusForError(error: unknown): number {
	if (error instanceof EuroclawError) {
		if (error.code === "EUROCLAW_VALIDATION_FAILED") return 400;
		if (error.code === "EUROCLAW_UNSUPPORTED_OPERATION") return 400;
	}
	if (error instanceof SyntaxError) return 400;
	return 500;
}

function errorResponse(
	error: unknown,
	status = statusForError(error),
): Response {
	// EuroclawError failures carry their stable code onto the wire — the client surfaces it as
	// `error.code` so callers can branch on the code instead of matching message text.
	const code = error instanceof EuroclawError ? error.code : undefined;
	return json(
		{
			error: {
				message: errorMessage(error),
				...(code !== undefined ? { code } : {}),
			},
			ok: false,
		},
		{ status },
	);
}

function normalizePath(path: string): string {
	if (!path.startsWith("/")) return `/${path}`;
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function stripBasePath(pathname: string, basePath: string): string | null {
	const base = normalizePath(basePath);
	const path = normalizePath(pathname);
	if (base === "/") return path;
	if (path === base) return "/";
	if (path.startsWith(`${base}/`)) return path.slice(base.length);
	return null;
}

type ResolvedRoute = EuroclawRoute<Claw> & { id: string };

function routeKey(route: Pick<ResolvedRoute, "method" | "path">): string {
	return `${route.method} ${normalizePath(route.path)}`;
}

// A path segment beginning with ':' is a named parameter (e.g. /channels/:provider/:endpointKey).
// Static routes match via the O(1) map; only on a static miss are patterns tried — so a literal path
// always wins over a pattern.
function isPattern(path: string): boolean {
	return normalizePath(path)
		.split("/")
		.some((segment) => segment.startsWith(":"));
}

type CompiledPattern = {
	method: string;
	segments: readonly string[];
	route: ResolvedRoute;
};

function compilePattern(route: ResolvedRoute): CompiledPattern {
	return {
		method: route.method,
		segments: normalizePath(route.path).split("/"),
		route,
	};
}

function decodeParam(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function matchPattern(
	pattern: CompiledPattern,
	method: string,
	path: string,
): Record<string, string> | null {
	if (pattern.method !== method) return null;
	const segments = path.split("/");
	if (segments.length !== pattern.segments.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < pattern.segments.length; i++) {
		const patternSegment = pattern.segments[i];
		const pathSegment = segments[i];
		if (patternSegment === undefined || pathSegment === undefined) return null;
		if (patternSegment.startsWith(":")) {
			params[patternSegment.slice(1)] = decodeParam(pathSegment);
		} else if (patternSegment !== pathSegment) {
			return null;
		}
	}
	return params;
}

function matchPatternRoutes(
	patterns: readonly CompiledPattern[],
	method: string,
	path: string,
): { route: ResolvedRoute; params: Record<string, string> } | null {
	for (const pattern of patterns) {
		const params = matchPattern(pattern, method, path);
		if (params) return { route: pattern.route, params };
	}
	return null;
}

// For conflict detection param names are irrelevant — /x/:a and /x/:b are the same route shape and
// would be ambiguous at dispatch, so they must collide.
function conflictKey(route: Pick<ResolvedRoute, "method" | "path">): string {
	const shape = normalizePath(route.path)
		.split("/")
		.map((segment) => (segment.startsWith(":") ? ":" : segment))
		.join("/");
	return `${route.method} ${shape}`;
}

function checkRouteConflicts(routes: readonly ResolvedRoute[]): void {
	const seen = new Map<string, string>();
	for (const route of routes) {
		const key = conflictKey(route);
		const previous = seen.get(key);
		if (previous) {
			throw configurationError("euroclaw route conflict", {
				route: route.id ?? key,
				previous,
				key,
			});
		}
		seen.set(key, route.id);
	}
}

function methodFrom(request: Request): ClawHttpMethod | null {
	const method = request.method.toUpperCase();
	if (
		method === "DELETE" ||
		method === "GET" ||
		method === "PATCH" ||
		method === "POST" ||
		method === "PUT"
	) {
		return method;
	}
	return null;
}

async function readInput(
	request: EuroclawRouteRequest,
	method: ClawHttpMethod,
): Promise<unknown> {
	if (method === "GET") {
		const search = new URL(request.url).searchParams;
		const encoded = search.get("input");
		if (encoded) return JSON.parse(encoded) as unknown;
		return Object.fromEntries(search.entries());
	}
	const text = await request.text();
	return text ? (JSON.parse(text) as unknown) : {};
}

function resultToResponse(result: unknown): Response {
	if (result instanceof Response) return result;
	if (
		result &&
		typeof result === "object" &&
		("body" in result || "status" in result || "headers" in result)
	) {
		const routeResult = result as {
			body?: unknown;
			headers?: Record<string, string>;
			status?: number;
		};
		return json(routeResult.body ?? { ok: true }, {
			headers: routeResult.headers,
			status: routeResult.status,
		});
	}
	return json({ data: result, ok: true });
}

function apiRoutes(): ResolvedRoute[] {
	return clawApiRouteList.map((apiRoute) => {
		const name = apiRoute.apiMethod;
		const method = apiRoute.httpMethod;
		return {
			id: `api:${name}`,
			method,
			path: apiRoute.path,
			handler: async ({ request, claw: routeClaw, caller }) => {
				const fn = (routeClaw.api as Record<string, unknown>)[name];
				if (typeof fn !== "function") {
					return {
						status: 404,
						body: {
							ok: false,
							error: { message: `unknown api method: ${name}` },
						},
					};
				}
				const input = parseClawApiInput(name, await readInput(request, method));
				// The resolved caller rides at arg index 1 (the WithCaller contract) so a governed method
				// gets its authenticated principal over the wire — identity beside the input, never in it.
				const data = await (
					fn as (input: unknown, caller?: unknown) => Promise<unknown>
				)(input, caller);
				return { body: { data, ok: true } };
			},
		} satisfies ResolvedRoute;
	});
}

function pluginsFrom(
	claw: Claw,
	options: ClawRequestHandlerOptions,
): EuroclawPlugin[] {
	return [...(claw.$context?.plugins ?? []), ...(options.plugins ?? [])];
}

function cronTasksFrom(plugins: readonly EuroclawPlugin[]): EuroclawCronTask[] {
	return plugins.flatMap((plugin) => [...(plugin.cron ?? [])]);
}

async function runCronTasks(input: {
	claw: Claw;
	limit?: number;
	request: EuroclawRouteRequest;
	tasks: readonly EuroclawCronTask[];
}): Promise<CronTaskResult[]> {
	const results: CronTaskResult[] = [];
	for (const task of input.tasks) {
		const result = await task.handler({
			claw: input.claw,
			limit: input.limit,
			request: input.request,
			// Thread the one-door reader from the assembled claw (absent on a partial claw).
			secrets: input.claw.$context?.secrets,
		});
		results.push({ id: task.id, ...result });
	}
	return results;
}

function baseRoutes(
	claw: Claw,
	options: ClawRequestHandlerOptions,
): ResolvedRoute[] {
	const cronHandler = claw.$context?.cronHandler;
	return [
		{
			id: "health",
			method: "GET",
			path: "/health",
			handler: () => ({ body: { ok: true } }),
		},
		...(cronHandler
			? [
					{
						id: "cron",
						method: "POST" as const,
						path: "/cron",
						handler: async ({ claw, request }) => {
							const headerName =
								cronHandler.headerName ?? "x-euroclaw-cron-secret";
							if (
								"secret" in cronHandler &&
								request.headers.get(headerName) !== cronHandler.secret
							) {
								return {
									status: 401,
									body: { error: { message: "unauthorized" }, ok: false },
								};
							}
							const tasks = cronTasksFrom(pluginsFrom(claw, options));
							const results = await runCronTasks({
								claw,
								limit: cronHandler.limit,
								request,
								tasks,
							});
							return { body: { data: { tasks: results }, ok: true } };
						},
					} satisfies ResolvedRoute,
				]
			: []),
		...apiRoutes(),
	];
}

export type ClawClientFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type ClawClientOptions = {
	baseUrl?: string | URL;
	fetch?: ClawClientFetch;
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
};

function normalizeBaseUrl(baseUrl: string | URL | undefined): string {
	return String(baseUrl ?? "/api/euroclaw").replace(/\/+$/, "");
}

function routeUrl(baseUrl: string, path: string): string {
	return `${baseUrl}${normalizePath(path)}`;
}

function withEncodedInput(url: string, input: unknown): string {
	const parsed = new URL(url, "http://euroclaw.local");
	parsed.searchParams.set("input", JSON.stringify(input ?? {}));
	if (/^https?:\/\//.test(url)) return parsed.toString();
	return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function resolveHeaders(
	headers: ClawClientOptions["headers"],
): Promise<HeadersInit | undefined> {
	return typeof headers === "function" ? headers() : headers;
}

async function jsonHeaders(
	headers: ClawClientOptions["headers"],
): Promise<Headers> {
	const next = new Headers(await resolveHeaders(headers));
	next.set("content-type", "application/json");
	return next;
}

function parseEnvelope(text: string): ClawResponseEnvelope | undefined {
	if (!text) return undefined;
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		// Not JSON (a proxy/gateway error page, say) — let the HTTP status drive the error message.
		return undefined;
	}
	return parseClawResponseEnvelope(body);
}

async function readClientResponse(response: Response): Promise<unknown> {
	const envelope = parseEnvelope(await response.text());
	if (!response.ok || envelope?.ok === false) {
		throw new Error(
			envelope?.error?.message ??
				`euroclaw request failed with status ${response.status}`,
		);
	}
	return envelope?.data;
}

async function callApiRoute(input: {
	baseUrl: string;
	fetch: ClawClientFetch;
	headers?: ClawClientOptions["headers"];
	method: ClawApiMethod;
	payload: unknown;
	routeMethod: ClawApiHttpMethod;
	path: string;
}): Promise<unknown> {
	const payload = parseClawApiInput(input.method, input.payload ?? {});
	const headers = await resolveHeaders(input.headers);
	const url = routeUrl(input.baseUrl, input.path);
	if (input.routeMethod === "GET") {
		return readClientResponse(
			await input.fetch(withEncodedInput(url, payload), {
				headers,
				method: "GET",
			}),
		);
	}
	return readClientResponse(
		await input.fetch(url, {
			body: JSON.stringify(payload),
			headers: await jsonHeaders(input.headers),
			method: input.routeMethod,
		}),
	);
}

// The generic client covers the FLAT routed methods (clawApiRouteList / ClawApiMethod) — every
// base api method is a single callable route today.
export function createClawClient(
	options: ClawClientOptions = {},
): Pick<ClawApi, ClawApiMethod> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const clientFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	return Object.fromEntries(
		clawApiRouteList.map((route) => [
			route.apiMethod,
			(input: unknown) =>
				callApiRoute({
					baseUrl,
					fetch: clientFetch,
					headers: options.headers,
					method: route.apiMethod,
					path: route.path,
					payload: input,
					routeMethod: route.httpMethod,
				}),
		]),
	) as Pick<ClawApi, ClawApiMethod>;
}

function pluginRoutes(
	claw: Claw,
	options: ClawRequestHandlerOptions,
): ResolvedRoute[] {
	const plugins = pluginsFrom(claw, options);
	return plugins.flatMap((plugin) =>
		(plugin.routes ?? []).map(
			(route) =>
				({
					...route,
					id: route.id ?? `${plugin.id}:${route.method}:${route.path}`,
				}) as ResolvedRoute,
		),
	);
}

// Plugin api namespaces declared with endpoints() become routes under `/<namespace>/…` — mounted
// beside the flat api routes and plugin webhook routes, so checkRouteConflicts fails loud on any
// collision at assembly. Discovery lives in ./endpoints (shared with the OpenAPI generator). The
// arktype boundary sits HERE: the route parses+validates and hands the handler the validated value;
// the in-process namespace call never sees the schema.
function pluginEndpointRoutes(claw: Claw): ResolvedRoute[] {
	return mountedEndpointNamespaces(claw.api ?? {}).flatMap((namespace) =>
		namespace.routes.map((route) => {
			const path = `${namespace.prefix}${route.path}`;
			return {
				id: `endpoint:${route.method}:${path}`,
				method: route.method,
				path,
				handler: async ({ request, caller }) => {
					const valid = route.input(await readInput(request, route.method));
					if (valid instanceof type.errors) {
						throw validationError(
							`claw.api.${namespace.name}.${route.name} input`,
							valid.summary,
						);
					}
					// The resolved caller rides at arg index 1 (the WithCaller contract) so a plugin
					// endpoint (e.g. secrets.set) keys off the authenticated principal, not the body.
					const data = await (
						route.handler as (input: unknown, caller?: unknown) => unknown
					)(valid, caller);
					return { body: { data, ok: true } };
				},
			} satisfies ResolvedRoute;
		}),
	);
}

// The opt-in spec route: `GET /openapi.json` with the document generated ONCE at assembly (routes
// are fixed then, and a generation failure surfaces at boot, not first traffic). The document IS
// the whole response body — deliberately NOT wrapped in the success envelope: this is a spec
// document, and spec tooling (generators, reference UIs) expects the bare OpenAPI object here.
function openApiRoutes(
	claw: Claw,
	options: ClawRequestHandlerOptions,
): ResolvedRoute[] {
	const openApi = options.openApi;
	if (openApi === undefined) return [];
	const document = clawOpenApi(claw, openApi === true ? {} : openApi.info);
	return [
		{
			id: "openapi",
			method: "GET",
			path: "/openapi.json",
			handler: () => ({ body: document }),
		},
	];
}

export function toRequestHandler(
	claw: Claw,
	options: ClawRequestHandlerOptions = {},
): (request: Request) => Promise<Response> {
	const routes = [
		...baseRoutes(claw, options),
		...pluginRoutes(claw, options),
		...pluginEndpointRoutes(claw),
		...openApiRoutes(claw, options),
	];
	checkRouteConflicts(routes);
	const staticRoutes = routes.filter((route) => !isPattern(route.path));
	const patternRoutes = routes
		.filter((route) => isPattern(route.path))
		.map(compilePattern);
	const routeMap = new Map(
		staticRoutes.map((route) => [routeKey(route), route]),
	);
	const basePath = options.basePath ?? "/api/euroclaw";

	return async (request) => {
		const method = methodFrom(request);
		if (!method) return errorResponse("method not allowed", 405);
		const path = stripBasePath(new URL(request.url).pathname, basePath);
		if (!path) return errorResponse("not found", 404);
		const normalizedPath = normalizePath(path);
		const staticRoute = routeMap.get(`${method} ${normalizedPath}`);
		const matched = staticRoute
			? { route: staticRoute, params: {} }
			: matchPatternRoutes(patternRoutes, method, normalizedPath);
		if (!matched) return errorResponse("not found", 404);
		try {
			// The identity seam: the host resolves the caller from the request (session/token). Threaded
			// to governed api methods + plugin endpoint handlers as their 2nd arg — identity NEVER rides
			// the body. Absent resolver ⇒ no caller (the pre-seam default; the actor floor / owner check
			// then decides).
			const caller = options.resolveCaller
				? await options.resolveCaller(request)
				: undefined;
			return resultToResponse(
				await matched.route.handler({
					claw,
					params: matched.params,
					request,
					// Thread the one-door reader from the assembled claw (absent on a partial claw).
					secrets: claw.$context?.secrets,
					caller,
				}),
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export type { Claw, ClawApi };
