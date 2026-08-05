// THE RUN STREAM — live deltas of work in flight, for everyone who is not driving it.
//
// See docs/plans/one-run.md D17 for the reasoning. The parts that constrain this file:
//
// IT IS A TRANSPORT BUFFER, NOT A RECORD. Every chunk here is worthless the moment the turn lands in
// the transcript, which is where a finished answer is read from. Two consequences that are not
// hygiene: an implementation may expire whatever it likes whenever it likes, and — the standing
// invariant — **this must never become the read path for a finished run**. Streamed text is redacted
// best-effort by `createStreamGuard` (a span split across a held chunk boundary escapes), whereas the
// transcript is redacted whole. Serving a completed turn from here to save a query would promote the
// weaker redaction to the record, and erasure cannot repair it because an uncaught span was never
// mapped and has nothing to shred.
//
// THE KEY IS THE SUBSCRIPTION, NOT THE RUN. `thread:<threadId>` when the run has a thread,
// `run:<runId>` when it does not (cron, a subagent). Keying by run would look tidier and puts the
// discovery problem one level down: a watcher is looking at a CONVERSATION and does not know run
// ids, and a `run.started` chunk cannot live in a log you need the run id to open.

import type { Principal } from "./governance/principal";

/** What ended a run's participation in the stream. `superseded` is not terminal — it says a NEW
 *  attempt of the same run has taken over and the previous attempt's chunks should be dropped. */
export type RunStreamLifecycle =
	| "parked"
	| "resumed"
	| "superseded"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * One entry in the log.
 *
 * EVERY CHUNK CARRIES `runId` AND `attempt`, and the two do different jobs. `runId` demultiplexes
 * MULTIPLAYER — two people sending into one thread is two live runs whose chunks legitimately
 * interleave, and a client renders them as two bubbles. `attempt` separates two GENERATIONS of ONE
 * run, which is the bug case: the buffer sits outside the lease fence, so a driver whose lease
 * lapsed still holds a handle and keeps writing while its successor writes too. A client keeps the
 * highest attempt seen per runId and drops anything below it; the successor announces itself with a
 * `superseded` lifecycle chunk.
 *
 * `text` is REDACTED — the same placeholders the transcript will hold (R-M04). Do not add a variant
 * carrying original values; the audited read is `listMessages({ view: "original" })`.
 */
export type RunStreamChunk =
	| {
			kind: "run.started";
			runId: string;
			attempt: number;
			/** Whose turn this is. A watcher needs it to label the bubble before any text arrives. */
			by?: Principal;
	  }
	| { kind: "text"; runId: string; attempt: number; text: string }
	| {
			kind: "lifecycle";
			runId: string;
			attempt: number;
			event: RunStreamLifecycle;
			/** Why, when there is a why worth showing — "waiting for approval" rather than a stall. */
			reason?: string;
	  };

/** One read of the log from a cursor. */
export type RunStreamPage = {
	chunks: RunStreamChunk[];
	/** Where to resume. Opaque to every consumer — it is what SSE puts in `id:` and what the browser
	 *  hands back as `Last-Event-ID`, so its shape is this port's business and nobody else's. */
	cursor: string;
	/**
	 * The cursor pointed PAST the end of the log, so this read cannot be trusted to be a continuation.
	 *
	 * Reachable in normal operation: a thread's log is sparse and long-lived while its entries expire,
	 * so a client that was away longer than the ttl comes back with a cursor above a counter that has
	 * since reset. The honest answer is "you are stale" — reload the transcript and start again — not
	 * a silent replay of unrelated chunks at coincidentally-matching offsets.
	 */
	stale: boolean;
};

/**
 * Where live deltas go, and where watchers read them from.
 *
 * `secondaryStorage` is the SUBSTRATE this is usually built over, not this seam itself: it has no
 * blocking read and no subscription (`get`/`set`/`increment`/`getAndDelete`/`delete`), so a watcher
 * built directly on it polls — and would still poll with Redis configured, which throws away the one
 * capability (`XREAD BLOCK`, pub/sub) that buying Redis is for. Hence a port with `watch?`: hosts
 * that can push fill it in, everyone else gets the polling default and the same `watchThread`.
 */
export type RunStreamPort = {
	/** Append one chunk and return its offset. Writes are ADVISORY — a caller must be able to drop a
	 *  failure on the floor, because the stream may never fail a run. */
	append: (key: string, chunk: RunStreamChunk) => Promise<number>;
	/** Everything after `cursor` (from the start when absent). */
	read: (key: string, cursor?: string) => Promise<RunStreamPage>;
	/**
	 * PUSH, for a backend that has it (Redis Streams, LISTEN/NOTIFY, a Durable Object). Optional
	 * because most do not: a consumer must check for it and fall back to polling deliberately, never
	 * assume it. Yields pages as they arrive and ends when the caller stops iterating.
	 */
	watch?: (key: string, cursor?: string) => AsyncIterable<RunStreamPage>;
};

/** The stream key for a run that belongs to a conversation — the normal case, and what a watcher
 *  subscribes to, because a thread is the thing a person is looking at. */
export function threadStreamKey(threadId: string): string {
	return `thread:${threadId}`;
}

/** The stream key for a run with no thread: cron work, a subagent. Nobody is watching a conversation
 *  because there is not one, so the run is its own subscription. */
export function runStreamKey(runId: string): string {
	return `run:${runId}`;
}
