// The one transport every surface rides — the base method table, the plugin-namespace proxy, and
// the `$fetch` handed to client plugins. Owns the wire conventions: GET sends `?input=<json>`
// (what the adapter's readInput expects), POST sends a JSON body, and every response is parsed
// against the contracts envelope — never cast. Resolves `{ data, error }`, never throws: a
// transport-level throw (DNS, abort, a broken injected fetch) becomes `error.status: 0`.

import type { ClawResponseEnvelope } from "@euroclaw/contracts/claw-api";
import { parseClawResponseEnvelope } from "@euroclaw/contracts/claw-api";
import type { EndpointHttpMethod } from "@euroclaw/contracts/governance/endpoints";
import { errorMessage } from "@euroclaw/errors";
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
	signal?: AbortSignal;
};

export type Transport = (
	request: TransportRequest,
) => Promise<ClawResult<unknown>>;

function normalizeBaseUrl(baseUrl: string | URL | undefined): string {
	return String(baseUrl ?? "/api/euroclaw").replace(/\/+$/, "");
}

// A relative base url ("/api/euroclaw") still needs URL's parsing to encode the input param — the
// throwaway origin makes it absolute for parsing and is stripped again for relative callers.
function withEncodedInput(url: string, input: unknown): string {
	const parsed = new URL(url, "http://euroclaw.local");
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
	if (!response.ok || envelope?.ok === false) {
		const error: ClawClientError = {
			status: response.status,
			message:
				envelope?.error?.message ??
				`euroclaw request failed with status ${response.status}`,
			...(envelope?.error?.code !== undefined
				? { code: envelope.error.code }
				: {}),
		};
		return { data: null, error };
	}
	return { data: envelope?.data, error: null };
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
			if (request.signal) init.signal = request.signal;
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
