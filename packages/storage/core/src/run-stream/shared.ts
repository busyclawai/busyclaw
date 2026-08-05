// ONE READER PER KEY PER PROCESS, fanned out in memory — D17's "the poller is shared per process".
//
// WHAT IT COSTS TO NOT HAVE THIS, measured against a live Redis: a watcher joining a conversation
// while another watcher's `XREAD BLOCK` is in flight cannot issue its first read until that block
// returns, because they share one connection. So somebody opening a quiet conversation waits out a
// block window — up to `blockMs` — for text that is already in the stream. On a polling backing the
// same shape is cheaper but not free: N watchers are N reads a tick.
//
// SHARED BY EXACT JOIN POINT, which is the whole trick. Cursors are OPAQUE — a numeric offset here, a
// `<ms>-<seq>` there — so this cannot compare them, only test equality. A subscriber joins the shared
// loop when its cursor is one the loop has already stood at: the loop's own start, or the end of a
// page it has already emitted. Everyone else gets a private reader, which is exactly today's
// behaviour, so nothing regresses and no correctness rests on a comparison that cannot be made.
//
// It covers the case that actually happens: several people opening the same conversation, all with no
// cursor at all. `undefined === undefined` is the join point, and one reader serves the room.

import type { RunStreamPage, RunStreamPort } from "@busyclaw/contracts";
import { pollingWatch } from "./polling";

/**
 * How many recent pages a loop keeps so a joiner can be caught up from memory.
 *
 * Small on purpose: it exists to bridge the moment between a page being emitted and a second
 * subscriber asking for the position after it, not to be a cache. A joiner whose cursor has fallen
 * out of it takes a private reader and is correct, only lonelier.
 */
const DEFAULT_TAIL_PAGES = 64;

type Subscriber = {
	push: (page: RunStreamPage) => void;
	end: () => void;
};

type Loop = {
	/** The cursor this loop was started from — the join point for anyone arriving the same way. */
	start: string | undefined;
	/** Recent pages, oldest first, bounded. A joiner matching one of these cursors resumes after it. */
	tail: RunStreamPage[];
	subscribers: Set<Subscriber>;
	/** Told to stop when the last subscriber leaves; the loop checks it between reads. */
	stopped: boolean;
};

/** A bounded push→pull channel, so one slow subscriber cannot stall the shared read. */
function subscriberChannel(): {
	subscriber: Subscriber;
	iterable: AsyncIterable<RunStreamPage>;
} {
	const queue: RunStreamPage[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	const nudge = () => {
		wake?.();
		wake = undefined;
	};
	return {
		subscriber: {
			push: (page) => {
				queue.push(page);
				nudge();
			},
			end: () => {
				ended = true;
				nudge();
			},
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				while (true) {
					const next = queue.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					if (ended) return;
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			},
		},
	};
}

/**
 * Wrap a port so watchers of one key share a single underlying reader.
 *
 * `append` and `read` pass through untouched — this changes who does the SUBSCRIBING, nothing about
 * what is stored or how a one-shot read behaves.
 */
export function sharedStream(
	port: RunStreamPort,
	options?: { tailPages?: number },
): RunStreamPort {
	const tailPages = options?.tailPages ?? DEFAULT_TAIL_PAGES;
	const loops = new Map<string, Loop>();

	/** Everything the loop has emitted after `cursor`, or null when that position is not one it has
	 *  stood at. `null` is the honest answer that sends a joiner to its own reader. */
	const tailAfter = (
		loop: Loop,
		cursor: string | undefined,
	): RunStreamPage[] | null => {
		if (cursor === loop.start) return [...loop.tail];
		const at = loop.tail.findIndex((page) => page.cursor === cursor);
		return at === -1 ? null : loop.tail.slice(at + 1);
	};

	const runLoop = async (key: string, loop: Loop): Promise<void> => {
		const source =
			port.watch !== undefined
				? port.watch(key, loop.start)
				: pollingWatch(port, key, { since: loop.start });
		const pages = source[Symbol.asyncIterator]();
		try {
			while (!loop.stopped) {
				const next = await pages.next();
				if (next.done) break;
				const page = next.value;
				loop.tail.push(page);
				if (loop.tail.length > tailPages) loop.tail.shift();
				for (const subscriber of loop.subscribers) subscriber.push(page);
				// A STALE page ends the log for everyone on it, not just whoever noticed: the cursors
				// these subscribers hold all point past what the backing still has.
				if (page.stale) break;
			}
		} catch {
			// The underlying read failed. Subscribers are ENDED rather than thrown into: this is a
			// buffer, and a watcher whose stream stops is in the same position as one whose
			// connection dropped — it reconnects. Throwing would surface a backing's outage as an
			// exception in code that only asked to watch.
		} finally {
			await pages.return?.(undefined);
			loops.delete(key);
			for (const subscriber of loop.subscribers) subscriber.end();
			loop.subscribers.clear();
		}
	};

	return {
		...port,
		watch: (key, cursor) => {
			const existing = loops.get(key);
			const replay = existing ? tailAfter(existing, cursor) : null;
			if (existing !== undefined && replay !== null) {
				const { subscriber, iterable } = subscriberChannel();
				existing.subscribers.add(subscriber);
				// Caught up from memory FIRST, then live — so a joiner never waits on the backing at
				// all, which is the latency this whole file exists to remove.
				for (const page of replay) subscriber.push(page);
				return (async function* joined() {
					try {
						yield* iterable;
					} finally {
						existing.subscribers.delete(subscriber);
						if (existing.subscribers.size === 0) existing.stopped = true;
					}
				})();
			}
			// A JOIN POINT THIS LOOP HAS NOT STOOD AT — a reconnect mid-page, or a second loop for the
			// same key. Its own reader, which is what every watcher had before this wrapper existed.
			if (existing !== undefined) {
				return port.watch !== undefined
					? port.watch(key, cursor)
					: pollingWatch(port, key, { since: cursor });
			}

			const loop: Loop = {
				start: cursor,
				tail: [],
				subscribers: new Set(),
				stopped: false,
			};
			loops.set(key, loop);
			const { subscriber, iterable } = subscriberChannel();
			loop.subscribers.add(subscriber);
			// NOT awaited: the loop runs for as long as anybody is listening, and its failures are
			// handled inside it.
			void runLoop(key, loop);
			return (async function* leading() {
				try {
					yield* iterable;
				} finally {
					loop.subscribers.delete(subscriber);
					if (loop.subscribers.size === 0) {
						loop.stopped = true;
						loops.delete(key);
					}
				}
			})();
		},
	};
}
