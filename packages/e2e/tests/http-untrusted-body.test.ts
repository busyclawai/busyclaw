/**
 * THE BODY IS NOT EVIDENCE OF ANYTHING.
 *
 * Two promises meet at this boundary and neither is checkable from inside the process:
 *
 *   - `resolveCaller` is "the ONLY over-the-wire identity path — request BODIES never carry a
 *     who/where field; those are server-stamped from the caller". So a body naming somebody else
 *     must not move the caller.
 *   - The input schemas declare `onUndeclaredKey("reject")`, and they are wired into the ROUTE. A
 *     direct in-process call never runs them, so this is the first thing in the package that can
 *     tell whether they fire at all.
 *
 * These are the same class of thing as the identity-seam audit finding: not a door left unlocked,
 * but a door that believes what the visitor says about themselves.
 */

import { userPrincipal } from "@busyclaw/contracts";
import { afterEach, expect, it } from "vitest";
import { BASE, httpFor } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

const post = (path: string, body: unknown, headers?: Record<string, string>) =>
	new Request(`${BASE}${path}`, {
		method: "POST",
		headers: headers ?? { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

async function twoParty() {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		principal: "user:alice",
	});
	await w.api.createClaw({ id: "alice-claw", name: "Alice's" });
	await w.api.createThread({
		id: "alice-thread",
		clawId: "alice-claw",
		title: "Chat",
	});
	// Authenticated — as Mallory, who owns none of the above.
	const asMallory = httpFor(w.claw, () => ({
		principal: userPrincipal("mallory"),
	}));
	return { w, asMallory };
}

it("does not let a body name a different caller", async () => {
	// The escalation this rules out: Mallory is authenticated, and asks — in the body — to be Alice.
	// If any of these were read, the identity seam would have a second entrance that no host controls.
	const { w, asMallory } = await twoParty();
	open = w;

	const forged = [
		{ id: "forged-1", name: "Mine", principal: "user:alice" },
		{ id: "forged-2", name: "Mine", createdBy: "user:alice" },
		{ id: "forged-3", name: "Mine", caller: { principal: "user:alice" } },
		{ id: "forged-4", name: "Mine", operator: "user:alice" },
	];

	for (const body of forged) {
		const response = await asMallory(post("/create-claw", body));
		// Rejected outright is the ideal answer; accepted-and-ignored is acceptable. Accepted-and-
		// HONOURED is the finding, so the claw that lands must belong to Mallory whatever happened.
		if (response.status < 300) {
			const claws = await w.rows("claw");
			const landed = claws.find((row) => row.id === body.id);
			expect(landed?.createdBy).toBe("user:mallory");
		}
	}

	// And nothing Alice owns moved.
	const claws = await w.rows("claw");
	const alices = claws.find((row) => row.id === "alice-claw");
	expect(alices?.createdBy).toBe("user:alice");
});

it("never answers a malformed request with a 5xx", async () => {
	// THE PROPERTY, and the codebase states it itself in `limitError`'s doc: "It is also never a 500:
	// refusing is the system working." What the caller sent is the caller's problem.
	//
	// A 500 for bad input is not cosmetic. It pages somebody for a client's typo, it tells the client
	// to retry something that can never succeed, it is remotely triggerable by anyone holding a valid
	// identity, and it buries real server errors in the noise.
	//
	// Only THREE of the forty-eight input schemas declare `onUndeclaredKey("reject")`. On the rest an
	// unknown field is accepted at the route, travels the whole way down, and the STORAGE layer throws
	// `[BUSYCLAW_CONFIGURATION_ERROR] storage schema unknown field` — reported as a 500. A wrong-TYPED
	// field on the same route answers 400 correctly, so the error mapping works fine; it is the
	// unknown key that escapes validation entirely and fails somewhere with no reason to be polite.
	const { w, asMallory } = await twoParty();
	open = w;

	const cases: [string, Record<string, unknown>][] = [
		[
			"/create-claw",
			{ id: "x1", name: "Mine", totallyUnknownField: "surprise" },
		],
		[
			"/create-thread",
			{ id: "x2", clawId: "alice-claw", title: "t", bogus: 1 },
		],
		[
			"/append-message",
			{
				clawId: "alice-claw",
				threadId: "alice-thread",
				role: "user",
				content: "hi",
				bogus: 1,
			},
		],
	];

	const server: string[] = [];
	for (const [path, body] of cases) {
		const response = await asMallory(post(path, body));
		if (response.status >= 500) {
			const detail = (await response.text()).slice(0, 120);
			server.push(`POST ${path} → ${response.status} ${detail}`);
		}
	}
	expect(server).toEqual([]);
});

it("refuses a bodied write that does not declare JSON", async () => {
	// The CSRF floor named in `resolveCaller`'s doc: "Bodied requests must already declare
	// `application/json` ... a browser cannot send that content type cross-site without a preflight it
	// will fail". A write accepted without that declaration is reachable from a plain cross-site form.
	const { w, asMallory } = await twoParty();
	open = w;

	const response = await asMallory(
		post(
			"/create-claw",
			{ id: "form-post", name: "Mine" },
			{
				"content-type": "application/x-www-form-urlencoded",
			},
		),
	);
	expect(response.status).toBeGreaterThanOrEqual(400);

	const claws = await w.rows("claw");
	expect(claws.find((row) => row.id === "form-post")).toBeUndefined();
});
