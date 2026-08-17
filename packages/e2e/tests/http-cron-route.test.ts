/**
 * THE THIRD DOOR, AND THE ONE THAT DOES NOT AUTHENTICATE A PERSON.
 *
 * `/cron` is reached by a scheduler, not a user, so it authenticates with a SHARED SECRET rather than
 * a principal — a third mechanism beside the PEP and the plugin endpoints' own owner check. Being
 * third is the reason to probe it: neither of the other two's guarantees say anything about it, and
 * what it triggers is a drain of the whole deployment's due work.
 *
 * The route also has an escape hatch, `unsafeAllowUnauthenticated`, whose own doc says it is "named
 * to be alarming". A hatch like that earns a test proving it does what its name says — both that it
 * genuinely opens the door, and that nothing else does.
 *
 * NOT TESTED HERE, deliberately: the secret is compared with `!==` rather than a constant-time
 * equality. That is uniform across the codebase (channels compares its webhook secret the same way,
 * and there is no timing-safe helper anywhere), so it is a standing choice rather than an oversight
 * on this route, and inventing a finding out of it would be manufacturing one.
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

const CRON = "https://app.test/api/busyclaw/cron";
const SECRET = "s3cr3t-from-the-scheduler";

const post = (headers?: Record<string, string>) =>
	new Request(CRON, { method: "POST", ...(headers ? { headers } : {}) });

async function withCron(
	cronHandler: Parameters<typeof world>[0]["cronHandler"],
) {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		...(cronHandler !== undefined ? { cronHandler } : {}),
	});
	return { w, http: httpFor(w.claw) };
}

it("is not mounted at all when no cron handler is configured", async () => {
	// The strongest form of "authenticated": absent. A deployment that never asked for cron should not
	// have a drain endpoint sitting there for anyone to find.
	const { w, http } = await withCron(undefined);
	open = w;

	const response = await http(post());
	expect(response.status).toBe(404);
});

it("refuses the drain without the secret, and with the wrong one", async () => {
	const { w, http } = await withCron({ secret: SECRET });
	open = w;

	const rejected: [string, Record<string, string> | undefined][] = [
		["no header", undefined],
		["empty", { "x-busyclaw-cron-secret": "" }],
		["wrong", { "x-busyclaw-cron-secret": "wrong" }],
		["upper-cased value", { "x-busyclaw-cron-secret": SECRET.toUpperCase() }],
		// The secret belongs in ITS header. A route that also read it from somewhere a browser fills in
		// on its own — a query string, a cookie — would be reachable by a link.
		["near-miss header name", { "x-busyclaw-cron-secret-x": SECRET }],
	];
	const accepted: string[] = [];
	for (const [label, headers] of rejected) {
		const response = await http(post(headers));
		if (response.status !== 401) accepted.push(`${label} → ${response.status}`);
	}
	expect(accepted).toEqual([]);

	// Nor from the query string, for the same reason.
	const viaQuery = await http(
		new Request(`${CRON}?secret=${SECRET}`, { method: "POST" }),
	);
	expect(viaQuery.status).toBe(401);

	// PADDED IS NOT A NEAR MISS, which is worth writing down because it looks like one. `Headers`
	// strips leading and trailing whitespace from a value per the Fetch spec, so the route is handed
	// the exact secret and never sees the padding — verified rather than assumed, after this case
	// first read as the route being lax.
	const padded = await http(post({ "x-busyclaw-cron-secret": ` ${SECRET} ` }));
	expect(padded.status).toBe(200);
});

it("runs the drain for the scheduler that has the secret", async () => {
	// The control. Without this the refusals above would pass on a route that refuses everybody, which
	// is a different bug wearing the same colours.
	const { w, http } = await withCron({ secret: SECRET });
	open = w;

	const response = await http(post({ "x-busyclaw-cron-secret": SECRET }));
	expect(response.status).toBe(200);

	// Header lookup is case-insensitive per the Headers spec; asserted because the route reads the
	// name from config and a scheduler will send whatever casing it likes.
	const shouted = await http(post({ "X-BUSYCLAW-CRON-SECRET": SECRET }));
	expect(shouted.status).toBe(200);
});

it("honours a custom header name, and only that one", async () => {
	const { w, http } = await withCron({
		secret: SECRET,
		headerName: "x-scheduler-token",
	});
	open = w;

	expect((await http(post({ "x-scheduler-token": SECRET }))).status).toBe(200);
	// The default name must stop working once another is declared, or the route has two keys.
	expect((await http(post({ "x-busyclaw-cron-secret": SECRET }))).status).toBe(
		401,
	);
});

it("opens the door when the alarming option says to, and only then", async () => {
	// `unsafeAllowUnauthenticated` is an explicit opt-out, so the test is that it does exactly what it
	// says: no secret, no header, drain runs. Pinned because the value of a hatch named to be alarming
	// is that it is the ONLY way in — a second, quieter path would make the name a lie.
	const { w, http } = await withCron({ unsafeAllowUnauthenticated: true });
	open = w;

	expect((await http(post())).status).toBe(200);
});
