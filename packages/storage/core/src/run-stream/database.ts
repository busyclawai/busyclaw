// THE RUN STREAM OVER THE DATABASE THE CLAW ALREADY HAS — the backing of last resort, and the one
// that makes live watching the default rather than something a deployment discovers it lacks.
//
// A claw configured with `{ model, database }` and nothing else had a `runStream` of `undefined`, so
// `watchThread` refused. That is the correct answer to "you configured nothing", and the wrong
// answer to "you configured a database" — which is the shape of almost every first deployment.
//
// IT IS STILL A TRANSPORT BUFFER. Rows are swept by age and filtered by age on read, so an unswept
// row is never served; the standing invariant holds unchanged — this must never become the read path
// for a finished run, whose answer is read from the transcript.
//
// THE COST, STATED. Every other backing gives ordering for free: the KV allocates offsets with an
// atomic `increment`, Redis allocates entry ids itself. A generic `Adapter` has neither, so this one
// EARNS its ordering with a compare-and-set against a `(streamKey, seq)` unique — read the tail,
// insert the next, retry on conflict. That is the same shape `admitMessage` already uses, and it is
// why a host with a KV should hand it over: this works, and it costs a read and sometimes a retry
// per write where the others cost neither.

import type {
	Adapter,
	RunStreamChunk,
	RunStreamPage,
	RunStreamPort,
} from "@busyclaw/contracts";
import { isConflict } from "@busyclaw/contracts";
import { decodeChunk, encodeChunk } from "./chunk";

const MODEL = "run_stream_chunk";

/** How long a chunk is served and kept. Same window as the other backings, for the same reason: it
 *  bounds how long best-effort-redacted text exists at all (docs/plans/one-run.md D17). */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Attempts at allocating a `seq` before giving up.
 *
 * It bounds CONCURRENT WRITERS on one key, not contention in the abstract, because a loser walks to
 * the next slot rather than re-reading the tail (see `append`). An earlier version re-read the tail
 * on every conflict, which made this a hard ceiling instead: with N writers racing, each round let
 * exactly one through, so a budget of 8 silently dropped everything past the eighth. A test firing
 * 24 at once found it.
 */
const MAX_SEQ_ATTEMPTS = 64;

/** Rows per read. A late joiner pages through a long answer rather than loading all of it. */
const DEFAULT_MAX_CHUNKS_PER_READ = 64;

export type DatabaseStreamOptions = {
	ttlSeconds?: number;
	maxChunksPerRead?: number;
	/** Injectable for tests; defaults to wall clock. */
	now?: () => number;
	newId?: () => string;
};

type ChunkRow = {
	id: string;
	streamKey: string;
	seq: number;
	chunk: string;
	createdAt: string;
};

function rowOf(value: unknown): ChunkRow | null {
	if (value === null || typeof value !== "object") return null;
	const row = value as Partial<ChunkRow>;
	return typeof row.seq === "number" && typeof row.chunk === "string"
		? (row as ChunkRow)
		: null;
}

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined || cursor === "") return 0;
	const parsed = Number(cursor);
	// Arrives over `Last-Event-ID`, which is to say from the network. Garbage reads from the start
	// rather than throwing — the worst case is a watcher seeing the answer twice.
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * A `RunStreamPort` over any storage `Adapter`.
 *
 * No `watch`: a generic adapter has no subscription. Watchers poll, which is what
 * `pollingWatch` does for every backing that cannot push.
 */
export function databaseStream(
	adapter: Adapter,
	options?: DatabaseStreamOptions,
): RunStreamPort {
	const ttlMs = (options?.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
	const perRead = options?.maxChunksPerRead ?? DEFAULT_MAX_CHUNKS_PER_READ;
	const now = options?.now ?? (() => Date.now());
	const mintId =
		options?.newId ??
		(() =>
			`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

	const expiryCutoff = (): string => new Date(now() - ttlMs).toISOString();

	/** The highest `seq` this key holds, or 0. One indexed read, ordered descending, limit one. */
	const tailSeq = async (streamKey: string): Promise<number> => {
		const rows = await adapter.findMany({
			model: MODEL,
			where: [{ field: "streamKey", value: streamKey }],
			sortBy: [{ field: "seq", direction: "desc" }],
			limit: 1,
		});
		const row = rowOf(rows[0]);
		return row ? row.seq : 0;
	};

	return {
		append: async (streamKey, chunk) => {
			const encoded = encodeChunk(chunk);
			// READ THE TAIL ONCE, then WALK on conflict. Re-reading it each time makes every racing
			// writer aim at the same slot again, so each round admits exactly one and the retry budget
			// becomes a cap on concurrency. Walking means a loser takes the next free slot instead of
			// queueing behind everyone, which converges in about as many attempts as there are
			// writers — and costs one read per append rather than one per attempt.
			let seq = (await tailSeq(streamKey)) + 1;
			for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++, seq++) {
				try {
					await adapter.create({
						model: MODEL,
						data: {
							id: mintId(),
							streamKey,
							seq,
							chunk: encoded,
							createdAt: new Date(now()).toISOString(),
						},
					});
					// THE SWEEP RIDES THE WRITE, so there is no background job to fund and no age
					// column anybody has to remember to sweep. Best-effort by design: a failure here
					// leaves rows a later append (or the read filter) handles, and must never fail the
					// write that just succeeded.
					try {
						await adapter.deleteMany?.({
							model: MODEL,
							where: [
								{ field: "streamKey", value: streamKey },
								{
									field: "createdAt",
									operator: "lt",
									value: expiryCutoff(),
									connector: "AND",
								},
							],
						});
					} catch {
						// Growth is bounded by the next append's attempt and by the read filter.
					}
					return;
				} catch (error) {
					// A LOST CAS, which is the normal outcome of two runs writing one thread at once.
					// Re-read the tail and take the next slot; anything else is a real failure.
					if (!isConflict(error)) throw error;
				}
			}
			// Advisory: a chunk that could not find a slot is dropped rather than failing the run. The
			// caller already treats every write here as droppable, so throwing would only move the
			// swallow one frame up.
		},

		read: async (streamKey, cursor): Promise<RunStreamPage> => {
			const from = parseCursor(cursor);
			const rows = await adapter.findMany({
				model: MODEL,
				where: [
					{ field: "streamKey", value: streamKey },
					{ field: "seq", operator: "gt", value: from, connector: "AND" },
					// AN UNSWEPT ROW IS NEVER SERVED. The sweep is best-effort, so the read filter is
					// what actually bounds the window rather than merely tidying it.
					{
						field: "createdAt",
						operator: "gte",
						value: expiryCutoff(),
						connector: "AND",
					},
				],
				sortBy: [{ field: "seq", direction: "asc" }],
				limit: perRead,
			});

			const chunks: RunStreamChunk[] = [];
			let at = from;
			for (const value of rows) {
				const row = rowOf(value);
				if (!row) continue;
				at = row.seq;
				const parsed = decodeChunk(row.chunk);
				if (parsed !== null) chunks.push(parsed);
			}

			if (chunks.length > 0 || at > from) {
				return { chunks, cursor: String(at), stale: false };
			}
			// NOTHING AFTER THE CURSOR. Either the reader is caught up, or the rows it was pointing
			// past have been swept out from under it — and those need different answers, so ask what
			// the key still holds rather than guessing.
			const tail = await tailSeq(streamKey);
			return { chunks: [], cursor: String(from), stale: tail < from };
		},
	};
}
