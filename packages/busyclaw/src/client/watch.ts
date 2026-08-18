// `client.watchThread` — the client half of live watching.
//
// Built on `fetch` rather than `EventSource`, which costs a reconnect loop and buys two things
// EventSource cannot give: AUTHORIZATION (it sends no custom headers, so a bearer token cannot reach
// the server and this client's `headers` option would be silently ignored) and PORTABILITY (it does
// not exist in Node, where a server-side consumer would want exactly this).
//
// THE CURSOR BELONGS TO THE CORE, NOT TO THIS TRANSPORT. It is the same opaque string the server's
// `watchThread` yields, carried back as `Last-Event-ID` — which is what lets a client start here,
// lose the connection, and resume on a plain poll of the same endpoint without losing its place.

import type { RunStreamPage } from "@busyclaw/contracts";
// From the errors package, NOT the contracts barrel: a VALUE import of that barrel pulls the whole
// protocol surface into the client bundle, which `contracts-wire.test.ts` exists to prevent.
import { errorMessage } from "@busyclaw/errors";
import { normalizeBaseUrl, resolveHeaders } from "./transport";
import type { ClawClientOptions } from "./types";

/** How long to wait before reconnecting, per consecutive failure. Short first — a dropped SSE is
 *  usually a proxy timing out an idle connection, and the answer is to reconnect, not to back off. */
const RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;

export type WatchThreadOptions = {
	/** Resume point. Omit to read the conversation's live log from the start. */
	since?: string;
	/** Stop watching. The iterable ends; no error is thrown, because leaving is not a failure. */
	signal?: AbortSignal;
};

/**
 * One frame of an `text/event-stream`, as this parser understands it. Comments (`:` lines) and
 * unknown fields are ignored, per the SSE spec — a server is allowed to send keep-alives.
 */
type Frame = { id?: string; event?: string; data: string };

/** Split a buffer into complete SSE frames, returning the remainder. A frame ends at a blank line;
 *  anything after the last blank line is an incomplete frame and stays in the buffer. */
function drainFrames(buffer: string): { frames: Frame[]; rest: string } {
	const frames: Frame[] = [];
	// \r\n\r\n as well as \n\n: a proxy may normalize line endings, and a parser that only knows one
	// simply never yields a frame, which looks exactly like a server that sent nothing.
	const parts = buffer.split(/\r?\n\r?\n/);
	const rest = parts.pop() ?? "";
	for (const part of parts) {
		const frame: Frame = { data: "" };
		const dataLines: string[] = [];
		for (const rawLine of part.split(/\r?\n/)) {
			if (rawLine === "" || rawLine.startsWith(":")) continue;
			const colon = rawLine.indexOf(":");
			const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
			// One optional leading space after the colon is part of the framing, not the value.
			const value =
				colon === -1 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
			if (field === "id") frame.id = value;
			else if (field === "event") frame.event = value;
			else if (field === "data") dataLines.push(value);
		}
		frame.data = dataLines.join("\n");
		if (frame.data !== "" || frame.id !== undefined) frames.push(frame);
	}
	return { frames, rest };
}

/**
 * One SSE reader, pointed at whichever watch endpoint. `watchThread` and `watchRun` differ only in
 * the path they open — the framing, the cursor, the reconnect rule and the stale rule are identical,
 * and duplicating them would be duplicating exactly the parts that are easy to get subtly wrong.
 */
function createWatch(options: ClawClientOptions, segment: "threads" | "runs") {
	// ASKED FOR EXPLICITLY, because the run endpoint serves the AI SDK UI message stream by default.
	// That default exists so a chat client cannot forget an opt-in and silently render nothing; the
	// cost is that THIS client — which parses chunks — must say so. It says so once, here.
	const query = segment === "runs" ? "?protocol=chunks" : "";
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	return async function* watch(
		id: string,
		watchOptions?: WatchThreadOptions,
	): AsyncGenerator<RunStreamPage> {
		let cursor = watchOptions?.since;
		let failures = 0;
		const baseUrl = normalizeBaseUrl(options.baseUrl);

		while (!watchOptions?.signal?.aborted) {
			let connected = false;
			try {
				const headers = await resolveHeaders(options.headers);
				headers.set("accept", "text/event-stream");
				// SENT AS A HEADER, not only as `?since=`, so this behaves identically to a browser
				// `EventSource` reconnect and a server needs one code path for both.
				if (cursor !== undefined) headers.set("last-event-id", cursor);
				const response = await fetchImpl(
					`${baseUrl}/${segment}/${encodeURIComponent(id)}/watch${query}`,
					{
						headers,
						method: "GET",
						...(watchOptions?.signal ? { signal: watchOptions.signal } : {}),
					},
				);
				// A REFUSAL IS NOT A DROPPED CONNECTION. 401/403 will refuse identically forever, so
				// reconnecting would be an infinite polite retry against a decision that has been made.
				if (!response.ok) {
					throw new Error(
						`busyclaw watch failed with status ${response.status}`,
					);
				}
				const body = response.body;
				if (!body) throw new Error("busyclaw watch response has no body");
				// `connected` says the server ANSWERED, which is what decides whether an error is worth
				// retrying. It deliberately no longer resets `failures` — see the reset on delivery below.
				connected = true;

				const reader = body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const drained = drainFrames(buffer);
						buffer = drained.rest;
						for (const frame of drained.frames) {
							if (frame.id !== undefined) cursor = frame.id;
							if (frame.event === "error") {
								throw new Error(errorMessage(safeJson(frame.data)));
							}
							// BACKOFF RESETS ON PROGRESS, NOT ON CONNECTION, and the difference is the whole
							// point of the counter. Resetting it when the response arrived meant a server
							// that accepts a connection and delivers nothing — closing at once, or never
							// completing a frame — never escalated past the first rung: reconnect, reset,
							// reconnect, at four requests a second per client, forever. That is maximum
							// retry pressure on a server precisely when it is least able to absorb it,
							// which is the shape a backoff exists to prevent.
							//
							// A frame is the evidence the stream is doing its job, so it is what earns the
							// reset. A healthy stream clears the counter on its first page and the short
							// first delay above still does what its comment says for a proxy that timed out
							// a working connection; an idle one that keeps being dropped now walks the
							// ladder to 3s instead of hammering at 250ms.
							failures = 0;
							const page: RunStreamPage = {
								chunks: (safeJson(frame.data) as RunStreamPage["chunks"]) ?? [],
								cursor: cursor ?? "0",
								stale: frame.event === "stale",
							};
							yield page;
							// STALE IS TERMINAL, and reconnecting would be worse than useless: the
							// cursor points past the log, so every retry would be told the same thing.
							if (page.stale) return;
						}
					}
				} finally {
					reader.releaseLock();
				}
			} catch (error) {
				if (watchOptions?.signal?.aborted) return;
				// A connection that never opened is a server saying no; one that opened and ended is
				// the ordinary shape of SSE over a proxy. Only the second is worth retrying, and only
				// a bounded number of times — a permanent failure should surface, not spin.
				if (!connected || failures >= RECONNECT_DELAYS_MS.length) {
					throw new Error(errorMessage(error));
				}
			}
			if (watchOptions?.signal?.aborted) return;
			const delay = RECONNECT_DELAYS_MS[Math.min(failures, 2)] ?? 3_000;
			failures += 1;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	};
}

/** A frame this client cannot read is DROPPED, never thrown on: one malformed event must not end a
 *  live view of everything else, exactly as on the server side of the same buffer. */
function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Watch a CONVERSATION — every run in it, whoever is driving. The entry point, because a watcher
 *  knows which conversation they are looking at and does not know run ids. */
export function createWatchThread(options: ClawClientOptions) {
	return createWatch(options, "threads");
}

/** Watch ONE run: cron work and subagents, which have no conversation to subscribe to, plus the
 *  narrower view of a single turn inside one. */
export function createWatchRun(options: ClawClientOptions) {
	return createWatch(options, "runs");
}
