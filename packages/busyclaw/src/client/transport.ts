// The one transport every surface rides — the base method table, the plugin-namespace proxy, and
// the `$fetch` handed to client plugins. Owns the wire conventions: GET sends `?input=<json>`
// (what the adapter's readInput expects), POST sends a JSON body, and every response is parsed
// against the contracts envelope — never cast. Resolves `{ data, error }`, never throws: a
// transport-level throw (DNS, abort, a broken injected fetch) becomes `error.status: 0`.

import type { AbortLifetime } from "@busyclaw/contracts";
import type { ClawResponseEnvelope } from "@busyclaw/contracts/claw-api";
import { parseClawResponseEnvelope } from "@busyclaw/contracts/claw-api";
import type { EndpointHttpMethod } from "@busyclaw/contracts/governance/endpoints";
import { errorMessage } from "@busyclaw/errors";
import type {
	ClawClientError,
	ClawClientOptions,
	ClawClientRequest,
	ClawResult,
} from "./types";

export type TransportRequest = {
	/** Route path relative to the base url (e.g. `/list-approvals`). */
	path: string;
	method: EndpointHttpMethod;
	input?: unknown;
	/** The PROTOCOL's {@link AbortLifetime}, not `AbortSignal` — @busyclaw/contracts builds without the
	 *  DOM lib on purpose, so the shared client-plugin vocabulary cannot name one. A real signal
	 *  satisfies it and is passed straight through; see {@link toAbortSignal}. */
	signal?: AbortLifetime;
};

/**
 * Bridge a protocol {@link AbortLifetime} to the real `AbortSignal` `fetch` requires.
 *
 * A real signal passes straight through. Anything else — a structural lifetime from a host with no
 * DOM globals — gets a controller wired to it, so it actually aborts the request. The alternative
 * was a cast, which types fine and then silently does nothing when the value is not a real signal:
 * a caller would pass an abort and watch the request run to completion with no error anywhere.
 */
function toAbortSignal(lifetime: AbortLifetime): AbortSignal {
	if (lifetime instanceof AbortSignal) return lifetime;
	const controller = new AbortController();
	if (lifetime.aborted) controller.abort();
	else lifetime.addEventListener("abort", () => controller.abort());
	return controller.signal;
}

export type Transport = (
	request: TransportRequest,
) => Promise<ClawResult<unknown>>;

function normalizeBaseUrl(baseUrl: string | URL | undefined): string {
	return String(baseUrl ?? "/api/busyclaw").replace(/\/+$/, "");
}

// A relative base url ("/api/busyclaw") still needs URL's parsing to encode the input param — the
// throwaway origin makes it absolute for parsing and is stripped again for relative callers.
function withEncodedInput(url: string, input: unknown): string {
	const parsed = new URL(url, "http://busyclaw.local");
	parsed.searchParams.set("input", JSON.stringify(input ?? {}));
	if (/^https?:\/\//.test(url)) return parsed.toString();
	return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function resolveHeaders(
	headers: ClawClientOptions["headers"],
): Promise<Headers> {
	return new Headers(typeof headers === "function" ? await headers() : headers);
}

function envelopeOf(text: string): ClawResponseEnvelope | undefined {
	if (!text) return undefined;
	try {
		return parseClawResponseEnvelope(JSON.parse(text));
	} catch {
		// Not JSON (a proxy/gateway error page, say) — the HTTP status drives the error below.
		return undefined;
	}
}

async function readResult(response: Response): Promise<ClawResult<unknown>> {
	const envelope = envelopeOf(await response.text());
	const fail = (message: string, code?: string): ClawResult<unknown> => ({
		data: null,
		error: {
			status: response.status,
			message,
			...(code !== undefined ? { code } : {}),
		},
	});
	// R-M14. A body that is not an envelope is not an answer — on ANY status. It used to be treated as
	// one on 2xx: every envelope field was optional, so any JSON object (a proxy's health blob, a
	// rewritten route's index page, a gateway that swallowed the call and answered 200) validated,
	// reported `ok` as undefined, and reached the caller as a data-less SUCCESS. Callers then rendered
	// "no results" for a request that never reached the server.
	if (envelope === undefined) {
		return fail(
			response.ok
				? "busyclaw response was not a valid envelope"
				: `busyclaw request failed with status ${response.status}`,
		);
	}
	if (!envelope.ok) return fail(envelope.error.message, envelope.error.code);
	// A well-formed success envelope under a non-2xx is still a failure — the status is the transport's
	// answer and it outranks the body's claim about itself.
	if (!response.ok) {
		return fail(`busyclaw request failed with status ${response.status}`);
	}
	return { data: envelope.data, error: null };
}

export function createTransport(options: ClawClientOptions): Transport {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	return async (request) => {
		try {
			const headers = await resolveHeaders(options.headers);
			const target = `${baseUrl}${request.path}`;
			const init: RequestInit = { headers, method: request.method };
			let url = target;
			if (request.method === "GET") {
				url = withEncodedInput(target, request.input);
			} else {
				headers.set("content-type", "application/json");
				init.body = JSON.stringify(request.input ?? {});
			}
			if (request.signal) init.signal = toAbortSignal(request.signal);
			const context: ClawClientRequest = {
				init,
				method: request.method,
				path: request.path,
				url,
			};
			await options.onRequest?.(context);
			const response = await fetchImpl(context.url, context.init);
			await options.onResponse?.({ ...context, response });
			return await readResult(response);
		} catch (error) {
			return {
				data: null,
				error: { message: errorMessage(error), status: 0 },
			};
		}
	};
}
