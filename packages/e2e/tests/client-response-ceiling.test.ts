/**
 * THE CLIENT BOUNDS WHAT IT READS BACK, TOO.
 *
 * R-M12 bounded the server's egress because "the cost of a request was set by how much data the
 * caller already had, not by anything the caller sent". The same asymmetry runs one layer out: the
 * server caps what it sends at 8MB and the client capped nothing it read. `response.text()` resolves
 * only once the WHOLE body is in memory, so a peer answering with more than it should — a broken or
 * compromised server, a proxy substituting a large error page, a gateway streaming junk — decided
 * how much memory the client process spent.
 *
 * A well-behaved busyclaw server cannot exceed its own ceiling, so anything past it was never going
 * to be a usable answer. The client says so instead of buffering it.
 */

import { createClawClient } from "busyclaw/client";
import { expect, it } from "vitest";

const CEILING = 8 * 1024 * 1024;

/** A server that keeps sending, in chunks, well past what any answer could be. */
function floodingFetch(totalBytes: number, onCancel: () => void) {
	return async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new Uint8Array(256 * 1024));
				},
				cancel() {
					onCancel();
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
}

it("refuses a response past the ceiling instead of holding it", async () => {
	let cancelled = false;
	const client = createClawClient({
		baseURL: "https://server.test/api/busyclaw",
		fetch: floodingFetch(CEILING * 4, () => {
			cancelled = true;
		}),
	});

	const result = await client.getClaw({ id: "c1" });

	expect(result.error?.code).toBe("BUSYCLAW_LIMIT_EXCEEDED");
	// CANCELLED, not merely stopped reading. An over-long body has to cost the limit rather than the
	// body, and that only happens if the peer is told to stop.
	expect(cancelled).toBe(true);
});

it("refuses on a declared content-length without draining the body", async () => {
	// The cheapest of the three checks: an honest peer says how much it is sending, and that can be
	// refused for free. Not sufficient alone — a chunked body declares nothing — but free is free.
	//
	// MEASURED BY THE CANCEL, not by whether a chunk was pulled. A `ReadableStream` with the default
	// queuing strategy pre-pulls to fill its queue the moment it is constructed, before any reader
	// exists — so "was pull called" answers a question about the stream, not about this client. The
	// cancel is the observable that belongs to the code under test.
	let cancelled = false;
	let pulls = 0;
	const client = createClawClient({
		baseURL: "https://server.test/api/busyclaw",
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						pulls += 1;
						controller.enqueue(new Uint8Array(1024));
					},
					cancel() {
						cancelled = true;
					},
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						"content-length": String(CEILING + 1),
					},
				},
			),
	});

	const result = await client.getClaw({ id: "c1" });
	expect(result.error?.code).toBe("BUSYCLAW_LIMIT_EXCEEDED");
	expect(cancelled).toBe(true);
	// The declared length settled it, so the body was never walked — one prefilled chunk at most,
	// not the thousands a real drain of that length would take.
	expect(pulls).toBeLessThanOrEqual(1);
});

it("still reads an ordinary answer whole", async () => {
	// The control. A ceiling that refused everything would satisfy the two cases above and be useless,
	// and a metered read that dropped its tail would be worse than useless — so this asserts the
	// payload arrives INTACT, not merely that the call succeeded.
	const claw = { id: "c1", name: "x".repeat(200_000) };
	const client = createClawClient({
		baseURL: "https://server.test/api/busyclaw",
		fetch: async () =>
			new Response(JSON.stringify({ ok: true, data: claw }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	});

	const result = await client.getClaw({ id: "c1" });
	expect(result.error).toBeNull();
	expect(result.data).toEqual(claw);
});
