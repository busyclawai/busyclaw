import type {
	BusyclawCronResult,
	BusyclawCronTask,
	BusyclawPlugin,
	BusyclawRoute,
	BusyclawRouteRequest,
	BusyclawRouteResult,
	ClawApiCaller,
	ClawResponseEnvelope,
	RunStreamPage,
	ServerSentEvent,
} from "@busyclaw/contracts";
import {
	BusyclawError,
	configurationError,
	correlationId,
	errorMessage,
	limitError,
	parseClawResponseEnvelope,
	validationError,
} from "@busyclaw/contracts";
import {
	constantTimeEquals,
	MAX_REQUEST_BODY_BYTES,
	parseRequestBody,
	readBoundedText,
	readRequestBody,
} from "@busyclaw/core";
import { watchToUIMessageStreamResponse } from "@busyclaw/vendors/ai-sdk";
import { type } from "arktype";
import type {
	Claw,
	ClawApi,
	ClawApiHttpMethod,
	ClawApiInputSchema,
	ClawApiMethod,
} from "busyclaw";
import { clawApiRouteList, parseClawApiInput } from "busyclaw";
import { mountedEndpointNamespaces } from "./endpoints";
import { type ClawOpenApiOptions, clawOpenApi } from "./openapi";

export type ClawHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

// The response envelope is wire PROTOCOL, so it lives in @busyclaw/contracts (the client parses it
// without importing any server package); re-exported here for existing consumers.
export type { ClawResponseEnvelope } from "@busyclaw/contracts";
export { clawResponseEnvelope } from "@busyclaw/contracts";
export type {
	ClawOpenApiDocument,
	ClawOpenApiOperation,
	ClawOpenApiOptions,
	ClawOpenApiSchema,
} from "./openapi";
export { clawOpenApi } from "./openapi";

export type ClawRequestHandlerOptions = {
	basePath?: string;
	plugins?: readonly BusyclawPlugin[];
	/** Opt-in `GET /openapi.json` serving the generated document — absent ⇒ no route. `true` for
	 *  default info; `{ enabled: true, info }` to title/version the document. */
	openApi?: true | { enabled: true; info?: ClawOpenApiOptions };
	/** The identity seam: resolve the authenticated caller from the request — the host extracts the
	 *  principal from a SERVER-VERIFIED session/token, NEVER a client-supplied header or body. Threaded
	 *  to every governed api method + plugin endpoint handler as their out-of-band 2nd argument: the
	 *  over-the-wire analog of the in-process `{ principal }` (in-process callers pass that directly;
	 *  this is only the HTTP boundary's producer of the same value). It is the ONLY over-the-wire
	 *  identity path — request BODIES never carry a who/where field; those are server-stamped from the
	 *  caller (docs/plans/stamped-fields.md).
	 *
	 *  IF YOU AUTHENTICATE FROM A COOKIE, CHECK THE ORIGIN HERE. A cookie is sent by the browser on
	 *  cross-site requests whether or not the user meant to make one, so possession of a session is
	 *  not evidence of intent — this is the one place holding the whole request, and therefore the
	 *  only place that can tell. Bodied requests must already declare `application/json`, which stops
	 *  a plain cross-site HTML form (a browser cannot send that content type cross-site without a
	 *  preflight it will fail), but that is one shape, not the property. Prefer `SameSite=Lax` or
	 *  `Strict` and reject a foreign `Origin` on anything that writes. A bearer token read from a
	 *  header is not ambient and needs none of this.
	 *
	 *  FAIL-CLOSED: absent, or returning `undefined` (an unauthenticated request), means no principal —
	 *  so the principal floor DENIES every governed core api call with a 403 (a plugin endpoint falls to its
	 *  own fail-closed owner check). A misconfigured mount is thus safe: it denies, it never exposes.
	 *  Wiring this seam is what makes the HTTP surface both usable and authorized (audit #1/#3).
	 *
	 *  @example
	 *  toRequestHandler(claw, {
	 *    resolveCaller: async (request) => {
	 *      const session = await auth.verify(request.headers); // your server-side session check
	 *      return session ? { principal: `user:${session.userId}` } : undefined;
	 *    },
	 *  });
	 */
	resolveCaller?: (
		request: Request,
	) => ClawApiCaller | undefined | Promise<ClawApiCaller | undefined>;
	/**
	 * Where an UNEXPECTED exception goes, now that it no longer goes to the caller.
	 *
	 * Only failures nobody authored for a caller arrive here — a `BusyclawError` is deliberate and
	 * still answers for itself on the wire. `correlationId` is the handle the caller was given, so a
	 * support request quoting it lands on this record.
	 *
	 * Defaults to `console.error`. Suppressing it entirely (`() => {}`) makes these failures
	 * invisible: the caller is told nothing by design, so this is the only place left that knows.
	 * The error may carry unredacted values — treat this sink as privileged, and if it forwards
	 * anywhere (an APM, a log aggregator) make that a deliberate choice about where PII may land.
	 */
	onError?: (report: {
		correlationId: string;
		error: unknown;
		method: string;
		path: string;
	}) => void;
};

type CronTaskResult = BusyclawCronResult & { id: string };

/**
 * L-11. Every response here is per-caller: it was authorized for one principal, and much of it is
 * that principal's transcript. Without an explicit directive a shared cache — a corporate proxy, a
 * CDN in front of the app, a browser's own back/forward store — is free to apply its heuristics, and
 * the failure mode is one user being served another's answer.
 *
 * `no-store` by DEFAULT, overridable through `init.headers`, because the only response here that is
 * not per-caller is the OpenAPI document, which says so for itself.
 */
/**
 * How large a single response body may be before the door refuses to send it.
 *
 * R-M12. Request ingress was bounded and egress was not, which is the asymmetry that matters: the
 * body here is assembled from whatever a list returned, and several lists had no ceiling at all. One
 * `listMessages` over a long thread, or `listApprovals` on a busy tenant, serialized the whole result
 * set into memory and wrote it out — so the cost of a request was set by how much data the caller
 * already had, not by anything the caller sent.
 *
 * Generous, because it is a backstop and not a pagination policy: it exists so an unbounded result
 * fails loudly and locally instead of becoming an out-of-memory or a very large transfer.
 */
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

function json(data: unknown, init?: ResponseInit): Response {
	const body = JSON.stringify(data);
	// Refused as a LIMIT, not a 500: the same value will be too big next time however well-formed it
	// is, and a caller can act on that by asking for less.
	if (body !== undefined && body.length > MAX_RESPONSE_BODY_BYTES) {
		// Built inline rather than through the error responder, which routes back through this function.
		const refusal = {
			error: {
				message: errorMessage(
					limitError(`response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`, {
						limit: MAX_RESPONSE_BODY_BYTES,
					}),
				),
				code: "BUSYCLAW_LIMIT_EXCEEDED",
			},
			ok: false,
		};
		return new Response(JSON.stringify(refusal), {
			status: 413,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}
	return new Response(body, {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...(init?.headers ?? {}),
		},
	});
}

function statusForError(error: unknown): number {
	if (error instanceof BusyclawError) {
		if (error.code === "BUSYCLAW_VALIDATION_FAILED") return 400;
		if (error.code === "BUSYCLAW_UNSUPPORTED_OPERATION") return 400;
		// An app-authz denial (the principal floor / owner∪scope∪grant PEP throws this) is a Forbidden —
		// NOT a masked 500. Without this a fail-closed governed call reads as a server error on the wire
		// (tripping error alarms / client retries) instead of the deliberate deny it is.
		//
		// R-M14. Except when there was no caller at all: that is 401, because it is the one denial the
		// client can DO something about. Collapsed into 403, a lost session was indistinguishable from a
		// permission the caller never had, so a client had no signal to clear what it was still showing.
		if (error.code === "BUSYCLAW_AUTHORIZATION_DENIED") {
			return error.details?.unauthenticated === true ? 401 : 403;
		}
		// A refused budget is Payload Too Large, not a masked 400 — the distinction is actionable:
		// 400 invites the caller to fix the value and send it again, 413 tells them the same value
		// will be refused again however well-formed it is.
		if (error.code === "BUSYCLAW_LIMIT_EXCEEDED") return 413;
	}
	if (error instanceof SyntaxError) return 400;
	return 500;
}

/**
 * M-08. Every failure returned its own message, so an exception nobody wrote for a caller — a driver
 * error carrying a fragment of SQL, a `TypeError` naming an internal field, a provider failure
 * echoing the content it choked on — was handed to whoever made the request. That is free
 * reconnaissance, and on a redacting deployment it can carry the very values redaction exists to keep
 * off the wire.
 *
 * The split is authorship. A `BusyclawError` was WRITTEN to be read by a caller: it names a stable
 * code, its message describes the caller's own situation, and telling them is the point. Anything
 * else is an accident of the internals, and the caller gets a fixed sentence plus a correlation id
 * — enough to quote in a support request, and nothing else. The real error goes to `onError`, which
 * is where an operator can see it without it crossing the boundary.
 */
function errorResponse(
	error: unknown,
	status = statusForError(error),
	report?: (id: string, error: unknown) => void,
): Response {
	// BusyclawError failures carry their stable code onto the wire — the client surfaces it as
	// `error.code` so callers can branch on the code instead of matching message text.
	if (error instanceof BusyclawError) {
		return json(
			{ error: { message: errorMessage(error), code: error.code }, ok: false },
			{ status },
		);
	}
	// A string is the adapter's own literal ("not found", "method not allowed") — authored here, so
	// it is as caller-facing as a BusyclawError.
	if (typeof error === "string") {
		return json({ error: { message: error }, ok: false }, { status });
	}
	const id = correlationId();
	report?.(id, error);
	return json(
		{
			error: {
				message: "internal error",
				code: "BUSYCLAW_INTERNAL_ERROR",
				correlationId: id,
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

/**
 * A mounted route.
 *
 * The handler may also return a platform `Response` directly, which `BusyclawRoute` cannot say:
 * @busyclaw/contracts compiles with no DOM lib — deliberately, so it stays importable from anywhere
 * — and therefore cannot name the type. Widened HERE, where `Response` exists and where the
 * pass-through in `resultToResponse` already handles it. Plugin routes keep the narrow contract;
 * this is for the handful of routes this package mounts itself and hands a vendor-built body.
 */
type ResolvedRoute = Omit<BusyclawRoute<Claw>, "handler"> & {
	id: string;
	handler: (
		ctx: Parameters<BusyclawRoute<Claw>["handler"]>[0],
	) => BusyclawRouteResult | Response | Promise<BusyclawRouteResult | Response>;
};

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

/**
 * Could one request path satisfy BOTH patterns? Same segment count, and at every position either
 * the literals agree or one side is a parameter that would swallow the other's literal.
 *
 * M-17. Comparing normalized SHAPES catches `/x/:a` against `/x/:b`, but not `/c/:provider/hook`
 * against `/c/app/:key` — different shapes, yet `/c/app/hook` matches both, and which handler ran
 * came down to which plugin registered first. Two routes reached by one URL is not a preference to
 * be resolved by ordering: the pair may carry different authorization, so the answer to "who may
 * call this" would depend on load order.
 */
function patternsOverlap(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((segment, index) => {
		const other = b[index];
		if (other === undefined) return false;
		return (
			segment.startsWith(":") || other.startsWith(":") || segment === other
		);
	});
}

function checkRouteConflicts(routes: readonly ResolvedRoute[]): void {
	const seen = new Map<string, string>();
	for (const route of routes) {
		const key = conflictKey(route);
		const previous = seen.get(key);
		if (previous) {
			throw configurationError("busyclaw route conflict", {
				route: route.id ?? key,
				previous,
				key,
			});
		}
		seen.set(key, route.id);
	}

	// Patterns only. A STATIC path overlapping a pattern is not ambiguous — the dispatcher tries the
	// literal map first and only falls through to patterns on a miss, so the literal always wins and
	// that is a defined rule rather than an accident of ordering.
	const patterns = routes
		.filter((route) => isPattern(route.path))
		.map((route) => ({
			route,
			segments: normalizePath(route.path).split("/"),
		}));
	for (let i = 0; i < patterns.length; i++) {
		for (let j = i + 1; j < patterns.length; j++) {
			const left = patterns[i];
			const right = patterns[j];
			if (!left || !right) continue;
			if (left.route.method !== right.route.method) continue;
			if (!patternsOverlap(left.segments, right.segments)) continue;
			throw configurationError("busyclaw ambiguous route patterns", {
				route: right.route.id,
				previous: left.route.id,
				paths: [left.route.path, right.route.path],
			});
		}
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

/**
 * The media types a browser can send cross-site from a plain HTML form, with no preflight and no
 * cooperation from the target. `application/json` is NOT among them — asking for it is what turns a
 * silent cross-site POST into a CORS preflight the browser will refuse on its own.
 */
const SIMPLE_REQUEST_TYPES = new Set([
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"text/plain",
]);

/**
 * M-10. Bodied requests were parsed media-type-blind: the body was read and `JSON.parse`d whatever
 * the sender called it. A cross-site HTML form can POST `text/plain` containing valid JSON, and a
 * host that authenticates from an ambient cookie would then have executed it as the logged-in user —
 * CSRF, with no script on the attacker's page.
 *
 * Requiring a JSON content type removes that shape entirely, because a browser cannot send one
 * cross-site without first asking permission. It is not a substitute for an Origin check on a
 * cookie-authenticated deployment; see `resolveCaller`, which is where a host has the request in
 * hand and can make that call.
 */
function assertJsonContentType(
	request: BusyclawRouteRequest,
	hasBody: boolean,
): void {
	// R-M13. A body is not DECLARED by a header — it is sent. This used to return early whenever the
	// content-type was absent, on the reasoning that "no body was declared, so nothing was parsed as
	// one" — but the very next line read the body and JSON.parsed it regardless. A cross-site form
	// POST that simply omits the header therefore sailed past the guard and executed as the logged-in
	// user: exactly the shape the guard exists to remove, reachable by leaving something OUT.
	//
	// So the question is asked about what arrived, not about what was claimed.
	const header = request.headers.get("content-type");
	// A DECLARED TYPE IS ANSWERED FOR EVEN WHEN THE BODY IS EMPTY, which is the half this missed.
	//
	// Returning early on "no bytes arrived" reasoned that nothing was parsed as a body. True, and
	// beside the point: the ROUTE still runs, with `{}` as its input, and a method whose fields are
	// all optional then performs its action. `createClaw` is exactly that method — so a cross-site
	// `<form method=post>` with no fields created a claw as the logged-in user. No script, no
	// preflight, because form-urlencoded is a simple request.
	//
	// An HTML form cannot omit its encoding; submitting one always declares
	// `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`. So the presence of a
	// content type is what separates "a browser sent this" from "a client POSTed nothing", and the
	// check follows that line: a declared type is checked whatever the body length, and a request with
	// neither header nor body stays uncollateralised — which is what the case below is about.
	if (!hasBody && (header === null || header === "")) return;
	if (header === null || header === "") {
		throw validationError(
			"unsupported content type",
			"a request body requires an explicit application/json content type",
		);
	}
	const media = header.split(";")[0]?.trim().toLowerCase() ?? "";
	if (media === "application/json" || media.endsWith("+json")) return;
	throw validationError(
		"unsupported content type",
		SIMPLE_REQUEST_TYPES.has(media)
			? `${media} cannot be sent cross-site without preflight, so it is refused here — send application/json`
			: `expected application/json, received ${media}`,
	);
}

/**
 * A query string carries only strings, so a route declaring a NUMBER cannot be called through the
 * flat-pair form without this.
 *
 * `readInput` accepts two representations of the same GET input — an `input=<json>` blob and flat
 * query pairs — and they were not equivalent: `?limit=2` arrived as `"2"` and was refused with "limit
 * must be a number", which is a confusing thing to tell somebody who sent 2. `listMessages` is the
 * route that has it, and pagination is exactly what its own docs say to use rather than "read the
 * whole transcript to reach the last two rows".
 *
 * COERCED ONLY WHERE THE SCHEMA LEAVES NO CHOICE — a property that permits a number and NOT a string.
 * Then a string is definitely not what the field wants, and the caller can only have meant the
 * declared type. A field accepting `string | number` is left alone, because there the string might be
 * exactly what was intended and guessing would change meaning. That rule is why this reads the
 * route's own schema instead of sniffing values: `?id=123` on a string field stays the string "123".
 */
function coerceQueryInput(
	input: Record<string, string>,
	schema: ClawApiInputSchema | undefined,
): Record<string, unknown> {
	if (schema === undefined) return input;
	const properties = declaredProperties(schema);
	if (properties === undefined) return input;
	const out: Record<string, unknown> = { ...input };
	for (const [key, value] of Object.entries(input)) {
		const wants = permitted(properties[key]);
		if (wants.has("string")) continue;
		if (wants.has("number") || wants.has("integer")) {
			const asNumber = Number(value);
			if (value.trim() !== "" && Number.isFinite(asNumber)) out[key] = asNumber;
			continue;
		}
		if (wants.has("boolean") && (value === "true" || value === "false")) {
			out[key] = value === "true";
		}
	}
	return out;
}

/**
 * The route schema's properties, as JSON Schema — or nothing, when it cannot say.
 *
 * `ClawApiInputSchema` is declared as a plain validating function, so `toJsonSchema` is not on the
 * type even though every schema the route table holds is an arktype Type that has it. Detected
 * rather than asserted: a schema that cannot describe itself simply gets no coercion, which is the
 * behaviour this had before and the safe direction to fail in.
 */
function declaredProperties(
	schema: ClawApiInputSchema,
): Record<string, unknown> | undefined {
	if (!("toJsonSchema" in schema)) return undefined;
	const render = schema.toJsonSchema;
	if (typeof render !== "function") return undefined;
	try {
		const json: unknown = render.call(schema, { fallback: () => ({}) });
		if (json === null || typeof json !== "object") return undefined;
		const properties = (json as { properties?: unknown }).properties;
		return properties !== null && typeof properties === "object"
			? (properties as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The JSON-Schema types a property permits, flattened across `anyOf` (how arktype renders a union
 *  with `undefined`). An unrenderable branch contributes nothing, which is the safe direction. */
function permitted(property: unknown): Set<string> {
	const found = new Set<string>();
	const visit = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		const shape = node as { type?: unknown; anyOf?: unknown };
		if (typeof shape.type === "string") found.add(shape.type);
		if (Array.isArray(shape.type)) {
			for (const entry of shape.type)
				if (typeof entry === "string") found.add(entry);
		}
		if (Array.isArray(shape.anyOf))
			for (const branch of shape.anyOf) visit(branch);
	};
	visit(property);
	return found;
}

async function readInput(
	request: BusyclawRouteRequest,
	method: ClawHttpMethod,
	schema?: ClawApiInputSchema,
): Promise<unknown> {
	if (method === "GET") {
		const search = new URL(request.url).searchParams;
		const encoded = search.get("input");
		// L-10. Two representations were accepted — an `input=<json>` blob and flat query pairs — and
		// nothing said what a request carrying both, or a repeated key, meant. Whichever the parser
		// happened to prefer decided it, so a proxy or client that appended a duplicate could change
		// the input a validated request carried without changing what a reader of the URL would see.
		if (encoded !== null) {
			if (search.getAll("input").length > 1) {
				throw validationError(
					"ambiguous request input",
					"`input` appears more than once",
				);
			}
			const extra = [...search.keys()].filter((key) => key !== "input");
			if (extra.length > 0) {
				throw validationError(
					"ambiguous request input",
					`\`input\` cannot be combined with query parameters (${extra.join(", ")})`,
				);
			}
			// A GET carries its input in the URL, so the same ceiling applies to a different carrier.
			if (encoded.length > MAX_REQUEST_BODY_BYTES) {
				throw limitError(
					`request input exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
					{
						limit: MAX_REQUEST_BODY_BYTES,
					},
				);
			}
			return JSON.parse(encoded) as unknown;
		}
		const keys = [...search.keys()];
		const duplicated = keys.filter((key, index) => keys.indexOf(key) !== index);
		if (duplicated.length > 0) {
			throw validationError(
				"ambiguous request input",
				`repeated query parameters (${[...new Set(duplicated)].join(", ")})`,
			);
		}
		return coerceQueryInput(Object.fromEntries(search.entries()), schema);
	}
	// Read FIRST, then judge: the check needs to know whether a body actually arrived, and only the
	// read can answer that (content-length is absent under chunked encoding). Safe to do in this
	// order because `readRequestBody` is itself bounded — an oversized body is refused by the read,
	// not by anything downstream of it.
	const text = await readRequestBody(request);
	assertJsonContentType(request, text.length > 0);
	// Bounded on DEPTH as well as bytes, and for the same reason: a body can be too much without
	// being long. `parseRequestBody` refuses a nested one before the value reaches anything that
	// walks it recursively — schema validation clones the input, and a deep enough body exhausted
	// the stack there and surfaced as a 500 on a request somebody chose to send.
	return text ? parseRequestBody(text) : {};
}

/**
 * Frame an async iterable of events as `text/event-stream`.
 *
 * The headers are not decoration. `no-cache` stops a CDN or the browser serving a replay of a live
 * stream; `X-Accel-Buffering: no` is what keeps nginx from holding the response until it has enough
 * bytes to be worth forwarding, which turns a live stream into a batch delivered at the end.
 *
 * `id:` carries the producer's cursor, so the browser's automatic reconnect arrives with
 * `Last-Event-ID` and the route can resume exactly where it stopped. Without it SSE is just a slow
 * download.
 */
function sseResponse(events: AsyncIterable<ServerSentEvent>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const event of events) {
					let frame = "";
					if (event.id !== undefined) frame += `id: ${event.id}\n`;
					if (event.event !== undefined) frame += `event: ${event.event}\n`;
					frame += `data: ${JSON.stringify(event.data)}\n\n`;
					controller.enqueue(encoder.encode(frame));
				}
			} catch (error) {
				// The stream is already open, so the status line is long gone — an error can only be
				// DELIVERED, never returned. A named event lets a client tell "the server gave up" from
				// "the connection dropped", which decide different things: the first is not worth an
				// automatic retry, the second is exactly what reconnect is for.
				controller.enqueue(
					encoder.encode(
						`event: error\ndata: ${JSON.stringify({ message: errorMessage(error) })}\n\n`,
					),
				);
			} finally {
				controller.close();
			}
		},
	});
	return new Response(body, {
		headers: {
			// `no-store` for the reason L-11 gives about every other response here: a stream is a
			// PER-CALLER answer — somebody's transcript, live — and a shared cache that keeps it is
			// holding one user's conversation where another user's request may reach it. `no-cache`
			// alone permits exactly that: it requires revalidation before REUSE, not refusal to STORE.
			//
			// The rule already had a considered exception (the OpenAPI document, which is the same for
			// everyone and says `max-age` for itself). This path was not an exception, it was just the
			// one built somewhere other than `json()`, which is where the rule was written down.
			//
			// The rest of the set stays as it was, and each earns its place: `no-cache` still stops a
			// browser or CDN replaying a live stream, `no-transform` stops a proxy rewriting the frames,
			// and `X-Accel-Buffering: no` is what keeps nginx from holding the response until it has
			// enough bytes to be worth forwarding — which turns a live stream into a batch at the end.
			"Cache-Control": "no-store, no-cache, no-transform",
			Connection: "keep-alive",
			"Content-Type": "text/event-stream; charset=utf-8",
			"X-Accel-Buffering": "no",
		},
	});
}

function resultToResponse(result: unknown): Response {
	// A RAW `Response` OWNS ITSELF — headers, status and body — and neither the response ceiling nor
	// the `no-store` default applies to it. That is the point of returning one: a download, a redirect,
	// a content type this layer does not know about, a body streamed rather than assembled. Bounding a
	// stream would mean buffering it, which is the opposite of what it was for.
	//
	// Stated here because it is otherwise invisible: a plugin handing back a `Response` has opted out
	// of L-11 as well, so a per-caller answer sent this way needs its own `Cache-Control`. Everything
	// built from `{ body, status, headers }` goes through `json()` and keeps both guarantees.
	if (result instanceof Response) return result;
	if (result && typeof result === "object" && "sse" in result) {
		const streamed = (result as { sse?: AsyncIterable<ServerSentEvent> }).sse;
		if (streamed !== undefined) return sseResponse(streamed);
	}
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
				const input = parseClawApiInput(
					name,
					await readInput(request, method, apiRoute.inputSchema),
				);
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
): BusyclawPlugin[] {
	return [...(claw.$context?.plugins ?? []), ...(options.plugins ?? [])];
}

function cronTasksFrom(plugins: readonly BusyclawPlugin[]): BusyclawCronTask[] {
	return plugins.flatMap((plugin) => [...(plugin.cron ?? [])]);
}

async function runCronTasks(input: {
	claw: Claw;
	limit?: number;
	request: BusyclawRouteRequest;
	tasks: readonly BusyclawCronTask[];
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
								cronHandler.headerName ?? "x-busyclaw-cron-secret";
							// CONSTANT-TIME, like the webhook secret it is a sibling of. `!==` short-circuits
							// at the first differing byte, which is what lets a secret be walked out one
							// character at a time; the codebase had already decided that for channels and
							// this door simply never got the decision.
							if (
								"secret" in cronHandler &&
								!constantTimeEquals(
									request.headers.get(headerName),
									cronHandler.secret,
								)
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
		watchRoute({
			id: "api:watchThread",
			path: "/threads/:threadId/watch",
			param: "threadId",
			call: (claw, id, since, caller) =>
				claw.api.watchThread(
					{ threadId: id, ...(since ? { since } : {}) },
					caller,
				),
		}),
		// The no-thread case — cron work, a subagent — and the narrower view of one turn inside a
		// conversation. Same framing, same cursor, different subscription unit.
		watchRoute({
			id: "api:watchRun",
			path: "/runs/:runId/watch",
			param: "runId",
			uiMessageStream: true,
			call: (claw, id, since, caller) =>
				claw.api.watchRun({ runId: id, ...(since ? { since } : {}) }, caller),
		}),
		...apiRoutes(),
	];
}

/**
 * The wire form of a watch: `GET …/watch` framing whatever the api method yields.
 *
 * A BRIDGE, not a second door. It resolves nothing and decides nothing — the api method runs the
 * same PEP check it runs in-process, so a stranger is denied here for exactly the reason they are
 * denied there, and every authorization property of watching stays testable with no server.
 *
 * `Last-Event-ID` is read from the request and passed as the cursor, which is what makes the
 * browser's own reconnect resume rather than replay. An explicit `?since=` wins over it, for a client
 * that tracks its own position (a mobile app, a poller, anything that is not an `EventSource`).
 *
 * Hand-written rather than generated from the route table because the watch methods are deliberately
 * excluded from it — a live stream has no RPC envelope, the same reason `stream` and
 * `sendMessageAndStream` are excluded. Parameterized so the thread and run forms cannot drift on the
 * framing, which is the part that is easy to get subtly wrong and invisible when you do.
 */
function watchRoute(spec: {
	id: string;
	path: string;
	param: string;
	/**
	 * Whether this watch serves the AI SDK UI message stream, and serves it BY DEFAULT.
	 *
	 * Only a single-run watch may: that protocol holds ONE assistant message, so a conversation
	 * cannot be sent down it.
	 */
	uiMessageStream?: boolean;
	call: (
		claw: Claw,
		id: string,
		since: string | undefined,
		caller: ClawApiCaller | undefined,
	) => Promise<AsyncIterable<RunStreamPage>>;
}): ResolvedRoute {
	return {
		id: spec.id,
		method: "GET",
		path: spec.path,
		handler: async ({ request, claw: routeClaw, caller, params }) => {
			const id = params[spec.param];
			if (id === undefined || id === "") {
				return {
					status: 404,
					body: {
						ok: false,
						error: { message: `no ${spec.param} in the path` },
					},
				};
			}
			const url = new URL(request.url);
			const since =
				url.searchParams.get("since") ??
				request.headers.get("last-event-id") ??
				undefined;
			// ONE ROUTE, TWO ENCODINGS. The subscription, its authorization and its cursor are
			// identical either way — only the framing differs — so this is a parameter rather than a
			// second endpoint that would have to keep all three in step.
			//
			// THE UI PROTOCOL IS THE DEFAULT where it is offered, and the reason is which mistake is
			// reachable. A chat client that forgot an opt-in would receive chunk JSON it does not
			// recognise and render NOTHING, silently, in somebody else's codebase. A first-party
			// client that needs chunks asks for them once, here, in code we own. Eliminate the
			// failure you cannot reach.
			const protocol = url.searchParams.get("protocol");
			const wantsUi =
				spec.uiMessageStream === true
					? protocol !== "chunks"
					: protocol === "ui";
			if (protocol === "ui" && spec.uiMessageStream !== true) {
				// REFUSED rather than silently served as chunks. A conversation cannot be a UI message
				// stream — its consumer keeps one `state.message`, and a second `start` renames that
				// message instead of opening another — so honouring this would merge every turn in the
				// thread into one. Say which endpoint does what.
				return {
					status: 400,
					body: {
						ok: false,
						error: {
							message:
								"protocol=ui serves ONE assistant message; watch a run rather than a thread",
						},
					},
				};
			}
			// AWAITED HERE, OUTSIDE THE STREAM, so a denial is an HTTP 401/403 with a JSON body rather
			// than a 200 whose first event happens to be an error. Once the status line is written the
			// refusal can only be narrated, never returned.
			const pages = await spec.call(routeClaw, id, since, caller);
			// The AI SDK's own writer builds this — headers, framing and terminator included — so a
			// protocol we do not own cannot drift from a copy of it kept here.
			if (wantsUi) {
				return watchToUIMessageStreamResponse({ runId: id, pages });
			}
			return {
				sse: (async function* frames() {
					for await (const page of pages) {
						// ONE EVENT PER PAGE, carrying the cursor that page ended at. Per-chunk events
						// would need a per-chunk cursor, and the port's cursor is per read — so a client
						// resuming mid-page would either lose chunks or see them twice.
						yield {
							id: page.cursor,
							event: page.stale ? "stale" : "chunks",
							data: page.chunks,
						};
						// A stale page is terminal: the client's cursor points past the log, so the
						// honest instruction is "reload the transcript", not more frames.
						if (page.stale) return;
					}
				})(),
			};
		},
	};
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
	return String(baseUrl ?? "/api/busyclaw").replace(/\/+$/, "");
}

function routeUrl(baseUrl: string, path: string): string {
	return `${baseUrl}${normalizePath(path)}`;
}

function withEncodedInput(url: string, input: unknown): string {
	const parsed = new URL(url, "http://busyclaw.local");
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
	// BOUNDED, through the same meter the request side uses. R-M12 capped what this server SENDS at
	// `MAX_RESPONSE_BODY_BYTES`; reading a peer's answer with a bare `text()` meant the cap did not
	// apply in the direction where the bytes are somebody else's choice. A server-to-server call is
	// exactly where that matters — the peer is another deployment, not a browser this process serves.
	//
	// The ceiling is this server's own egress ceiling: a well-behaved busyclaw cannot exceed it, so a
	// larger answer was never going to be usable. `readBoundedText` cancels at the limit, so an
	// over-long body costs the limit rather than the body.
	const envelope = parseEnvelope(
		await readBoundedText(
			response,
			MAX_RESPONSE_BODY_BYTES,
			"busyclaw response",
		),
	);
	// R-M14. Same rule the browser client follows: a body that is not an envelope is not an answer, on
	// any status. Returning `envelope?.data` for one meant a 200 carrying somebody else's JSON (a proxy
	// page, a rewritten route) resolved as a successful `undefined`.
	if (envelope === undefined) {
		throw new Error(
			response.ok
				? "busyclaw response was not a valid envelope"
				: `busyclaw request failed with status ${response.status}`,
		);
	}
	if (!envelope.ok) throw new Error(envelope.error.message);
	if (!response.ok) {
		throw new Error(`busyclaw request failed with status ${response.status}`);
	}
	return envelope.data;
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
					// The route's own schema goes in, for the same reason the api routes hand over theirs:
					// a GET carries its input in the query string, which has only strings, so a declared
					// number is unreachable without it. Wiring it once and not twice is exactly how this
					// door ended up different from the other one.
					const valid = route.input(
						await readInput(request, route.method, route.input),
					);
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
			// The one response on this surface that is NOT per-caller: it is generated once at
			// assembly and is identical for everyone, so it opts out of the `no-store` default rather
			// than making every reference UI re-fetch a document that cannot have changed.
			handler: () => ({
				body: document,
				headers: { "cache-control": "public, max-age=300" },
			}),
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
	const basePath = options.basePath ?? "/api/busyclaw";

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
			// the body. Absent resolver ⇒ no caller (the pre-seam default; the principal floor / owner check
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
			return errorResponse(error, statusForError(error), (id, raw) => {
				const report = {
					correlationId: id,
					error: raw,
					method,
					path: normalizedPath,
				};
				if (options.onError) {
					options.onError(report);
					return;
				}
				console.error(
					`busyclaw ${method} ${normalizedPath} failed [${id}]`,
					raw,
				);
			});
		}
	};
}

export type { Claw, ClawApi };
