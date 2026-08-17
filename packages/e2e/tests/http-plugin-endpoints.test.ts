/**
 * PLUGIN ENDPOINTS ARE A SECOND DOOR, MOUNTED BESIDE THE FIRST.
 *
 * They do not go through the api route table and they do not go through the PEP: `resolveCaller`'s
 * doc says an unauthenticated request at a plugin endpoint "falls to its own fail-closed owner
 * check". So every guarantee established for the core api has to be established again here, and the
 * ones that come from the adapter — input validation, query decoding — are the ones most likely to
 * have been wired once rather than twice.
 *
 * The endpoint below is defined HERE rather than borrowed from a shipped plugin on purpose: the
 * subject is the adapter's contract with any plugin, not one plugin's policy. A shipped plugin that
 * happens to avoid a shape proves nothing about the next plugin that does not.
 */

import type { ClawApiCaller } from "@busyclaw/contracts";
import { endpoints, route, userPrincipal } from "@busyclaw/contracts";
import { type } from "arktype";
import { afterEach, expect, it } from "vitest";
import { BASE, httpFor } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

/** What the handler was actually given, so a scenario can assert on it rather than on a status. */
const seen: { input?: unknown; principal?: unknown }[] = [];

const probeApi = endpoints({
	// NAMED `listPage` because the verb is derived from the NAME — `get*`/`list*` ride GET, everything
	// else POST (`endpoints.ts:98`). So the name is what puts this route's input in the query string,
	// which is the carrier that cannot express a number without help.
	listPage: route
		.input(type({ threadId: "string", "limit?": "number | undefined" }))
		.authz(null, "a probe endpoint that reads nothing shared")
		.handler(async (input: unknown, authz: ClawApiCaller) => {
			seen.push({ input, principal: authz?.principal });
			return { ok: true };
		}),
});

const probePlugin = {
	id: "e2e:probe",
	// `api` is a FACTORY the assembly calls with its context, not a plain object.
	api: () => ({ probe: probeApi }),
};

async function mounted() {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		principal: "user:alice",
		plugins: [probePlugin],
	});
	await w.api.createClaw({ id: "claw-1", name: "Assistant" });
	return w;
}

it("decodes a numeric query parameter the endpoint declares", async () => {
	// THE SAME BUG the core api had, on the door that did not get the fix: `pluginEndpointRoutes`
	// calls `readInput(request, route.method)` without handing over the route's schema, so nothing
	// knows `limit` wants a number and `"2"` is refused.
	//
	// A plugin author declaring a numeric field on a GET endpoint hits exactly what `listMessages`
	// hit, with less to go on — their schema is correct, their request looks correct, and the error
	// says the number they sent is not a number.
	seen.length = 0;
	const w = await mounted();
	open = w;
	const http = httpFor(w.claw, () => ({ principal: userPrincipal("alice") }));

	const response = await http(
		new Request(`${BASE}/probe/list-page?threadId=t&limit=2`),
	);
	expect(response.status).toBe(200);
	expect(seen[0]?.input).toMatchObject({ threadId: "t", limit: 2 });
});

it("threads the authenticated caller to the handler", async () => {
	// The endpoint's whole authorization story is that `authz.principal` is the caller the SERVER
	// resolved. If it arrived empty on an authenticated request, every plugin keying off it would be
	// deciding against nothing.
	seen.length = 0;
	const w = await mounted();
	open = w;
	const http = httpFor(w.claw, () => ({ principal: userPrincipal("alice") }));

	await http(new Request(`${BASE}/probe/list-page?threadId=t`));
	expect(seen[0]?.principal).toBe("user:alice");
});

it("does not reach the handler with no identity at all", async () => {
	// FAIL-CLOSED, as the adapter's own doc promises for this door. A handler that runs for an
	// anonymous request has to invent its own answer to "who is this", and the ones that key off
	// `authz.principal` would be keying off undefined.
	seen.length = 0;
	const w = await mounted();
	open = w;
	const anonymous = httpFor(w.claw);

	const response = await anonymous(
		new Request(`${BASE}/probe/list-page?threadId=t`),
	);
	expect(seen).toHaveLength(0);
	expect(response.status).toBeGreaterThanOrEqual(400);
});
