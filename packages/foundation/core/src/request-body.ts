// Reading a request body without agreeing in advance to hold all of it.
//
// M-04. Every HTTP surface busyclaw exposes called `request.text()`, which resolves only once the
// WHOLE body is in memory. Nothing said how much that could be, and the decision was made before
// anything else: before the route matched, before the caller was authenticated, before any policy
// ran. So the cheapest attack on a busyclaw host needed no account and no valid path — a POST with a
// very long body, repeated. Webhook endpoints are worse still, because being reachable by strangers
// is their whole purpose.
//
// It lives here rather than beside the request TYPE in contracts for two reasons. Its call sites are
// on opposite sides of the plugin boundary — the adapter's api routes and a plugin's own webhook —
// so a limit either of them re-implements is a limit one of them will get wrong. And contracts
// compiles against ES2023 with no DOM, which is what keeps the protocol package importable from
// anywhere; reading and decoding a body needs platform APIs it deliberately does not have. Core is
// already where busyclaw decides what it will spend on untrusted input — see the redaction walk's
// own budget in redact.ts.

import type { BusyclawRouteRequest } from "@busyclaw/contracts";
import { limitError } from "@busyclaw/errors";

/**
 * The default ceiling: generous for what these routes actually carry (a prompt, a set of ids, a
 * webhook payload) and far below what hurts. A host behind a proxy usually has its own limit; this
 * is the one that holds when it does not.
 */
export const MAX_REQUEST_BODY_BYTES = 1_000_000;

function tooLarge(maxBytes: number): Error {
	return limitError(`request body exceeds ${maxBytes} bytes`, {
		limit: maxBytes,
	});
}

/**
 * Read a request body as text, refusing to hold more than `maxBytes` of it.
 *
 * Three checks, in decreasing order of how much they save:
 *
 * 1. **The declared length.** An honest client says how much it is sending, and we can refuse before
 *    reading a byte. Not sufficient alone — the header is the sender's claim, and a chunked body
 *    carries none — but it is free.
 * 2. **The stream, metered.** When the host hands over the unread body we stop READING at the limit
 *    and cancel the rest, so an over-long body costs us only the limit.
 * 3. **The buffered text.** Some hosts only offer `text()`, which has already bought the whole body
 *    by the time it resolves. Checking there still refuses the parse and everything downstream, but
 *    the bytes were spent to find out — which is why hosts should pass `body` through.
 */
export async function readRequestBody(
	request: BusyclawRouteRequest,
	maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<string> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes)
		throw tooLarge(maxBytes);

	const body = request.body;
	if (!body) {
		const text = await request.text();
		// `length` counts UTF-16 units, so this UNDER-counts bytes for non-ASCII — a string under the
		// limit can be up to three times it in bytes. Left approximate on purpose: the body is already
		// resident by now, so the exact figure would buy nothing, and re-encoding to measure it would
		// spend more memory than the check saves.
		if (text.length > maxBytes) throw tooLarge(maxBytes);
		return text;
	}

	const reader = body.getReader();
	// Per call, NOT shared. A streaming decoder carries the partial UTF-8 sequence it is waiting to
	// complete, and these reads interleave at every await — two concurrent requests through one
	// decoder would splice each other's characters together. An allocation per request is the price
	// of that being impossible.
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	let overLimit = false;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = next.value;
			if (chunk === undefined) continue;
			size += chunk.byteLength;
			if (size > maxBytes) {
				overLimit = true;
				throw tooLarge(maxBytes);
			}
			// Decoded as we go rather than concatenated and decoded at the end: joining would hold the
			// bytes AND the string at once, doubling the peak for no gain. `{ stream: true }` is what
			// makes that safe — it holds back a trailing partial sequence until the chunk that
			// completes it arrives, where per-chunk `decode()` would mangle any character unlucky
			// enough to straddle a boundary.
			text += decoder.decode(chunk, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
		// Tell the host to stop sending the rest of a body we have already refused. Failing to cancel
		// is not fatal, so its own failure must not replace the refusal on its way out.
		if (overLimit) await body.cancel().catch(() => {});
	}
}

/**
 * How deeply a request body may nest.
 *
 * SIZE IS NOT THE ONLY WAY A BODY CAN BE TOO MUCH. Forty kilobytes of `[[[[…]]]]` sits comfortably
 * under the byte ceiling and still costs more than any real payload: the value meets several
 * RECURSIVE walkers on its way in — schema validation clones it, the canonical-JSON hash walks it —
 * and each of them is a stack frame per level. The first one to run out of stack turns a request
 * somebody chose into a 500.
 *
 * Sixty-four is far past anything these routes carry (a prompt, a set of ids, a webhook payload nest
 * a handful of levels) and far below where any of those walkers is in trouble.
 */
export const MAX_REQUEST_BODY_DEPTH = 64;

/**
 * Parse a request body, refusing one nested past `maxDepth`.
 *
 * THE CHECK IS ITERATIVE, and that is the whole point rather than a style preference: a recursive
 * depth check overflows on exactly the input it exists to refuse, so it would fail in the same way
 * as the walkers it is protecting — only sooner, and while claiming to be the guard.
 *
 * `limitError` for the same reason the byte ceiling uses it: its own doc names this case ("too big,
 * too deep, or too many"), and it is what lets an adapter answer 413 rather than 400 — a caller who
 * sent something structurally too large should be told to stop, not sent hunting for a syntax error.
 * A `RangeError` out of `JSON.parse` itself is the same refusal arriving from the parser instead.
 */
export function parseRequestBody(
	text: string,
	maxDepth: number = MAX_REQUEST_BODY_DEPTH,
): unknown {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof RangeError) throw tooDeep(maxDepth);
		throw error;
	}
	// Depth-first with an explicit stack. Each entry is a value and the depth it sits at, so the walk
	// costs one array rather than one frame per level.
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	while (pending.length > 0) {
		const next = pending.pop();
		if (next === undefined) break;
		if (next.depth > maxDepth) throw tooDeep(maxDepth);
		const candidate = next.value;
		if (candidate === null || typeof candidate !== "object") continue;
		const children = Array.isArray(candidate)
			? candidate
			: Object.values(candidate);
		for (const child of children) {
			pending.push({ value: child, depth: next.depth + 1 });
		}
	}
	return value;
}

function tooDeep(maxDepth: number): Error {
	return limitError(`request body nests deeper than ${maxDepth} levels`, {
		limit: maxDepth,
	});
}
