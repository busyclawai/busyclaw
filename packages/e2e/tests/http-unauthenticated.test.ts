/**
 * THE SWEEP AT THE BOUNDARY — every governed route, reached with no identity at all.
 *
 * `ClawRequestHandlerOptions.resolveCaller` makes a promise in its own doc: "FAIL-CLOSED: absent, or
 * returning `undefined` (an unauthenticated request), means no principal — so the principal floor
 * DENIES every governed core api call with a 403". That is a property over the whole route table,
 * and this asks it of every entry rather than of the routes somebody thought about.
 *
 * Worth asking here rather than in process, because the in-process sweep provably cannot reach it:
 * `resolveCaller` does not exist below the boundary, and the input schemas are wired into the ROUTE
 * rather than the method. A direct call is trusted to TypeScript; a request is not trusted at all.
 *
 * ANY 2xx IS THE FINDING. A 4xx is fine whichever kind it is — a route that rejects the body before
 * it reaches authz has still refused an anonymous caller — but the counts are asserted separately so
 * a run where everything 400'd cannot pass as if the floor had held.
 */

import { afterEach, expect, it } from "vitest";
import { httpFor, ROUTES, requestFor } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

/** Plausible input for any route — the ids point at things that exist, so nothing is refused merely
 *  for being absent. Extra keys are dropped per route by `requestFor` only for GET; a POST carries
 *  them, which is itself part of what is under test. */
const INPUT: Record<string, unknown> = {
	id: "claw-1",
	clawId: "claw-1",
	threadId: "thread-1",
	runId: "run-1",
	toRunId: "run-1",
	approvalId: "approval-1",
	toolCallId: "tc-1",
	subjectId: "someone",
	containerKind: "claw",
	containerId: "claw-1",
	name: "Taken",
	title: "t",
	role: "user",
	content: "hello",
	message: "hello",
	prompt: "hello",
	status: "pending",
	scope: "claw",
	scopeId: "claw-1",
	intent: "stop",
	patch: { name: "taken" },
};

it("answers no governed route to a request with no identity", async () => {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		principal: "user:alice",
	});
	open = w;
	await w.api.createClaw({ id: "claw-1", name: "Assistant" });
	await w.api.createThread({
		id: "thread-1",
		clawId: "claw-1",
		title: "Chat",
	});

	// NO `resolveCaller` — the unauthenticated deployment the doc promises is fail-closed.
	const anonymous = httpFor(w.claw);

	const answered: string[] = [];
	const forbidden: string[] = [];
	const otherwiseRefused: string[] = [];

	for (const route of ROUTES) {
		const response = await anonymous(requestFor(route, INPUT));
		const where = `${route.httpMethod} ${route.path} → ${response.status}`;
		if (response.status < 300) answered.push(where);
		else if (response.status === 401 || response.status === 403)
			forbidden.push(where);
		else otherwiseRefused.push(where);
	}

	expect({ answered, otherwiseRefused }).toMatchObject({ answered: [] });

	// The sweep must actually REACH the floor on most routes, or a green run means only that the
	// bodies were malformed. Kept separate from the pass/fail above so the number is visible.
	expect(forbidden.length).toBeGreaterThanOrEqual(20);
}, 60000);

it("serves health without an identity, so the sweep above is measuring something", async () => {
	// THE CONTROL. If the handler refused everything unconditionally — a broken basePath, a handler
	// that throws on every request — the sweep would pass while proving nothing. `/health` is the one
	// route that must answer an anonymous caller.
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
	});
	open = w;

	const anonymous = httpFor(w.claw);
	const response = await anonymous(
		new Request("https://app.test/api/busyclaw/health"),
	);
	expect(response.status).toBe(200);
}, 60000);
