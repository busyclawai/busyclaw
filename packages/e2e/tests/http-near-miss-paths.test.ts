/**
 * PATHS THAT ARE ALMOST A ROUTE.
 *
 * Routing is the step before every guarantee this package has established. Authorization, validation
 * and the identity seam all run inside a handler, so anything that reaches a handler it should not —
 * or reaches one by a spelling nobody enumerated — is upstream of all of it.
 *
 * The property: a path that is not exactly a declared route does not reach a handler. Whether it
 * answers 404 or 405 is the router's business; what matters is that it never answers 200, and that
 * the two spellings of one route do not disagree about which one it is.
 *
 * `/health` is the instrument. It is the one route that answers an anonymous caller with a 200, so a
 * near-miss of it produces an unambiguous reading: 200 means the path matched, anything else means it
 * did not. Doing this against a governed route would confuse "the router refused" with "the floor
 * refused", which are different failures with the same status.
 */

import { afterEach, expect, it } from "vitest";
import { httpFor } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

const ROOT = "https://app.test";

async function mounted() {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
	});
	return { w, http: httpFor(w.claw) };
}

it("matches the health route on exactly one spelling", async () => {
	const { w, http } = await mounted();
	open = w;

	const exact = await http(new Request(`${ROOT}/api/busyclaw/health`));
	expect(exact.status).toBe(200);

	// Every one of these is a spelling somebody or something produces by accident: a client that
	// appends a slash, a proxy that normalises case, a link with a doubled separator, an encoder that
	// percent-escapes an ordinary character. Each either IS the health route or is not; what it must
	// not be is a second, undeclared way to reach it, because a router with two answers for one path
	// is a router whose route table does not describe it.
	const mustNotMatch = [
		"/api/busyclaw//health",
		"/api/busyclaw/HEALTH",
		"/api/busyclaw/Health",
		"/api/busyclaw/health%20",
		"/api/busyclaw/healthz",
		"/api/busyclaw/health/extra",
		// `%6C` is `l`, so this SPELLS "health" once decoded. It must not match, because a router that
		// decodes before it matches gives every route a second set of names — and a filter in front of
		// it (a WAF, a gateway rule, an audit log) sees only the first set.
		"/api/busyclaw/hea%6Cth",
		"/api//busyclaw/health",
		"/API/BUSYCLAW/health",
	];

	const matched: string[] = [];
	for (const path of mustNotMatch) {
		const response = await http(new Request(`${ROOT}${path}`));
		if (response.status === 200) matched.push(path);
	}
	expect(matched).toEqual([]);

	// ACCEPTED, and pinned as such rather than asserted away. A trailing slash reaches the same route
	// — ordinary router leniency, and the kind of thing worth having written down so a change to it is
	// a decision rather than a surprise.
	const trailing = await http(new Request(`${ROOT}/api/busyclaw/health/`));
	expect(trailing.status).toBe(200);

	// NOT THE ROUTER'S DOING. `new URL()` resolves dot segments before anything here sees them, so
	// these ARE requests for `/api/busyclaw/health` by the time they arrive — per RFC 3986, and true
	// of every host that hands over a parsed URL. Asserting they 404 would be asserting against the
	// URL spec; asserting they resolve says where the normalisation actually happens.
	for (const equivalent of [
		"/api/busyclaw/health/../health",
		"/api/busyclaw/./health",
	]) {
		const response = await http(new Request(`${ROOT}${equivalent}`));
		expect(response.status).toBe(200);
	}
});

it("does not serve anything outside its base path", async () => {
	// The mount is `/api/busyclaw`. A handler reachable above it would mean the base path is
	// advisory, and a host that mounts busyclaw beside its own routes would be handing those away.
	const { w, http } = await mounted();
	open = w;

	const outside = [
		"/health",
		"/api/health",
		"/api/busyclaw2/health",
		"/api/busyclawX/health",
	];

	const answered: string[] = [];
	for (const path of outside) {
		const response = await http(new Request(`${ROOT}${path}`));
		if (response.status === 200) answered.push(path);
	}
	expect(answered).toEqual([]);

	// `/../` above the root is not an escape either: the URL parser clamps it, so this is a request
	// for the mounted route and answers like one.
	const clamped = await http(new Request(`${ROOT}/../api/busyclaw/health`));
	expect(clamped.status).toBe(200);
});

it("refuses a known path under the wrong verb rather than running it", async () => {
	// `/health` is a GET. A POST to it must not be treated as one — a router that matches on path
	// alone would run a read handler for a request the caller framed as a write, and the same
	// looseness on a governed route would pick a handler whose authorization was written for the
	// other verb.
	const { w, http } = await mounted();
	open = w;

	const response = await http(
		new Request(`${ROOT}/api/busyclaw/health`, { method: "POST" }),
	);
	expect(response.status).not.toBe(200);
});
