// THE RUN STREAM OVER A KEY-VALUE SUBSTRATE — the default implementation of `RunStreamPort`.
//
// Three keys per stream, and the layout is the whole design:
//
//   <key>:seq        the offset counter, allocated with `increment`
//   <key>:<n>        one chunk, JSON
//   (nothing else)   there is no index, no list, no set — a reader walks n upward from its cursor
//
// WHY `increment` IS REQUIRED HERE and optional on the port. Concurrent writers into one log is the
// NORMAL case, not an edge: a thread-keyed stream carries every live run in that conversation, and
// multiplayer means two people can be mid-turn at once. A `get`-then-`set` counter loses a chunk the
// moment that happens. So a substrate without `increment` is refused rather than quietly degraded —
// which is exactly what `SecondaryStorage` says a consumer of an optional member must do.
//
// EXPIRY IS THE CLEANUP, and it is load-bearing rather than tidy: it is what bounds how long
// best-effort-redacted text exists at all (docs/plans/one-run.md D17). There is no delete hook to
// sequence after the terminal write and no age sweep to fund.

import type {
	RunStreamChunk,
	RunStreamPage,
	RunStreamPort,
	SecondaryStorage,
} from "@busyclaw/contracts";
import { configurationError } from "@busyclaw/contracts";

/**
 * How long a chunk and its counter live, in seconds.
 *
 * The counter's window has to exceed the LONGEST RUN, not the longest gap between chunks: it is born
 * with the first chunk and never refreshed (that is what keeps a busy counter from becoming
 * immortal), so a run still writing after it expires would restart numbering underneath its own
 * readers. An hour covers a run that parks for approval over a coffee break; past that the watcher is
 * told it is stale and reads the transcript, which is the correct answer anyway.
 */
const DEFAULT_TTL_SECONDS = 3600;

function chunkKey(key: string, offset: number): string {
	return `${key}:${offset}`;
}

function counterKey(key: string): string {
	return `${key}:seq`;
}

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined || cursor === "") return 0;
	const parsed = Number(cursor);
	// A cursor is this port's own output round-tripped through a client — but it arrives over
	// `Last-Event-ID`, which is to say from the network, so it is untrusted input. A garbage value
	// reads from the start rather than throwing: the worst case is a watcher seeing the answer twice,
	// against an error page for a header nobody typed.
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * A `RunStreamPort` over any `SecondaryStorage` — the default whenever a host has one.
 *
 * No `watch`: this substrate cannot express one. A watcher over this polls, which is why a host that
 * wants push implements the port directly over Redis Streams or LISTEN/NOTIFY instead of reaching
 * for this.
 */
export function secondaryStorageStream(
	kv: SecondaryStorage,
	options?: { ttlSeconds?: number; maxChunksPerRead?: number },
): RunStreamPort {
	const increment = kv.increment;
	if (increment === undefined) {
		throw configurationError(
			"this secondaryStorage cannot back a run stream: it has no `increment`",
			{
				reason:
					"offsets must be allocated atomically because two runs in one thread write concurrently; a get-then-set counter drops chunks",
			},
		);
	}
	const ttl = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
	// A bound on ONE read, not on the stream. A late joiner reading a long answer pages through it;
	// the cursor comes back short of `max` and the next read continues. Unbounded would mean one
	// watcher attaching to a 500-chunk turn issues 500 sequential gets before its first frame.
	const maxPerRead = options?.maxChunksPerRead ?? 64;

	return {
		append: async (key, chunk) => {
			const offset = await increment(counterKey(key), ttl);
			await kv.set(chunkKey(key, offset), JSON.stringify(chunk), ttl);
		},

		read: async (key, cursor): Promise<RunStreamPage> => {
			const from = parseCursor(cursor);
			const rawMax = await kv.get(counterKey(key));
			const max = rawMax === null || rawMax === undefined ? 0 : Number(rawMax);
			// THE STALE CHECK. `max` below the cursor means the counter reset under this reader — the
			// window expired while they were away — so the offsets no longer mean what their cursor
			// thinks. Say so; do not hand back chunks that merely happen to sit at those numbers.
			if (!Number.isSafeInteger(max) || max < from) {
				return { chunks: [], cursor: String(from), stale: true };
			}

			const chunks: RunStreamChunk[] = [];
			let at = from;
			while (at < max && chunks.length < maxPerRead) {
				at += 1;
				const raw = await kv.get(chunkKey(key, at));
				// A HOLE. The counter allocated this offset but the chunk is gone — either the writer
				// died between `increment` and `set`, or this one entry expired first. Skipped rather
				// than treated as the end: stopping here would strand the reader below a `max` that
				// will never come back down, and they would sit on a dead cursor forever.
				if (raw === null || raw === undefined) continue;
				const parsed = safeParse(raw);
				if (parsed !== null) chunks.push(parsed);
			}
			return { chunks, cursor: String(at), stale: false };
		},
	};
}

/** A chunk this port did not write, or wrote in an older shape, is DROPPED rather than thrown on. A
 *  buffer is not a record: one unreadable entry must not take down a live view of everything else. */
function safeParse(raw: unknown): RunStreamChunk | null {
	if (typeof raw !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const kind = (parsed as { kind?: unknown }).kind;
		if (kind !== "text" && kind !== "lifecycle" && kind !== "run.started") {
			return null;
		}
		return parsed as RunStreamChunk;
	} catch {
		return null;
	}
}
