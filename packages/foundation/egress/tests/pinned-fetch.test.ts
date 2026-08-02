// The pin has to actually carry a request — end to end, over a real socket.
//
// `dispatcher` is a non-standard `RequestInit` field that only an undici-backed fetch reads, and the
// GLOBAL fetch is backed by whatever undici Node bundles: 7 on Node 24, while this package pins 8.
// Handing an 8 Agent to a 7 fetch throws `invalid onRequestStart method` before a byte leaves the
// process, so every pinned call — every registered tool, every sandbox fetch — failed closed on a
// current Node.
//
// It went unnoticed because the egress floor is SUPPOSED to refuse things, and "the request did not
// go out" is exactly what a refusal looks like from the outside. Nothing here asserted that an
// ALLOWED request still arrives, so the whole feature could stop working without a red test.
//
// This is that assertion. It dials a real loopback server through the pinned dispatcher: if the two
// halves ever drift apart again — a Node upgrade, an undici bump — this goes red instead of egress
// going quiet.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EgressDecision } from "../src/index";
import { pinnedConnection, pinnedFetch } from "../src/node";

let server: Server;
let port: number;

beforeAll(async () => {
	server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("reached");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A decision that vetted loopback — standing in for whatever the floor approved. Built to the real
 *  shape rather than cast to it: the cast was hiding a `host` field the type never had and a `url`
 *  it required, which is the one thing a decision carries that the connection cannot re-derive. */
const decisionFor = (host: string): EgressDecision => ({
	url: `http://${host}/`,
	pinnedAddress: "127.0.0.1",
	family: 4,
});

describe("pinnedFetch + pinnedConnection", () => {
	it("carries an allowed request over the pinned address", async () => {
		const pin = pinnedConnection(decisionFor("127.0.0.1"));
		try {
			const response = await pinnedFetch(`http://127.0.0.1:${port}/`, {
				dispatcher: pin.dispatcher,
			} as RequestInit);
			expect(response.status).toBe(200);
			await expect(response.text()).resolves.toBe("reached");
		} finally {
			await pin.close();
		}
	});

	it("dials the PINNED address, not the name it was given", async () => {
		// The property the pin exists for: the socket goes to the vetted address even though the URL
		// carries a hostname that resolves elsewhere (or nowhere). Without the dispatcher taking
		// effect this request cannot possibly succeed — `.invalid` has no DNS answer by RFC.
		const pin = pinnedConnection(decisionFor("nope.invalid"));
		try {
			const response = await pinnedFetch(`http://nope.invalid:${port}/`, {
				dispatcher: pin.dispatcher,
			} as RequestInit);
			expect(response.status).toBe(200);
			await expect(response.text()).resolves.toBe("reached");
		} finally {
			await pin.close();
		}
	});

	it("the GLOBAL fetch cannot drive this dispatcher — which is why the pair ships together", async () => {
		// Documents the defect rather than trusting a comment about it. If a future Node bundles a
		// compatible undici this may start passing; that is a signal to re-read the pairing, not to
		// go back to the global fetch.
		const pin = pinnedConnection(decisionFor("127.0.0.1"));
		try {
			await globalThis.fetch(`http://127.0.0.1:${port}/`, {
				dispatcher: pin.dispatcher,
			} as RequestInit);
			expect.unreachable("global fetch accepted a foreign dispatcher");
		} catch (error) {
			const cause = (error as { cause?: { message?: string } }).cause;
			expect(cause?.message).toMatch(/onRequestStart/);
		} finally {
			await pin.close();
		}
	});
});
