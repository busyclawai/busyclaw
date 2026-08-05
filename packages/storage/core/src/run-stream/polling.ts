// A SUBSCRIPTION over a port that only knows how to be ASKED.
//
// `RunStreamPort.watch` is optional because most backends cannot express one: a key-value store has
// no blocking read, and a database has no subscription short of LISTEN/NOTIFY. This turns the one
// operation every backend does have — `read(key, cursor)` — into the same async iterable a real
// broker would hand back, so a consumer writes one loop and never learns which it got.
//
// It lives beside the implementations rather than inside the api door because it belongs to the
// PORT, not to any one caller: the door was the only consumer while there was one, and the rules it
// encodes — when a page is worth yielding, when to sleep, that stale is terminal — are the port's
// contract rather than that door's policy.

import type { RunStreamPage, RunStreamPort } from "@busyclaw/contracts";

// DECLARED, not imported. This package compiles against ES2023 with no DOM or Node lib — which is
// what keeps it importable from anywhere — and `setTimeout` is in neither, despite existing in every
// JS runtime there is (browsers, Node, Bun, Deno, workers). Narrower than either platform's real
// signature, so nothing here can lean on a return value one of them does not have.
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/**
 * How long to wait after a read that found nothing.
 *
 * It bounds how far a WATCHER lags the writer, never how fast an answer is produced. Small enough to
 * feel live beside a 50–200 ms batch window, large enough that ten watchers on one conversation are
 * ten cheap reads a second rather than a hot loop. A backend with a real subscription fills in
 * `watch` and never reaches this — which is the intended way to get lower latency, rather than
 * tuning this down.
 */
export const DEFAULT_POLL_INTERVAL_MS = 120;

export type PollingWatchOptions = {
	since?: string;
	intervalMs?: number;
	/** Stop watching. The iterable ends; leaving is not an error. */
	signal?: { aborted: boolean };
};

/**
 * Subscribe by asking repeatedly. Yields only pages that carry something.
 *
 * Uses `port.watch` when the backend has one, so a caller can hand any port here and get the best
 * subscription it supports without branching.
 */
export function pollingWatch(
	port: RunStreamPort,
	key: string,
	options?: PollingWatchOptions,
): AsyncIterable<RunStreamPage> {
	if (port.watch !== undefined) return port.watch(key, options?.since);
	const interval = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	return (async function* poll() {
		let cursor = options?.since;
		while (options?.signal?.aborted !== true) {
			const page = await port.read(key, cursor);
			cursor = page.cursor;
			// STALE IS TERMINAL. The cursor points past the end of the log, so nothing after this can
			// be a continuation of what the caller has already seen — see `RunStreamPage.stale`.
			if (page.stale) {
				yield page;
				return;
			}
			if (page.chunks.length > 0) {
				yield page;
				// A page that CARRIED something may have been truncated by the backend's per-read
				// bound, so go straight back rather than sleeping through a backlog a late joiner is
				// trying to catch up on.
				continue;
			}
			await new Promise<void>((resolve) => {
				setTimeout(() => resolve(), interval);
			});
		}
	})();
}
