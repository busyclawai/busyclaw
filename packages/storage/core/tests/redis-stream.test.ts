// `redisStream` against a fake that implements the four commands it issues, with Redis's ACTUAL
// semantics for each — XREAD being exclusive from its cursor is the one everything else rests on, so
// a fake that got it inclusive would make every test here pass while the real thing double-delivered.

import type { RunStreamChunk } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { type RedisCommand, redisStream } from "../src/index";

const text = (runId: string, body: string) =>
	({ kind: "text", runId, attempt: 1, text: body }) as const;

/**
 * A Redis stand-in for XADD / XREAD / EXISTS / EXPIRE.
 *
 * Ids are `<seq>-0`, monotone per key, which is the property the port relies on: cursors compare and
 * order. Real Redis uses milliseconds, but nothing here reads a timestamp out of an id.
 */
function fakeRedis() {
	const streams = new Map<string, Array<{ id: string; json: string }>>();
	let seq = 0;
	const ttls = new Map<string, string>();
	const calls: string[][] = [];

	const send: RedisCommand = async (args) => {
		calls.push([...args]);
		const [command, ...rest] = args.map(String);
		switch (command) {
			case "XADD": {
				const key = rest[0] ?? "";
				// …MAXLEN ~ <n> * <field> <value>
				const json = rest[rest.length - 1] ?? "";
				const entries = streams.get(key) ?? [];
				const id = `${++seq}-0`;
				entries.push({ id, json });
				streams.set(key, entries);
				return id;
			}
			case "EXPIRE": {
				ttls.set(rest[0] ?? "", rest[1] ?? "");
				return 1;
			}
			case "EXISTS":
				return streams.has(rest[0] ?? "") ? 1 : 0;
			case "XREAD": {
				const streamsAt = rest.indexOf("STREAMS");
				const key = rest[streamsAt + 1] ?? "";
				const cursor = rest[streamsAt + 2] ?? "0";
				const countAt = rest.indexOf("COUNT");
				const count =
					countAt === -1 ? Number.POSITIVE_INFINITY : Number(rest[countAt + 1]);
				const entries = streams.get(key) ?? [];
				// EXCLUSIVE, which is what makes a cursor a resume point rather than a replay point.
				const after = entries
					.filter(
						(entry) =>
							Number(entry.id.split("-")[0]) > Number(cursor.split("-")[0]),
					)
					.slice(0, count);
				if (after.length === 0) return null;
				return [[key, after.map((entry) => [entry.id, ["c", entry.json]])]];
			}
			default:
				throw new Error(`fake redis got an unexpected command: ${command}`);
		}
	};
	return { send, streams, ttls, calls };
}

describe("redisStream", () => {
	it("reads back what was appended, and a cursor resumes rather than replays", async () => {
		const redis = fakeRedis();
		const stream = redisStream({ send: redis.send });
		await stream.append("thread:t1", text("r1", "one "));
		await stream.append("thread:t1", text("r1", "two"));

		const first = await stream.read("thread:t1");
		expect(first.chunks).toHaveLength(2);
		expect(first.stale).toBe(false);
		// The cursor is Redis's own entry id, handed through verbatim — no numbering scheme of ours.
		expect(first.cursor).toMatch(/^\d+-\d+$/);

		const idle = await stream.read("thread:t1", first.cursor);
		expect(idle.chunks).toEqual([]);
		expect(idle.stale).toBe(false);

		await stream.append("thread:t1", text("r1", "!"));
		const next = await stream.read("thread:t1", first.cursor);
		expect(next.chunks).toMatchObject([{ text: "!" }]);
	});

	/** Two runs in one thread interleave and stay separable — the multiplayer case, which Redis gets
	 *  right for free because XADD allocates the id. */
	it("keeps every chunk when two runs write the same log concurrently", async () => {
		const redis = fakeRedis();
		const stream = redisStream({ send: redis.send });
		await Promise.all([
			...Array.from({ length: 15 }, () =>
				stream.append("thread:t1", text("alice", "a")),
			),
			...Array.from({ length: 15 }, () =>
				stream.append("thread:t1", text("bob", "b")),
			),
		]);

		const page = await stream.read("thread:t1", undefined);
		expect(page.chunks).toHaveLength(30);
		expect(page.chunks.filter((c) => c.runId === "alice")).toHaveLength(15);
	});

	/**
	 * THE TTL IS REFRESHED ON EVERY APPEND, unlike the KV implementation's born-once counter.
	 * Nothing here restarts numbering, so keeping a live conversation's log alive is safe — and a
	 * dead one still expires a fixed window after its last word.
	 */
	it("extends the key's life on each write", async () => {
		const redis = fakeRedis();
		const stream = redisStream({ send: redis.send, ttlSeconds: 60 });
		await stream.append("thread:t1", text("r1", "one"));
		await stream.append("thread:t1", text("r1", "two"));

		expect(redis.ttls.get("thread:t1")).toBe("60");
		expect(redis.calls.filter((c) => c[0] === "EXPIRE")).toHaveLength(2);
	});

	/** A cursor into a stream that has been trimmed or expired away refers to nothing. Say stale;
	 *  do not serve whatever appears next under numbers that no longer mean the same thing. */
	it("reports stale when the stream is gone from under a cursor", async () => {
		const redis = fakeRedis();
		const stream = redisStream({ send: redis.send });
		await stream.append("thread:t1", text("r1", "one"));
		const page = await stream.read("thread:t1");

		redis.streams.delete("thread:t1");

		const resumed = await stream.read("thread:t1", page.cursor);
		expect(resumed.stale).toBe(true);
		expect(resumed.chunks).toEqual([]);
	});

	/** …but an EMPTY read on a live stream is just "caught up", not stale. Conflating the two would
	 *  end every idle watcher. */
	it("does not call a caught-up reader stale", async () => {
		const redis = fakeRedis();
		const stream = redisStream({ send: redis.send });
		await stream.append("thread:t1", text("r1", "one"));
		const page = await stream.read("thread:t1");
		const idle = await stream.read("thread:t1", page.cursor);
		expect(idle.stale).toBe(false);
	});

	it("pages a long answer rather than returning all of it at once", async () => {
		const redis = fakeRedis();
		const stream = redisStream({ send: redis.send, maxChunksPerRead: 4 });
		for (let i = 0; i < 10; i++) {
			await stream.append("thread:t1", text("r1", `d${i}`));
		}
		const first = await stream.read("thread:t1");
		expect(first.chunks).toHaveLength(4);
		const second = await stream.read("thread:t1", first.cursor);
		expect(second.chunks).toHaveLength(4);
		const third = await stream.read("thread:t1", second.cursor);
		expect(third.chunks).toHaveLength(2);
	});

	/**
	 * NO `watch` WITHOUT A SECOND CONNECTION. `XREAD BLOCK` holds the connection until something
	 * arrives, so issuing it on the one the rest of the app shares stalls every other command behind
	 * it — a stall that looks like the database being slow and is not. Absent is the safe answer;
	 * `watchThread` then polls, which is a documented degradation rather than an incident.
	 */
	it("offers push only when given a connection that may block", async () => {
		const redis = fakeRedis();
		expect(redisStream({ send: redis.send }).watch).toBeUndefined();
		expect(
			redisStream({ send: redis.send, blockingSend: redis.send }).watch,
		).toBeTypeOf("function");
	});

	it("pushes new chunks over watch, and skips empty block timeouts", async () => {
		const redis = fakeRedis();
		const stream = redisStream({
			send: redis.send,
			blockingSend: redis.send,
			blockMs: 1,
		});
		await stream.append("thread:t1", text("r1", "one"));
		await stream.append("thread:t1", text("r1", "two"));

		const seen: RunStreamChunk[] = [];
		const watch = stream.watch;
		if (!watch) throw new Error("expected a watch member");
		for await (const page of watch("thread:t1")) {
			seen.push(...page.chunks);
			// The fake never blocks, so a timed-out read returns immediately and must NOT be yielded
			// as an empty page — a consumer counting pages should be counting deltas.
			expect(page.chunks.length).toBeGreaterThan(0);
			if (seen.length >= 2) break;
		}
		expect(seen.map((c) => (c.kind === "text" ? c.text : ""))).toEqual([
			"one",
			"two",
		]);
	});

	it("drops an entry it cannot read instead of ending the stream", async () => {
		const redis = fakeRedis();
		const stream = redisStream({ send: redis.send });
		await stream.append("thread:t1", text("r1", "one"));
		const entries = redis.streams.get("thread:t1");
		entries?.push({ id: "999-0", json: "{not json" });
		await stream.append("thread:t1", text("r1", "three"));

		const page = await stream.read("thread:t1");
		expect(page.chunks.map((c) => (c.kind === "text" ? c.text : ""))).toEqual([
			"one",
			"three",
		]);
	});
});
