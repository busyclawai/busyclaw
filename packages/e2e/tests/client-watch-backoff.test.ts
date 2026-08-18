/**
 * A BACKOFF THAT RESETS ON CONNECTING IS NOT A BACKOFF.
 *
 * `watchThread` reconnects on a `[250, 1000, 3000]` ladder, and the short first rung is deliberate:
 * a dropped SSE is usually a proxy timing out an idle connection, and the answer is to reconnect
 * rather than to wait. That reasoning is about a stream that WAS working.
 *
 * The counter used to be cleared the moment the response arrived, which a degraded server still
 * manages — an LB green while the app is broken, a proxy terminating streams, a handler that closes
 * at once. So the ladder never left its first rung: connect, reset, close, reconnect, at four
 * requests a second per client, indefinitely. Maximum retry pressure exactly when the server can
 * least absorb it.
 *
 * A delivered frame is the evidence the stream is doing its job, so that is what clears the counter
 * now. Both halves are pinned here, because a fix that only slowed things down would break the case
 * the short first rung exists for.
 */

import { createClawClient } from "busyclaw/client";
import { expect, it } from "vitest";

const sse = (body: string) =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);

it("escalates against a server that connects and delivers nothing", async () => {
	let fetches = 0;
	const controller = new AbortController();
	const client = createClawClient({
		baseURL: "https://server.test/api/busyclaw",
		// Answers 200, sends a partial frame, closes. Never a complete frame, never an error.
		fetch: async () => {
			fetches += 1;
			return sse("data: partial\n");
		},
	});

	setTimeout(() => controller.abort(), 1500);
	try {
		for await (const _page of client.watchThread("t", {
			signal: controller.signal,
		})) {
			// nothing is ever delivered; the loop exists to drive the reconnects
		}
	} catch {
		// the abort is the expected exit
	}

	// On the ladder — 250ms then 1s then 3s — one and a half seconds buys two or three attempts.
	// Before the fix this was six and climbing, because every connection reset the counter.
	expect(fetches).toBeLessThanOrEqual(4);
	expect(fetches).toBeGreaterThan(0);
}, 30000);

it("still reconnects promptly for a stream that is actually working", async () => {
	// THE CASE THE SHORT FIRST RUNG IS FOR. A proxy dropping a live connection must not be punished:
	// this server delivers a real frame every time, so every reconnect starts from the first rung and
	// the client keeps up. A fix that escalated on any close would show up here as far fewer attempts.
	let fetches = 0;
	const controller = new AbortController();
	const client = createClawClient({
		baseURL: "https://server.test/api/busyclaw",
		fetch: async () => {
			fetches += 1;
			return sse(`id: ${fetches}\ndata: {"chunks":[]}\n\n`);
		},
	});

	setTimeout(() => controller.abort(), 1500);
	const pages: unknown[] = [];
	try {
		for await (const page of client.watchThread("t", {
			signal: controller.signal,
		})) {
			pages.push(page);
		}
	} catch {
		// the abort is the expected exit
	}

	// Each connection delivered a page, so each reconnect waits only the first rung.
	expect(pages.length).toBeGreaterThan(2);
	expect(fetches).toBeGreaterThan(2);
}, 30000);
