// COALESCE TEXT BEFORE IT REACHES THE BACKEND.
//
// A model emits 200–500 deltas a turn. One write each is 200–500 round trips to Redis or a KV per
// answer — which works, and is roughly ten times what the design calls for (docs/plans/one-run.md
// D17): batching at ~50 ms brings it to 20–50. On a per-operation-billed store that is the
// difference between cheap and not, and on a database backend it is the difference between a stream
// and a write storm.
//
// A WRAPPER AROUND A PORT, not a change to its writers. Every producer — the door driving its own
// turn, the cron drain finishing a parked one — already writes through `append`, so wrapping the
// port batches all of them and none of them learn about it.
//
// WHAT MAKES IT SAFE without anyone remembering to flush: a non-text chunk flushes first, and every
// slice ends with one (`lifecycle`). So the buffer cannot outlive the work that filled it, and text
// can never be delivered after the "completed" that follows it. The timer is what covers the gap
// mid-answer; the ordering rule is what covers the end.

import type { RunStreamChunk, RunStreamPort } from "@busyclaw/contracts";

// DECLARED, not imported — this package compiles with no DOM or Node lib. See ./polling.ts.
declare const setTimeout: (callback: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: never) => void;

/**
 * How long text may sit unflushed.
 *
 * It is the watcher's added latency and nothing else's — the driver's own reader is served from
 * memory and never waits on this. Around one frame at 20fps: below the point a person reads text
 * arriving as "laggy", and an order of magnitude fewer writes.
 */
export const DEFAULT_BATCH_MS = 50;

/** Flush early once the buffer reaches this many characters, so one very fast answer cannot hold a
 *  large string for the whole window. */
export const DEFAULT_BATCH_CHARS = 4_000;

export type BatchedStreamOptions = {
	windowMs?: number;
	maxChars?: number;
};

/**
 * Wrap a port so consecutive `text` chunks of the same run and attempt are written as one.
 *
 * Coalescing is CONCATENATION, so a reader sees exactly the characters the model produced, in order
 * — just in fewer pieces. Nothing downstream can tell the difference, which is why this is safe to
 * apply by default.
 */
export function batchedStream(
	port: RunStreamPort,
	options?: BatchedStreamOptions,
): RunStreamPort {
	const windowMs = options?.windowMs ?? DEFAULT_BATCH_MS;
	const maxChars = options?.maxChars ?? DEFAULT_BATCH_CHARS;

	// One buffer per stream key. Keyed, because a single process drives many conversations and their
	// text must not be concatenated into each other's.
	type Pending = { runId: string; attempt: number; text: string };
	const pending = new Map<string, Pending>();
	const timers = new Map<string, never>();

	const cancelTimer = (key: string): void => {
		const handle = timers.get(key);
		if (handle !== undefined) {
			clearTimeout(handle);
			timers.delete(key);
		}
	};

	const flush = async (key: string): Promise<void> => {
		cancelTimer(key);
		const buffered = pending.get(key);
		if (buffered === undefined) return;
		pending.delete(key);
		await port.append(key, {
			kind: "text",
			runId: buffered.runId,
			attempt: buffered.attempt,
			text: buffered.text,
		});
	};

	return {
		...port,
		append: async (key, chunk) => {
			if (chunk.kind !== "text") {
				// ORDER IS THE POINT. Flushing first is what keeps a `completed` from overtaking the
				// words it completes — a watcher would otherwise see the turn end and then receive its
				// last sentence.
				await flush(key);
				await port.append(key, chunk);
				return;
			}
			const buffered = pending.get(key);
			// A DIFFERENT run or attempt cannot be concatenated onto this one: two people mid-turn in
			// one conversation write the same key, and a superseding attempt writes it too.
			if (
				buffered !== undefined &&
				(buffered.runId !== chunk.runId || buffered.attempt !== chunk.attempt)
			) {
				await flush(key);
			}
			const current = pending.get(key);
			if (current === undefined) {
				pending.set(key, {
					runId: chunk.runId,
					attempt: chunk.attempt,
					text: chunk.text,
				});
			} else {
				current.text += chunk.text;
			}
			const held = pending.get(key);
			if (held !== undefined && held.text.length >= maxChars) {
				await flush(key);
				return;
			}
			if (timers.has(key)) return;
			// FLOATING, and it must be: awaiting the window here would make every delta take `windowMs`,
			// which is the opposite of batching. A failure inside it is swallowed for the same reason
			// every write to this buffer is advisory.
			timers.set(
				key,
				setTimeout(() => {
					void flush(key).catch(() => undefined);
				}, windowMs) as never,
			);
		},
	};
}
