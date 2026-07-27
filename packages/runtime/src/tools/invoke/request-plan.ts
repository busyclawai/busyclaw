// The request plan: the mechanical INVERSE of the extractor. `(binding, args)` → a concrete HTTP
// request DESCRIPTION, without performing it — a pure function, trivially testable. Credentials
// (credentials.ts) and the egress floor (../egress.ts) layer over the plan before it becomes a
// fetch; nothing here reaches the network.
//
// The model supplies only path/query/header/body VALUES. It never supplies the origin: that comes
// from `binding.server` alone, and path values are percent-encoded so a value like "../../x" or
// "a://b" stays inside its path segment and cannot escape into the authority or inject a query.

import type { JsonObject, JsonValue } from "@busyclaw/contracts";
import { configurationError } from "@busyclaw/contracts";
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
	return { origin: `${parsed.protocol}//${parsed.host}`, basePath };
}

/** The canonical origin of a server URL (default ports dropped, host lowercased). */
export function normalizeOrigin(server: string | undefined): string {
	return parseServer(server).origin;
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

	for (const [name, value] of Object.entries(args)) {
		if (value === undefined) continue;
		const parameter = byName.get(name);
		if (!parameter) {
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

	// Substitute {name} tokens in the path template; only declared path params are substituted, and
	// their values are already percent-encoded, so nothing escapes the segment it occupies.
	const operationPath = binding.path.replace(
		/\{([^}]+)\}/g,
		(whole, token: string) => pathValues.get(token) ?? whole,
	);
	const path = joinPath(basePath, operationPath);
	const queryString = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");
	const url = `${origin}${path}${queryString ? `?${queryString}` : ""}`;

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
 *  serialize as OpenAPI "simple" style (comma-joined), each element encoded. */
function encodePathValue(value: JsonValue): string {
	if (Array.isArray(value)) {
		return value
			.map((item) => encodeURIComponent(scalarString(item)))
			.join(",");
	}
	return encodeURIComponent(scalarString(value));
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
