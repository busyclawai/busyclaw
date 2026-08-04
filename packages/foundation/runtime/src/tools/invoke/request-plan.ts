// The request plan: the mechanical INVERSE of the extractor. `(binding, args)` → a concrete HTTP
// request DESCRIPTION, without performing it — a pure function, trivially testable. Credentials
// (credentials.ts) and the egress floor (../egress.ts) layer over the plan before it becomes a
// fetch; nothing here reaches the network.
//
// The model supplies only path/query/header/body VALUES. It never supplies the origin: that comes
// from `binding.server` alone, and path values are percent-encoded so a value like "../../x" or
// "a://b" stays inside its path segment and cannot escape into the authority or inject a query.

import type {
	JsonObject,
	JsonValue,
	ToolDescriptor,
} from "@busyclaw/contracts";
import { configurationError } from "@busyclaw/contracts";
import { originOf } from "@busyclaw/egress";
import type {
	OpenApiBinding,
	OpenApiParameterBinding,
} from "../sources/openapi/binding";

export type HttpRequestPlan = {
	method: string;
	/** origin + substituted path + query string — the concrete request target. */
	url: string;
	headers: Record<string, string>;
	/** serialized JSON body, when the operation carries one. */
	body?: string;
	/** normalized origin (scheme://host[:port]) — the egress subject the floor + policy see. */
	origin: string;
};

/** Parse a server URL into its canonical origin (scheme + host, default ports dropped, host
 *  lowercased) and base path — the ONE guard + parse both `normalizeOrigin` and `planHttpRequest`
 *  share, so the origin the floor validates, the `context.server` policy fact, and the request
 *  target can never disagree. Throws when the server is absent/unparseable — an uninvokable tool. */
function parseServer(server: string | undefined): {
	origin: string;
	basePath: string;
} {
	if (server === undefined || server === "") {
		throw configurationError(
			"registered tool has no server — uninvokable (re-register the spec with a servers entry)",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(server);
	} catch {
		throw configurationError("registered tool server is not a valid URL", {
			server,
		});
	}
	// The server URL may carry a base path (https://api.x/v1); the operation path appends to it.
	const basePath =
		parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
	// The origin comes from the foundation helper, not a second copy of the same two-line join: the
	// floor, the sandbox and this all compare origins with each other, and a private version here
	// would be a difference nobody notices until a comparison silently stops matching.
	return { origin: originOf(server), basePath };
}

/** The canonical origin of a server URL (default ports dropped, host lowercased). */
export function normalizeOrigin(server: string | undefined): string {
	return parseServer(server).origin;
}

/**
 * The egress origin a descriptor DECLARES, or undefined when it declares none.
 *
 * The `context.server` policy fact comes from here — from the tool's own binding, never from caller
 * context, so neither the model nor a caller can forge a destination and a tool cannot target a
 * server it did not declare. A `local` closure has no declared reach at all: its outbound calls are
 * undescribed, so it carries no origin fact rather than a guessed one.
 *
 * Descriptors are the shape BOTH sides of the floor already speak — the static set built at assembly
 * and the per-run set a boundary registers through `resolveTools` — which is the point of extracting
 * it here. Reading the origin off rows in one place and descriptors in another is how the two drift,
 * and this fact decides whether egress policy fires.
 *
 * `binding` is `unknown` on the descriptor because contracts cannot name a provider's binding shape,
 * so this reads the one field it needs and ignores anything that does not carry it. An unparseable
 * server yields no fact rather than throwing: the tool is uninvokable anyway, and the floor asking
 * what a tool declares must not be the thing that fails the run.
 */
export function declaredOrigin(descriptor: ToolDescriptor): string | undefined {
	const invocation = descriptor.invocation;
	if (invocation.kind !== "binding") return undefined;
	const binding = invocation.binding;
	if (binding === null || typeof binding !== "object") return undefined;
	const server = (binding as { server?: unknown }).server;
	if (typeof server !== "string") return undefined;
	try {
		return normalizeOrigin(server);
	} catch {
		return undefined;
	}
}

/**
 * The origin THIS CALL reaches — a binding's fixed server, or the argument the descriptor declares
 * its destination lives in.
 *
 * One function for both, because they produce the SAME fact. `context.server` is the thing egress
 * policy is written about, and a policy that governed bound tools but silently skipped
 * argument-addressed ones would be the most misleading possible half — a rule that reads as
 * "wherever this claw reaches" and covers only the destinations that happen to be static.
 *
 * The argument's VALUE is caller-supplied, which is fine and is the point: the caller says where it
 * wants to go, and the floor decides whether it may. What is not caller-supplied is WHICH argument
 * carries a destination — that is declared by the tool's author, so a caller cannot nominate some
 * other field and have its contents believed.
 *
 * An unparseable or missing value yields no fact, and the guarded ceiling then REFUSES: an action
 * inside a governed source with no readable destination is exactly the case that must not slip
 * through. Failing to name where you are going is not permission to go.
 */
export function originOfCall(
	descriptor: ToolDescriptor,
	args: Record<string, unknown>,
): string | undefined {
	const arg = descriptor.governance.destination?.arg;
	if (arg !== undefined) {
		const value = args[arg];
		if (typeof value !== "string") return undefined;
		try {
			return originOf(value);
		} catch {
			return undefined;
		}
	}
	return declaredOrigin(descriptor);
}

/** Index a descriptor set by path → declared origin. Paths with no declared reach are absent, so a
 *  lookup miss and "declares nothing" are the same answer. */
export function declaredOrigins(
	descriptors: readonly ToolDescriptor[],
): Map<string, string> {
	const origins = new Map<string, string>();
	for (const descriptor of descriptors) {
		const origin = declaredOrigin(descriptor);
		if (origin !== undefined) origins.set(descriptor.path, origin);
	}
	return origins;
}

/** Turn a validated binding + flat args into a concrete HTTP request description. Pure. */
export function planHttpRequest(
	binding: OpenApiBinding,
	args: JsonObject,
): HttpRequestPlan {
	const { origin, basePath } = parseServer(binding.server);

	const byName = new Map<string, OpenApiParameterBinding>();
	for (const parameter of binding.parameters)
		byName.set(parameter.name, parameter);

	const pathValues = new Map<string, string>();
	const headers: Record<string, string> = {};
	const queryPairs: [string, string][] = [];
	// Own-key iteration + a plain accumulator built with fromEntries below — a model-authored key
	// like "__proto__" stays a body property, never a prototype write.
	const bodyEntries: [string, JsonValue][] = [];

	// M-05. Every argument that was not a declared parameter used to become a body field, so the
	// model decided the request's shape rather than the spec. A tool authorized to send
	// `{ title, body }` could send `{ title, body, role: "admin" }` — undeclared, unexamined,
	// straight into a request carrying the operation's credential. The generated schema said
	// otherwise, but a schema is what a model is TOLD; this is what happens.
	//
	// A wrapped body is the one case where the single `body` argument IS the payload and its interior
	// is the spec's business, not ours.
	const declaredBody = new Set(binding.bodyProperties ?? []);
	for (const [name, value] of Object.entries(args)) {
		if (value === undefined) continue;
		const parameter = byName.get(name);
		if (!parameter) {
			if (!binding.bodyWrapped && !declaredBody.has(name)) {
				throw configurationError(
					"registered tool received an argument the operation does not declare",
					{ argument: name },
				);
			}
			bodyEntries.push([name, value]);
			continue;
		}
		if (parameter.in === "path") {
			pathValues.set(name, encodePathValue(value));
		} else if (parameter.in === "header") {
			headers[name] = scalarString(value);
		} else {
			for (const pair of serializeQueryParameter(parameter, value)) {
				queryPairs.push(pair);
			}
		}
	}

	// Substitute {name} tokens in the path template; only declared path params are substituted.
	const operationPath = binding.path.replace(
		/\{([^}]+)\}/g,
		(whole, token: string) => pathValues.get(token) ?? whole,
	);
	const path = joinPath(basePath, operationPath);
	const queryString = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");
	const url = `${origin}${path}${queryString ? `?${queryString}` : ""}`;

	// R-H06. Percent-encoding stops a value BREAKING OUT of its segment — `/`, `?`, `#`, `:` all
	// encode — and that was taken to mean nothing could escape. But `encodeURIComponent` leaves `.`
	// untouched, so a value of `..` survives intact and is a RELATIVE segment: the URL canonicalizes
	// `/v1/files/..` to `/v1/`, and the model reaches a sibling route on the same origin while
	// keeping everything decided for the original operation — the policy verdict, the method, and
	// the credential attached to it. The egress floor sees nothing wrong because the origin never
	// changed. The floor authorized one operation; a different one is what runs.
	//
	// The check is the canonicalization itself. If normalizing the URL CHANGES the path we built,
	// something in it was not the literal path we meant to request — which covers `.` and `..` and
	// whatever else a future encoding rule leaves through, rather than a list of characters to keep
	// in step with the standard.
	const canonicalPath = new URL(url).pathname;
	if (canonicalPath !== path) {
		throw configurationError(
			"registered tool path arguments do not resolve to the registered route",
			{ registered: path, resolved: canonicalPath },
		);
	}

	const plan: HttpRequestPlan = {
		method: binding.method.toUpperCase(),
		url,
		headers,
		origin,
	};

	// The body: `bodyWrapped` means the single `body` arg IS the body; otherwise every non-parameter
	// arg is a body property. Content-Type comes from the binding, defaulting to JSON.
	if (binding.bodyWrapped) {
		if (args.body !== undefined) {
			plan.body = JSON.stringify(args.body);
			headers["content-type"] ??= binding.bodyContentType ?? "application/json";
		}
	} else if (bodyEntries.length > 0) {
		plan.body = JSON.stringify(Object.fromEntries(bodyEntries));
		headers["content-type"] ??= binding.bodyContentType ?? "application/json";
	}

	return plan;
}

/** Percent-encode a path value so `/`, `?`, `#`, `:` cannot break out of the path segment. Arrays
 *  serialize as OpenAPI "simple" style (comma-joined), each element encoded.
 *
 *  Encoding is not enough on its own: `.` and `..` pass through unchanged and are RELATIVE segments
 *  that canonicalization resolves away, taking the parent with them. Refused by name here so the
 *  caller gets a message about the argument they sent, rather than only the structural check after
 *  the URL is assembled — that check is the backstop, this is the explanation. */
function encodePathValue(value: JsonValue): string {
	if (Array.isArray(value)) {
		return value.map((item) => encodeOneSegment(item)).join(",");
	}
	return encodeOneSegment(value);
}

function encodeOneSegment(value: JsonValue): string {
	const encoded = encodeURIComponent(scalarString(value));
	if (encoded === "." || encoded === "..") {
		throw configurationError(
			"registered tool path argument is a relative path segment",
			{ value: encoded },
		);
	}
	return encoded;
}

/** Serialize a query parameter per its captured style/explode. Returns already-encoded k=v pairs.
 *  Defaults: `form` + explode (one pair per array element); `spaceDelimited`/`pipeDelimited` and
 *  non-explode `form` join into one pair with the style's delimiter (element values encoded). */
function serializeQueryParameter(
	parameter: OpenApiParameterBinding,
	value: JsonValue,
): [string, string][] {
	const key = encodeURIComponent(parameter.name);
	const style = parameter.style ?? "form";
	const explode = parameter.explode ?? style === "form";
	if (Array.isArray(value)) {
		const items = value.map((item) => encodeURIComponent(scalarString(item)));
		if (explode) return items.map((item) => [key, item]);
		const delimiter =
			style === "spaceDelimited"
				? "%20"
				: style === "pipeDelimited"
					? "|"
					: ",";
		return [[key, items.join(delimiter)]];
	}
	if (value !== null && typeof value === "object") {
		// deepObject/object query serialization is out of scope — carry it as an encoded JSON value.
		return [[key, encodeURIComponent(JSON.stringify(value))]];
	}
	return [[key, encodeURIComponent(scalarString(value))]];
}

/** Header/path/query scalar → string. Objects/arrays reaching here (header params) JSON-serialize. */
function scalarString(value: JsonValue): string {
	if (value === null) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function joinPath(basePath: string, operationPath: string): string {
	const suffix = operationPath.startsWith("/")
		? operationPath
		: `/${operationPath}`;
	return `${basePath}${suffix}`;
}
