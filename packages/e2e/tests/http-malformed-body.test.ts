/**
 * BODIES THAT ARE NOT WHAT THEY CLAIM TO BE.
 *
 * The boundary parses before anything else can run, so this is the layer where a request is most
 * capable of being something other than a request. Everything here is reachable by anyone who can
 * reach the deployment; several are reachable before authentication is even consulted.
 *
 * THE PROPERTY IS THE SAME ONE THROUGHOUT: what the caller sent is the caller's problem. A malformed
 * request gets a 4xx and the process carries on. `limitError` says it outright — "an adapter can
 * answer with a 413 rather than a 400. It is also never a 500: refusing is the system working" — and
 * an oversized body has its own status precisely so a caller can tell "too big" from "malformed".
 *
 * The depth case is the one that is not merely about status codes. A deeply nested body meets several
 * recursive walkers on its way in (parse, schema validation, the canonical-JSON hash) and a stack
 * overflow is not a refusal — it is the host falling over on input somebody chose.
 */

import { userPrincipal } from "@busyclaw/contracts";
import { MAX_REQUEST_BODY_BYTES } from "@busyclaw/core";
import { afterEach, expect, it } from "vitest";
import { BASE, httpFor } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

/** Raw body, so a case can send something `JSON.stringify` would never produce. */
const raw = (body: string, headers?: Record<string, string>) =>
	new Request(`${BASE}/create-claw`, {
		method: "POST",
		headers: headers ?? { "content-type": "application/json" },
		body,
	});

async function authenticated() {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		principal: "user:alice",
	});
	const http = httpFor(w.claw, () => ({ principal: userPrincipal("alice") }));
	return { w, http };
}

it("answers a body over the ceiling with 413, not 500", async () => {
	// The status is the point. 413 tells a client the request will never fit and to stop; 400 sends
	// them hunting for a syntax error they do not have; 500 tells them to retry it forever.
	const { w, http } = await authenticated();
	open = w;

	const huge = "x".repeat(MAX_REQUEST_BODY_BYTES + 1_000);
	const response = await http(raw(JSON.stringify({ id: "big", name: huge })));
	expect(response.status).toBe(413);
});

it("never answers a malformed body with a 5xx", async () => {
	// Every one of these is a body a client can send by accident — a truncated upload, a proxy that
	// mangled the payload, a client that serialised the wrong variable. None of them is a server
	// fault, and none of them should read as one.
	const { w, http } = await authenticated();
	open = w;

	const bodies: [string, string][] = [
		["truncated json", '{"id":"a","name":'],
		["not json at all", "this is not json"],
		["empty body", ""],
		["json but not an object", '"just a string"'],
		["json array", "[1,2,3]"],
		["json null", "null"],
		["json number", "42"],
	];

	const server: string[] = [];
	for (const [label, body] of bodies) {
		const response = await http(raw(body));
		if (response.status >= 500) {
			const detail = (await response.text()).slice(0, 120);
			server.push(`${label} → ${response.status} ${detail}`);
		}
	}
	expect(server).toEqual([]);
});

it("survives a deeply nested body", async () => {
	// A depth bomb, and the failure it looks for is not a status code: several recursive walkers meet
	// this body on the way in, and a stack overflow is the host falling over rather than refusing.
	// Whatever comes back, it has to be an answer.
	const { w, http } = await authenticated();
	open = w;

	const depth = 20_000;
	const nested = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
	const response = await http(raw(`{"id":"deep","name":"n","x":${nested}}`));

	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(response.status).toBeLessThan(500);
});
