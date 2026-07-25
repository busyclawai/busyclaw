// The GOVERNED guest fetch: the in-tree `fetchAdapter` a host wires when sandboxed code needs the
// network, so reaching for the network does not mean hand-rolling the floor.
//
// Why this exists as shipped code rather than documentation. The guest has no network stack of its
// own — QuickJS is a wasm interpreter with no sockets and no DNS — so every byte it sends leaves
// through a HOST function, and the provider only turns fetch on at all when a host supplies one
// (`allowFetch` follows the adapter's presence). That makes the adapter the single door, which is
// the good news; the bad news is that nothing checks what the door does. A host that reaches for
// sandbox networking and passes `fetch` straight through gets a guest that can read
// 169.254.169.254, 127.0.0.1, and every host on the private network, with no error and no audit
// trail. The floor exists (@euroclaw/egress); it was simply not reachable without knowing to call
// it. This is that call, written once.
//
// NOT default-on, deliberately. Absent an adapter the guest is airgapped, and that stays the
// default — a sandbox that silently gains the network because a helper shipped would be a weaker
// posture, not a stronger one. What changes is that opting IN no longer means opting out of the
// floor: the safe path is now the short one.

import { configurationError } from "@euroclaw/contracts";
import type { EgressLookup } from "@euroclaw/egress";
import {
	assertEgressAllowedOnNode,
	pinnedConnection,
} from "@euroclaw/egress/node";
import type { SandboxFetch } from "./core/contracts";

export type GovernedFetchOptions = {
	/** Allow http targets (localhost dev / tests). Default false — https only. */
	allowInsecure?: boolean;
	/** DNS override for the floor (tests inject a fake; hosts can pin). Default node:dns. */
	lookup?: EgressLookup;
	/** Response body byte cap. The body crosses into the guest, so it is bounded like any other
	 *  untrusted input. Default 1 MB. */
	maxResponseBytes?: number;
	/** Per-request deadline. Default 30 s. */
	timeoutMs?: number;
	/** Injected for tests; defaults to the platform global `fetch`. */
	fetch?: typeof fetch;
};

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Read a body under a byte cap, without buffering past it. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let out = "";
	let seen = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		seen += value.byteLength;
		if (seen > maxBytes) {
			await reader.cancel();
			throw configurationError("sandbox fetch response exceeded the byte cap", {
				maxResponseBytes: maxBytes,
			});
		}
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}

/**
 * Build the governed `fetchAdapter` for `ExecutionContext`: the egress floor (https-only, SSRF range
 * rejection, resolve-once) plus the pin that makes the vetted address the one actually dialled, plus
 * the bounds any untrusted response needs.
 *
 * The guest hands a URL across as a STRING, so the whole resolve-and-connect sequence happens here,
 * host-side — the guest never gets a socket to aim somewhere else. A blocked target throws, and the
 * throw surfaces to the model as an ordinary error value it can read and adapt to.
 *
 * Redirects are never followed: a 3xx to a private host would walk straight around the floor, so the
 * response is returned as-is and the guest may choose to request the new location explicitly, which
 * re-runs the floor on it.
 */
export function governedFetch(
	options: GovernedFetchOptions = {},
): SandboxFetch {
	const fetchImpl = options.fetch ?? fetch;
	const maxResponseBytes =
		options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return async (input, init) => {
		const url = typeof input === "string" ? input : input.href;
		const decision = await assertEgressAllowedOnNode(url, {
			...(options.allowInsecure !== undefined
				? { allowInsecure: options.allowInsecure }
				: {}),
			...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
		});

		const request = (init ?? {}) as RequestInit;
		const pin = pinnedConnection(decision);
		let response: Response;
		try {
			response = await fetchImpl(url, {
				...request,
				// A 3xx is DATA here, never a hop — see above.
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
				// Non-standard RequestInit field the built-in (undici-backed) fetch reads: carries the pin.
				dispatcher: pin.dispatcher,
			} as RequestInit);
		} catch (error) {
			await pin.close().catch(() => undefined);
			throw error;
		}
		try {
			// A plain, structured value — the guest reads it as data, never as a live Response object
			// (nothing streamable or closeable crosses the wasm boundary).
			return {
				status: response.status,
				statusText: response.statusText,
				headers: Object.fromEntries(response.headers.entries()),
				body: await readCapped(response, maxResponseBytes),
			};
		} finally {
			await pin.close().catch(() => undefined);
		}
	};
}
