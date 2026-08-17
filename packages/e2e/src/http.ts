/**
 * THE BOUNDARY — a claw reached the way the internet reaches it.
 *
 * Everything else in this package calls `claw.api.method(input, { principal })` in process, which
 * skips three things that only exist over the wire: `resolveCaller` turning a request into an
 * identity, the arktype input schemas (they are wired into the ROUTE, not the method — a direct call
 * is trusted to TypeScript), and route dispatch itself.
 *
 * That is the surface untrusted input actually arrives on, and it is the one with a track record:
 * the identity seam and the adapter's 403s were both audit findings. So it gets its own harness.
 */

import { toRequestHandler } from "@busyclaw/adapter-core";
import type { ClawApiCaller } from "@busyclaw/contracts";
import type { ClawApiRouteDefinition } from "busyclaw";
import { type Claw, clawApiRouteList } from "busyclaw";

export const BASE = "https://app.test/api/busyclaw";

/** The caller a host resolves from a request — `{ principal }` built by `userPrincipal(id)`, since
 *  `Principal` is branded and a bare string is not one. */
export type Caller = ClawApiCaller | undefined;

/**
 * A fetch handler over `claw`, with the identity seam a host supplies.
 *
 * `resolveCaller` omitted models the unauthenticated deployment — the doc for it promises
 * fail-closed: "absent, or returning `undefined` ... means no principal — so the principal floor
 * DENIES every governed core api call with a 403".
 */
export function httpFor(
	claw: Claw,
	caller?: () => Caller,
): (request: Request) => Promise<Response> {
	return toRequestHandler(
		claw,
		caller === undefined ? {} : { resolveCaller: () => caller() },
	);
}

/** Every governed api route, with its real path and method — read from the shipped table. */
export const ROUTES: readonly ClawApiRouteDefinition[] = clawApiRouteList;

/** Build the request a route expects: a body for writes, a query string for reads. */
export function requestFor(
	route: ClawApiRouteDefinition,
	input: Record<string, unknown>,
	init: RequestInit = {},
): Request {
	const url = new URL(`${BASE}${route.path}`);
	if (route.httpMethod === "GET") {
		for (const [key, value] of Object.entries(input)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return new Request(url, { method: "GET", ...init });
	}
	return new Request(url, {
		method: route.httpMethod,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		body: JSON.stringify(input),
		...init,
	});
}
