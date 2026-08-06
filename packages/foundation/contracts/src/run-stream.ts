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

import { entity, field } from "./entity";
import type { Principal } from "./governance/principal";

/**
 * What ended a run's participation in the stream — or paused it.
 *
 * `yielded` and `parked` are BOTH pauses and they are not the same pause, which is the whole reason
 * they are separate members. A yield left a continuation behind and comes back on its own; a park
 * waits for somebody to say a verb. A reader shown "paused" for both cannot tell "still working" from
 * "waiting for you" — and the transcript already tells them apart (`step` vs `park` checkpoint kinds,
 * docs/plans/one-run.md D10), so collapsing them here made two doors onto one fact disagree.
 *
 * `superseded` is neither: a NEW attempt of the same run has taken over and the previous attempt's
 * chunks should be dropped.
 */
export type RunStreamLifecycle =
	| "yielded"
	| "parked"
	| "resumed"
	| "superseded"
	| "completed"
	// A GOVERNED CALL WAS REFUSED, and the run ended there. Terminal like `completed`, and not the
	// same thing: the transcript records a denial as its own state (D10), so a stream that reported
	// it as a completion would have the two doors disagreeing about whether the action happened.
	| "denied"
	| "failed"
	| "cancelled";

/**
 * The members after which this run will never produce another chunk.
 *
 * ONE DECLARATION, because three places branch on it — `watchRun` decides when to stop holding a
 * connection open, the AI SDK bridge decides when to `finish` a message, and the emitter decides
 * what to send. Each had its own inline list, and the cost of them disagreeing is not symmetric: a
 * watcher that stops early truncates an answer, while one that never stops holds an HTTP connection
 * open forever for a turn that finished.
 */
export const terminalRunStreamLifecycle = [
	"completed",
	"denied",
	"failed",
	"cancelled",
] as const satisfies readonly RunStreamLifecycle[];

export const isTerminalRunStreamLifecycle = (
	event: RunStreamLifecycle,
): boolean => (terminalRunStreamLifecycle as readonly string[]).includes(event);

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
	/**
	 * WHICH TOOL a run is on, so a watcher can render "running send_email…" instead of a stall
	 * during a call that takes ten seconds and produces no text.
	 *
	 * NO ARGUMENTS AND NO OUTPUT, deliberately. A watcher needs to know which tool is running, not
	 * what it was passed — and tool arguments are the single richest source of PII in a run. Adding
	 * them would be a disclosure decision, and one that should be taken on purpose rather than
	 * inherited from "the event already had them".
	 *
	 * `attempt` is OPTIONAL here and required on the others, because this chunk comes from the
	 * runtime's EVENT stream, which observes a run without knowing which claim is driving it. That
	 * is a real gap and a tolerable one: `attempt` exists to stop two generations of TEXT being
	 * spliced into one sentence, and a stale "running send_email" is a cosmetic blip rather than a
	 * corrupted answer.
	 */
	| {
			kind: "tool";
			runId: string;
			attempt?: number;
			step: number;
			toolCallId: string;
			toolName: string;
			status: "called" | "completed" | "waiting_approval" | "denied" | "failed";
	  }
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
	/**
	 * Append one chunk. Writes are ADVISORY — a caller must be able to drop a failure on the floor,
	 * because the stream may never fail a run.
	 *
	 * Returns NOTHING, deliberately. It used to hand back the offset it wrote at, which read as
	 * useful and was not: no caller has ever used it, and it cannot be honoured by a backend whose
	 * ids are not numbers — a Redis stream id is `<ms>-<seq>`. A return value nobody consumes is not
	 * free when it constrains which implementations can exist.
	 */
	append: (key: string, chunk: RunStreamChunk) => Promise<void>;
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

// ── THE DATABASE BACKING, for a deployment with no KV and no Redis ───────────────────────────────
//
// A CORE table rather than an engine's, for the same reason `run` is: whatever schedules the work,
// somebody may be watching it. It is the only backing that needs a schema at all — the KV and Redis
// implementations bring their own storage — and it exists so a claw configured with `{ model,
// database }` and nothing else can still be watched, instead of live watching being a feature you
// discover you cannot have.
//
// A TRANSPORT BUFFER IN A DURABLE STORE is a contradiction worth naming: rows here are swept by age,
// never read after their run's turn lands in the transcript, and carry the same standing invariant
// as every other backing — this must never become the read path for a finished run. It is a table
// because that is the only storage this deployment has, not because these are records.

export const runStreamChunkFields = {
	// TIME-ORDERED and unique, so `id > cursor` is both the resume test and the sort — no second
	// column to keep in step, and no clock comparison that two writers in one millisecond can tie.
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	/** `thread:<id>` or `run:<id>` — the subscription this chunk belongs to. */
	streamKey: field.string({ required: true, index: true, immutable: true }),
	/** Monotone WITHIN a key, allocated by a compare-and-set retry against the unique below. Two
	 *  runs in one thread write concurrently, so an unfenced `max + 1` would collide. */
	seq: field.number({ required: true, immutable: true }),
	/**
	 * The chunk, as the same JSON every other backing stores.
	 *
	 * `pii: "possible"` because it is: streamed text carries the transcript's placeholders, and the
	 * residual `createStreamGuard` documents means a span split across a held boundary can arrive
	 * untokenized. Declared so a reader of this schema is not told it is clean.
	 */
	chunk: field.string({ required: true, pii: "possible", immutable: true }),
	/** Swept on, and filtered on at read — an unswept row is never served. */
	createdAt: field.string({ required: true, index: true, immutable: true }),
} as const;

export const runStreamChunkEntity = entity(
	"run_stream_chunk",
	runStreamChunkFields,
	{
		// The CAS target. Without it two concurrent writers both read the same `max(seq)` and both
		// insert it, and one chunk is silently lost — the failure the KV backing avoids by having
		// `increment` and this one has to earn.
		uniques: [["streamKey", "seq"]],
	},
);

export const runStreamSchema = { ...runStreamChunkEntity.storage };
