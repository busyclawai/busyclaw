// Reading a body without agreeing in advance to hold all of it.
//
// M-04. Two things are being checked here, and the second is the one that bites quietly: that an
// over-long body is REFUSED, and that a body under the limit comes back byte-for-byte correct. A
// size check is easy; a streaming UTF-8 decode that survives chunk boundaries and concurrent
// requests is where this kind of code actually goes wrong.

import type { BusyclawRouteRequest } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BODY_BYTES, readRequestBody } from "../src/index";

/** A request whose body arrives as a real stream, in the chunks given. */
function streamed(
	chunks: readonly Uint8Array[],
	headers: Record<string, string> = {},
): BusyclawRouteRequest & { pulled: () => number; cancelled: () => boolean } {
	let pulled = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[pulled];
			pulled += 1;
			if (chunk === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(chunk);
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		method: "POST",
		url: "https://example.test/x",
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		json: async () => ({}),
		text: async () => "",
		body,
		pulled: () => pulled,
		cancelled: () => cancelled,
	};
}

/** A request with no stream to meter — only the already-buffered text. */
function buffered(
	text: string,
	headers: Record<string, string> = {},
): BusyclawRouteRequest {
	return {
		method: "POST",
		url: "https://example.test/x",
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		json: async () => JSON.parse(text) as unknown,
		text: async () => text,
	};
}

const utf8 = new TextEncoder();

describe("readRequestBody — the budget", () => {
	it("refuses on the declared length before reading the body", async () => {
		const chunks = Array.from({ length: 20 }, () => utf8.encode("x".repeat(8)));
		const request = streamed(chunks, {
			"content-length": String(MAX_REQUEST_BODY_BYTES + 1),
		});

		await expect(readRequestBody(request)).rejects.toThrow(/exceeds/);
		// The cheapest refusal there is. Not zero: a `ReadableStream` prefetches one chunk to fill its
		// own queue the moment it is constructed, which happens before this function is even called.
		// What matters is that WE never pulled — 1, not 21.
		expect(request.pulled()).toBeLessThanOrEqual(1);
	});

	it("stops READING an over-long body rather than discovering it afterwards", async () => {
		// Ten chunks of 40 bytes against a 100-byte limit. A reader that buffers first and checks
		// after would pull all ten; this one must stop as soon as the running total passes.
		const chunks = Array.from({ length: 10 }, () =>
			utf8.encode("x".repeat(40)),
		);
		const request = streamed(chunks);

		await expect(readRequestBody(request, 100)).rejects.toThrow(/exceeds/);
		expect(request.pulled()).toBeLessThanOrEqual(3);
		// And the rest is refused at the source, not left for the host to keep pushing.
		expect(request.cancelled()).toBe(true);
	});

	it("refuses an over-long body even when only the buffered text is available", async () => {
		// The weaker half of the contract, and worth pinning: the bytes are already spent by the time
		// `text()` resolves, but the parse and everything downstream of it are still refused.
		await expect(
			readRequestBody(buffered("y".repeat(200)), 100),
		).rejects.toThrow(/exceeds/);
	});

	it("lets a body under the limit through unchanged", async () => {
		const request = streamed([utf8.encode('{"a":1}')]);
		expect(await readRequestBody(request)).toBe('{"a":1}');
		expect(request.cancelled()).toBe(false);
	});
});

describe("readRequestBody — the decode", () => {
	it("reassembles a character split across two chunks", async () => {
		// The failure this prevents is silent: decoding each chunk on its own turns the halves of a
		// multi-byte character into two replacement characters, and the body still "parses".
		const bytes = utf8.encode("héllo wörld — ünïcode");
		const cut = 2; // lands inside the two-byte é
		const request = streamed([bytes.slice(0, cut), bytes.slice(cut)]);

		expect(await readRequestBody(request)).toBe("héllo wörld — ünïcode");
	});

	it("keeps two concurrent reads from splicing each other's characters", async () => {
		// A streaming decoder CARRIES the partial sequence it is waiting to complete. These reads
		// interleave at every await, so one decoder shared between them would hand A's trailing bytes
		// to B. That is why the decoder is built per call — and this is the test that says so.
		const first = utf8.encode("ααααα ββββfor-a");
		const second = utf8.encode("γγγγγ δδδδfor-b");
		const halve = (bytes: Uint8Array) => [bytes.slice(0, 3), bytes.slice(3)];

		const [a, b] = await Promise.all([
			readRequestBody(streamed(halve(first))),
			readRequestBody(streamed(halve(second))),
		]);

		expect(a).toBe("ααααα ββββfor-a");
		expect(b).toBe("γγγγγ δδδδfor-b");
	});

	it("returns empty for a body with no chunks at all", async () => {
		expect(await readRequestBody(streamed([]))).toBe("");
	});
});
