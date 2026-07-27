// The NODE binding for the egress floor — the one place node:dns and a pinning dispatcher are bound.
//
// The root entry (`@busyclaw/egress`) stays runtime-agnostic on purpose: it ships no DNS resolver, so
// it runs anywhere and the caller injects resolution. But two consumers — the runtime's HTTP tool
// invoker and the sandboxes plugin's guest fetch — both run on Node and both need the same two Node
// things: a default resolver, and a way to make the socket dial the address the floor vetted. Kept in
// ONE subpath (the channels subpath-isolation precedent) rather than copied into each: a second copy
// of a security binding is a second thing to forget to update.
//
// Nothing from `undici` appears in this module's exported types — a caller receives an opaque
// `PinnedConnection`, so the dependency stops here instead of spreading across package boundaries.

import { lookup as dnsLookup } from "node:dns/promises";
import { Agent } from "undici";
import {
	assertEgressAllowed as assertEgressAllowedFloor,
	type EgressDecision,
	type EgressLookup,
	type EgressOptions,
} from "./index";

/** The runtime's default resolver — the one place node:dns is bound for egress. */
const nodeLookup: EgressLookup = async (hostname) => {
	const results = await dnsLookup(hostname, { all: true });
	return results.map((entry) => ({
		address: entry.address,
		family: entry.family,
	}));
};

/** Assert an egress target is allowed, defaulting DNS resolution to node:dns. Callers may still
 *  inject their own `lookup` (a caching / pinning resolver, or a test fake). */
export async function assertEgressAllowedOnNode(
	url: string,
	options: EgressOptions = {},
): Promise<EgressDecision> {
	return assertEgressAllowedFloor(url, {
		...options,
		lookup: options.lookup ?? nodeLookup,
	});
}

/** The node:dns `lookup` contract, narrowed to what the pinning resolver answers. */
export type PinnedLookup = (
	hostname: string,
	options: { all?: boolean } | undefined,
	callback: (
		err: Error | null,
		address: string | { address: string; family: number }[],
		family?: number,
	) => void,
) => void;

/**
 * The resolver behind the pin: answers the vetted address for ANY hostname it is asked about, because
 * the only name it is ever asked about is the one already vetted, and re-resolving it is precisely
 * the hole. Exported so the pinning rule is testable without opening a socket.
 */
export function pinnedLookup(decision: EgressDecision): PinnedLookup {
	return (_hostname, options, callback) => {
		// The node:dns contract has two shapes: `all` wants the list, otherwise (address, family).
		if (options?.all === true) {
			callback(null, [
				{ address: decision.pinnedAddress, family: decision.family },
			]);
			return;
		}
		callback(null, decision.pinnedAddress, decision.family);
	};
}

/** A connection strategy pinned to one vetted address. `dispatcher` is opaque — hand it to `fetch`
 *  as its `dispatcher` option; `close` releases the pooled socket. */
export type PinnedConnection = {
	readonly dispatcher: unknown;
	close: () => Promise<void>;
};

/**
 * Bind a connection to the address the floor already vetted — the half of the floor that only a
 * Node-side dispatcher can deliver.
 *
 * `assertEgressAllowed` resolves the host, range-checks every answer, and returns the winning
 * address. But `fetch` takes a URL, not an address: left alone it resolves the NAME again when it
 * opens the socket, and a second answer is not the one that was checked. An attacker who controls
 * the DNS for a name they got approved answers once with a public address (passes the floor) and
 * again with 127.0.0.1 or 169.254.169.254 (gets the socket) — classic rebinding, and the request
 * carries whatever credential was attached and returns the internal response to its caller. The
 * check and the connect must agree on ONE resolution; this is what makes them agree.
 *
 * The URL keeps its hostname, so TLS SNI and certificate validation are unchanged — only the address
 * the socket dials is fixed.
 *
 * A pin is valid for ONE decision, so this is built per request and `close`d once the body is read —
 * an Agent holds keep-alive sockets, and a per-request one that is never closed leaks them.
 */
export function pinnedConnection(decision: EgressDecision): PinnedConnection {
	const agent = new Agent({ connect: { lookup: pinnedLookup(decision) } });
	return {
		dispatcher: agent,
		close: () => agent.close(),
	};
}
