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

export function normalizeBaseUrl(baseUrl: string | URL | undefined): string {
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

export async function resolveHeaders(
	headers: ClawClientOptions["headers"],
): Promise<Headers> {
	return new Headers(typeof headers === "function" ? await headers() : headers);
}

/**
 * How much of a response this client will hold before refusing it.
 *
 * THE MIRROR OF THE SERVER'S OWN CEILING. R-M12 bounded egress because "the cost of a request was
 * set by how much data the caller already had, not by anything the caller sent" — and the same
 * asymmetry runs one layer out: the server caps what it sends at 8MB, and the client capped nothing
 * it read back. `response.text()` resolves only once the WHOLE body is in memory, so a peer that
 * answers with more than it should — a compromised or simply broken server, a proxy substituting a
 * large error page, a gateway streaming junk — decided how much memory this process spent.
 *
 * Matched to the server's egress ceiling rather than invented: a well-behaved busyclaw server cannot
 * exceed it, so anything larger is not an answer this client was ever going to be able to use.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Refused, rather than a body — kept distinct from an empty body, which is a legitimate answer. */
const TOO_LARGE = Symbol("busyclaw:response-too-large");

/**
 * Read a response body as text, refusing to hold more than `maxBytes` of it.
 *
 * Metered while READING and cancelled at the limit, so an over-long body costs this client the limit
 * rather than the body — the same shape the server's own `readRequestBody` uses on the way in. The
 * `text()` fallback is for a fetch implementation that exposes no stream: the bytes are already
 * bought by the time it resolves, so the check there only stops the parse and everything after it.
 */
async function readBoundedText(
	response: Response,
	maxBytes: number,
): Promise<string | typeof TOO_LARGE> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		return TOO_LARGE;
	}
	const body = response.body;
	if (!body) {
		const text = await response.text();
		return text.length > maxBytes ? TOO_LARGE : text;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) return TOO_LARGE;
			// Decoded as it arrives rather than concatenated and decoded at the end, so the peak holds
			// the string OR the bytes, never both. `stream: true` holds back a trailing partial
			// sequence until the chunk completing it arrives.
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
		// Tell the peer to stop sending the rest of a body already refused. Its own failure must not
		// replace the refusal on the way out.
		if (size > maxBytes) await body.cancel().catch(() => {});
	}
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
	const body = await readBoundedText(response, MAX_RESPONSE_BYTES);
	const envelope = body === TOO_LARGE ? undefined : envelopeOf(body);
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
	if (body === TOO_LARGE) {
		// Named for what it is, so a caller can tell "the peer sent too much" from "the peer sent
		// nonsense" — different problems with different fixes.
		return fail(
			`busyclaw response exceeds ${MAX_RESPONSE_BYTES} bytes`,
			"BUSYCLAW_LIMIT_EXCEEDED",
		);
	}
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
