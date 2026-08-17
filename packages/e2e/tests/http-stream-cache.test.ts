/**
 * A LIVE STREAM IS STILL A PER-CALLER ANSWER.
 *
 * L-11 is a rule with a name: every response here was authorized for ONE principal and much of it is
 * that principal's transcript, so a shared cache left to its own heuristics can serve one user
 * another's answer. `json()` applies it, the OpenAPI document is a considered exception that says
 * `max-age` for itself, and `http-semantics.test.ts` pins both.
 *
 * The streaming path was neither: it is built somewhere other than `json()` — which is where the
 * rule was written down — so it carried `no-cache` without `no-store`. Those are different
 * instructions. `no-cache` requires revalidation before a cache REUSES a response; `no-store` is what
 * tells it not to keep the bytes. For a live transcript, the keeping is the part that matters.
 *
 * The same shape as the two other findings on this boundary: a decision made once, in the place
 * somebody was looking, and a sibling door that never got it.
 */

import { userPrincipal } from "@busyclaw/contracts";
import { afterEach, expect, it } from "vitest";
import { httpFor } from "../src/http";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

it("tells caches not to keep a watch stream", async () => {
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

	const http = httpFor(w.claw, () => ({ principal: userPrincipal("alice") }));
	const response = await http(
		new Request("https://app.test/api/busyclaw/threads/thread-1/watch"),
	);

	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");

	const cacheControl = response.headers.get("cache-control") ?? "";
	expect(cacheControl).toContain("no-store");
	// The rest of the set still earns its place — `no-cache` stops a replay of a live stream, and
	// `no-transform` stops a proxy rewriting the frames.
	expect(cacheControl).toContain("no-cache");

	// Not left open: the body is a live stream, and a test that returns without cancelling leaks the
	// reader into whatever runs next.
	await response.body?.cancel();
});
