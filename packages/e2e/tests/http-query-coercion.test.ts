/**
 * A QUERY STRING CARRIES ONLY STRINGS, AND SOME ROUTES DECLARE NUMBERS.
 *
 * `readInput` accepts two representations of the same GET input — an `input=<json>` blob and flat
 * query pairs — and they were not equivalent. `?limit=2` arrived as `"2"` and came back
 * `400 limit must be a number`, which is a confusing thing to tell somebody who sent 2.
 *
 * `listMessages` is where it bites, and the irony is in its own docs: `runId` exists so a caller does
 * not "read the whole transcript to reach the last two rows", and `limit`/`afterSequence` are the
 * pagination for the same problem — unusable through the carrier most people reach for first.
 *
 * The other half of the property is the one that keeps a fix from becoming a new bug: coercion may
 * only happen where the route's schema leaves NO choice. `?id=123` on a string field must stay the
 * string "123", or a fix for pagination silently changes what every id-shaped request means.
 */

import { userPrincipal } from "@busyclaw/contracts";
import { afterEach, expect, it } from "vitest";
import { httpFor, ROUTES, requestFor } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

const route = (path: string) => {
	const found = ROUTES.find((entry) => entry.path === path);
	if (!found) throw new Error(`no route ${path}`);
	return found;
};

async function withMessages(count: number) {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		principal: "user:alice",
	});
	await w.api.createClaw({ id: "claw-1", name: "Assistant" });
	await w.api.createThread({
		id: "thread-1",
		clawId: "claw-1",
		title: "Chat",
	});
	for (let i = 0; i < count; i++) {
		await w.api.appendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			role: "user",
			content: `message ${i}`,
		});
	}
	const http = httpFor(w.claw, () => ({ principal: userPrincipal("alice") }));
	return { w, http };
}

it("honours a numeric query parameter the route declares", async () => {
	const { w, http } = await withMessages(3);
	open = w;

	const response = await http(
		requestFor(route("/list-messages"), { threadId: "thread-1", limit: "2" }),
	);
	expect(response.status).toBe(200);

	// The number has to have been USED, not merely accepted — a coercion that parsed the value and
	// then dropped it would pass a status check while paginating nothing.
	const payload = (await response.json()) as { data?: unknown[] };
	expect(payload.data).toHaveLength(2);
});

it("leaves a string field alone even when the value looks numeric", async () => {
	// THE GUARD. `id` is declared a string, so `123` is the string "123" and must stay one. Coercing by
	// sniffing the value rather than reading the schema would rename every numeric-looking id in the
	// system — a much worse bug than the one being fixed.
	const { w, http } = await withMessages(1);
	open = w;

	const response = await http(requestFor(route("/get-claw"), { id: "123" }));

	// WHATEVER the answer is — here a 403, because no such claw is Alice's — it must not be a
	// VALIDATION failure, which is the only thing a wrongly-coerced id could produce. Asserting the
	// code rather than the status is what makes this about coercion instead of about authorization.
	const payload = (await response.json()) as { error?: { code?: string } };
	expect(payload.error?.code).not.toBe("BUSYCLAW_VALIDATION_FAILED");
});

it("still accepts the documented `input=<json>` carrier", async () => {
	// The representation the OpenAPI document actually advertises. It always worked, and the point of
	// the fix is that the two carriers now agree rather than that this one changed.
	const { w, http } = await withMessages(3);
	open = w;

	const url = new URL("https://app.test/api/busyclaw/list-messages");
	url.searchParams.set(
		"input",
		JSON.stringify({ threadId: "thread-1", limit: 2 }),
	);
	const response = await http(new Request(url));
	expect(response.status).toBe(200);
	const payload = (await response.json()) as { data?: unknown[] };
	expect(payload.data).toHaveLength(2);
});
