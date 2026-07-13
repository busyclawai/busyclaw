import type {
	EndpointRoute,
	EuroclawCronResult,
	EuroclawCronTask,
	EuroclawPlugin,
	EuroclawRoute,
	EuroclawRouteRequest,
} from "@euroclaw/contracts";
import {
	configurationError,
	EuroclawError,
	endpointRoutesOf,
	errorMessage,
	toKebabCase,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import type { Claw, ClawApi, ClawApiHttpMethod, ClawApiMethod } from "euroclaw";
import { clawApiRouteList, parseClawApiInput } from "euroclaw";

export type ClawHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

// The HTTP wire contract every euroclaw adapter response carries: a success/error envelope around
// the claw api result. One schema — the server builds it (errorResponse + the route handler bodies)
// and the client PARSES it (readClientResponse) rather than casting untrusted network JSON.
export const clawResponseEnvelope = type({
	"ok?": "boolean",
	"data?": "unknown",
	"error?": { message: "string" },
});
export type ClawResponseEnvelope = typeof clawResponseEnvelope.infer;

export type ClawRequestHandlerOptions = {
	basePath?: string;
	plugins?: readonly EuroclawPlugin[];
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
	return json(
		{
			error: { message: errorMessage(error) },
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
			handler: async ({ request, claw: routeClaw }) => {
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
				const data = await (fn as (input: unknown) => Promise<unknown>)(input);
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
	const valid = clawResponseEnvelope(body);
	return valid instanceof type.errors ? undefined : valid;
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

type MountedEndpoints = {
	/** Dotted api keys as written (`channels.registrations`) — error messages speak the caller's names. */
	name: string;
	/** Kebab mount prefix (`/channels/registrations`) — same splitter as the routes it prefixes. */
	prefix: string;
	routes: readonly EndpointRoute[];
};

// Find every endpoints() namespace under an api value: a metadata carrier mounts (its own route table
// is already flattened — no recursion past it); a plain object recurses so wrappers like
// `{ channels: { registrations: <endpoints> } }` mount at their full key path; functions are flat api
// methods and plain values are in-process-only members — neither is walked. The WeakSet keeps a
// self-referential api object from hanging assembly.
function collectEndpointNamespaces(input: {
	value: unknown;
	name: string;
	prefix: string;
	seen: WeakSet<object>;
	out: MountedEndpoints[];
}): void {
	const { value } = input;
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return;
	if (input.seen.has(value)) return;
	input.seen.add(value);
	const routes = endpointRoutesOf(value);
	if (routes) {
		input.out.push({ name: input.name, prefix: input.prefix, routes });
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		collectEndpointNamespaces({
			value: child,
			name: `${input.name}.${key}`,
			prefix: `${input.prefix}/${toKebabCase(key)}`,
			seen: input.seen,
			out: input.out,
		});
	}
}

// Plugin api namespaces declared with endpoints() become routes under `/<namespace>/…` — mounted
// beside the flat api routes and plugin webhook routes, so checkRouteConflicts fails loud on any
// collision at assembly. The arktype boundary sits HERE: the route parses+validates and hands the
// handler the validated value; the in-process namespace call never sees the schema.
function pluginEndpointRoutes(claw: Claw): ResolvedRoute[] {
	const namespaces: MountedEndpoints[] = [];
	const seen = new WeakSet<object>();
	for (const [key, value] of Object.entries(
		(claw.api ?? {}) as Record<string, unknown>,
	)) {
		collectEndpointNamespaces({
			value,
			name: key,
			prefix: `/${toKebabCase(key)}`,
			seen,
			out: namespaces,
		});
	}
	return namespaces.flatMap((namespace) =>
		namespace.routes.map((route) => {
			const path = `${namespace.prefix}${route.path}`;
			return {
				id: `endpoint:${route.method}:${path}`,
				method: route.method,
				path,
				handler: async ({ request }) => {
					const valid = route.input(await readInput(request, route.method));
					if (valid instanceof type.errors) {
						throw validationError(
							`claw.api.${namespace.name}.${route.name} input`,
							valid.summary,
						);
					}
					const data = await (route.handler as (input: unknown) => unknown)(
						valid,
					);
					return { body: { data, ok: true } };
				},
			} satisfies ResolvedRoute;
		}),
	);
}

export function toRequestHandler(
	claw: Claw,
	options: ClawRequestHandlerOptions = {},
): (request: Request) => Promise<Response> {
	const routes = [
		...baseRoutes(claw, options),
		...pluginRoutes(claw, options),
		...pluginEndpointRoutes(claw),
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
			return resultToResponse(
				await matched.route.handler({
					claw,
					params: matched.params,
					request,
					// Thread the one-door reader from the assembled claw (absent on a partial claw).
					secrets: claw.$context?.secrets,
				}),
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export type { Claw, ClawApi };
