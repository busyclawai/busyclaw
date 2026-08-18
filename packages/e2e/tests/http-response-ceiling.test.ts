/**
 * THE COST OF A REQUEST MUST NOT BE SET BY HOW MUCH DATA THE CALLER ALREADY HAS.
 *
 * R-M12, stated in the adapter: request ingress was bounded and egress was not, and the asymmetry is
 * the whole problem — the body is assembled from whatever a list returned, and several lists had no
 * ceiling. One `listMessages` over a long thread serialised the entire result set into memory and
 * wrote it out.
 *
 * That ceiling is easy to leave in place and hard to notice losing: it fires only on a result set
 * bigger than any test happens to build, so a change that routes a list around `json()` would look
 * green everywhere. This builds one deliberately.
 *
 * The shape of the test is the asymmetry itself — every WRITE here is comfortably under the 1MB
 * ingress limit, and it is only the READ that becomes too large. No single request is abusive; the
 * accumulation is.
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

const listMessages = () => {
	const route = ROUTES.find((entry) => entry.path === "/list-messages");
	if (!route) throw new Error("no list-messages route");
	return route;
};

it("refuses a list too large to send, rather than sending it", async () => {
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

	const chunk = "x".repeat(900_000);
	for (let i = 0; i < 12; i++) {
		await w.api.appendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			role: "user",
			content: `${i}${chunk}`,
		});
	}

	const http = httpFor(w.claw, () => ({ principal: userPrincipal("alice") }));
	const response = await http(
		requestFor(listMessages(), { threadId: "thread-1" }),
	);

	// A LIMIT, not a 500. The same value will be too big next time however well-formed it is, and a
	// caller can act on that by asking for less — which is what `limit` is for, and what the 413
	// tells them to reach for.
	expect(response.status).toBe(413);

	const text = await response.text();
	// The refusal is SMALL. A ceiling that answered by serialising the oversized body first would
	// have paid the whole cost it exists to avoid, and this is the only assertion that can tell.
	expect(text.length).toBeLessThan(1_000);
	expect(text).toContain("BUSYCLAW_LIMIT_EXCEEDED");
	// Still a per-caller answer, even when it is a refusal.
	expect(response.headers.get("cache-control")).toBe("no-store");
}, 120000);

it("sends the same data happily once the caller asks for less", async () => {
	// The other half: the ceiling must be a ceiling and not a wall. The rows that could not be sent
	// together are fine in pages, which is what makes the 413 actionable rather than terminal.
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

	const chunk = "x".repeat(900_000);
	for (let i = 0; i < 12; i++) {
		await w.api.appendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			role: "user",
			content: `${i}${chunk}`,
		});
	}

	const http = httpFor(w.claw, () => ({ principal: userPrincipal("alice") }));
	const response = await http(
		requestFor(listMessages(), { threadId: "thread-1", limit: "2" }),
	);

	expect(response.status).toBe(200);
	const payload = (await response.json()) as { data?: unknown[] };
	expect(payload.data).toHaveLength(2);
}, 120000);
