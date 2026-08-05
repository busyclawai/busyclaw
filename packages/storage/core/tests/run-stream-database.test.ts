import type { Adapter } from "@busyclaw/contracts";
import { conflictError } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { databaseStream, memoryAdapter } from "../src/index";

/**
 * `memoryAdapter` does NOT enforce uniques — it says so itself (`enforcesUnique: false`). So a
 * concurrency test against it proves only that nothing was lost, which is trivially true when no
 * constraint can be violated: the CAS retry this backing depends on never fires.
 *
 * This wrapper enforces `(streamKey, seq)` the way a real database would, so the retry path is
 * exercised rather than assumed.
 */
function uniqueEnforcing(inner: Adapter): Adapter {
	const taken = new Set<string>();
	return {
		...inner,
		create: async (input) => {
			const row = input.data as { streamKey?: unknown; seq?: unknown };
			const slot = `${String(row.streamKey)}:${String(row.seq)}`;
			if (taken.has(slot)) {
				throw conflictError("unique constraint violated on run_stream_chunk", {
					model: "run_stream_chunk",
				});
			}
			taken.add(slot);
			return inner.create(input);
		},
	};
}

const text = (runId: string, body: string) =>
	({ kind: "text", runId, attempt: 1, text: body }) as const;

describe("databaseStream", () => {
	it("reads back what was appended, and a cursor resumes rather than replays", async () => {
		const stream = databaseStream(memoryAdapter());
		await stream.append("thread:t1", text("r1", "one "));
		await stream.append("thread:t1", text("r1", "two"));

		const first = await stream.read("thread:t1");
		expect(first.chunks).toHaveLength(2);
		expect(first.stale).toBe(false);
		expect(first.cursor).toBe("2");

		const idle = await stream.read("thread:t1", first.cursor);
		expect(idle.chunks).toEqual([]);
		expect(idle.stale).toBe(false);

		await stream.append("thread:t1", text("r1", "!"));
		expect((await stream.read("thread:t1", first.cursor)).chunks).toMatchObject(
			[{ text: "!" }],
		);
	});

	/**
	 * THE ORDERING THIS BACKING HAS TO EARN. A KV allocates offsets with an atomic `increment` and
	 * Redis allocates its own ids; a generic Adapter has neither, so `seq` is a compare-and-set
	 * against a `(streamKey, seq)` unique. Two runs writing one thread at once is the normal
	 * multiplayer case, and an unfenced `max + 1` loses a chunk every time they collide.
	 */
	it("loses no chunk when two runs write one key concurrently", async () => {
		const stream = databaseStream(uniqueEnforcing(memoryAdapter()));
		await Promise.all([
			...Array.from({ length: 12 }, (_, i) =>
				stream.append("thread:t1", text("alice", `a${i}`)),
			),
			...Array.from({ length: 12 }, (_, i) =>
				stream.append("thread:t1", text("bob", `b${i}`)),
			),
		]);

		const page = await stream.read("thread:t1");
		expect(page.chunks).toHaveLength(24);
		expect(page.chunks.filter((c) => c.runId === "alice")).toHaveLength(12);
		expect(page.chunks.filter((c) => c.runId === "bob")).toHaveLength(12);
		// Every slot distinct — which is what the retry buys, and what a lost CAS would break.
		expect(new Set(page.chunks.map((c) => JSON.stringify(c))).size).toBe(24);
	});

	/** Separate conversations keep separate sequences — `seq` is monotone WITHIN a key, not across. */
	it("numbers each key independently", async () => {
		const stream = databaseStream(memoryAdapter());
		await stream.append("thread:a", text("r1", "one"));
		await stream.append("thread:b", text("r2", "one"));

		expect((await stream.read("thread:a")).cursor).toBe("1");
		expect((await stream.read("thread:b")).cursor).toBe("1");
	});

	/**
	 * EXPIRY IS WHAT MAKES A DURABLE TABLE A TRANSPORT BUFFER. The sweep rides the write and is
	 * best-effort, so the READ FILTER is what actually bounds the window — an unswept row must never
	 * be served, or the buffer quietly becomes a record.
	 */
	it("stops serving a chunk once its window has passed", async () => {
		let clock = 1_000_000;
		const stream = databaseStream(memoryAdapter(), {
			ttlSeconds: 10,
			now: () => clock,
		});
		await stream.append("thread:t1", text("r1", "briefly"));
		expect((await stream.read("thread:t1")).chunks).toHaveLength(1);

		clock += 11_000;
		expect((await stream.read("thread:t1")).chunks).toEqual([]);
	});

	/** A cursor into rows that have been swept away refers to nothing, and must say so rather than
	 *  reporting "caught up" — the client has to reload the transcript, not keep waiting. */
	it("reports stale when the rows behind a cursor are gone", async () => {
		let clock = 1_000_000;
		const db = memoryAdapter();
		const stream = databaseStream(db, { ttlSeconds: 10, now: () => clock });
		await stream.append("thread:t1", text("r1", "one"));
		await stream.append("thread:t1", text("r1", "two"));
		const page = await stream.read("thread:t1");
		expect(page.cursor).toBe("2");

		// The window passes and a later write sweeps the expired rows.
		clock += 11_000;
		await db.deleteMany?.({
			model: "run_stream_chunk",
			where: [{ field: "streamKey", value: "thread:t1" }],
		});

		const resumed = await stream.read("thread:t1", page.cursor);
		expect(resumed.stale).toBe(true);
		expect(resumed.chunks).toEqual([]);
	});

	/** …and a reader that is merely caught up is NOT stale. Conflating the two ends every idle
	 *  watcher the moment it catches up with the writer. */
	it("does not call a caught-up reader stale", async () => {
		const stream = databaseStream(memoryAdapter());
		await stream.append("thread:t1", text("r1", "one"));
		const page = await stream.read("thread:t1");
		expect((await stream.read("thread:t1", page.cursor)).stale).toBe(false);
	});

	it("pages a long answer rather than loading all of it", async () => {
		const stream = databaseStream(memoryAdapter(), { maxChunksPerRead: 4 });
		for (let i = 0; i < 10; i++) {
			await stream.append("thread:t1", text("r1", `d${i}`));
		}
		const first = await stream.read("thread:t1");
		expect(first.chunks).toHaveLength(4);
		const second = await stream.read("thread:t1", first.cursor);
		expect(second.chunks).toHaveLength(4);
		expect((await stream.read("thread:t1", second.cursor)).chunks).toHaveLength(
			2,
		);
	});

	/** The sweep removes what the read filter already hides, so the table does not grow without
	 *  bound just because nobody is reading. */
	it("deletes expired rows as later chunks arrive", async () => {
		let clock = 1_000_000;
		const db = memoryAdapter();
		const stream = databaseStream(db, { ttlSeconds: 10, now: () => clock });
		await stream.append("thread:t1", text("r1", "old"));

		clock += 11_000;
		await stream.append("thread:t1", text("r1", "new"));

		const rows = await db.findMany({
			model: "run_stream_chunk",
			where: [{ field: "streamKey", value: "thread:t1" }],
		});
		expect(rows).toHaveLength(1);
	});
});
