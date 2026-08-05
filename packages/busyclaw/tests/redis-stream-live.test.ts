/// <reference types="node" />
// LIVE Redis. The fake in `run-stream-redis.test.ts` proves the port's LOGIC against Redis's
// documented semantics; this proves the half a fake structurally cannot — that a real server's
// replies parse. Nested arrays, RESP framing, whether ids and fields arrive as the shapes
// `parseXRead` expects: all of that is invented by the fake and merely believed until this runs.
//
// SPEAKS RESP OVER A SOCKET rather than importing a client, for the same reason `redisStream` takes
// one instead of depending on one — adding ioredis here to test a module whose whole point is not
// needing it would be testing something else. It also means this exercises the exact `client`
// function seam a host supplies.
//
// LIVES HERE rather than beside redisStream because @busyclaw/storage-core compiles with no Node lib
// at all — deliberately, so it stays importable from a browser or a worker — and a socket needs one.
// Same arrangement as azure-live.test.ts, the repo's existing home for tests that talk to a real
// service.
//
// SKIPPED unless a Redis is reachable, so a laptop or CI without one stays green. Point it somewhere
// else with REDIS_URL; the default matches a plain `docker run -p 6379:6379 redis`.

import { connect, type Socket } from "node:net";
import { type RedisCommand, redisStream } from "@busyclaw/storage-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = new URL(process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379");
const HOST = url.hostname;
const PORT = Number(url.port || 6379);

/** Encode one command as a RESP array of bulk strings — what every Redis client puts on the wire. */
function encode(args: readonly string[]): string {
	return args.reduce(
		(out, arg) => `${out}$${Buffer.byteLength(arg)}\r\n${arg}\r\n`,
		`*${args.length}\r\n`,
	);
}

/**
 * Parse one RESP reply from `buffer` at `at`, or `null` when more bytes are needed.
 *
 * Covers the five RESP2 types Redis answers these commands with. Deliberately small: a general
 * client is not the subject, one that can read XADD/XREAD/EXISTS/EXPIRE replies is.
 */
function decode(
	buffer: string,
	at: number,
): { value: unknown; next: number } | null {
	const end = buffer.indexOf("\r\n", at);
	if (end === -1) return null;
	const kind = buffer[at];
	const head = buffer.slice(at + 1, end);
	const after = end + 2;
	if (kind === "+") return { value: head, next: after };
	if (kind === "-") return { value: new Error(head), next: after };
	if (kind === ":") return { value: Number(head), next: after };
	if (kind === "$") {
		const length = Number(head);
		if (length === -1) return { value: null, next: after };
		if (buffer.length < after + length + 2) return null;
		return {
			value: buffer.slice(after, after + length),
			next: after + length + 2,
		};
	}
	if (kind === "*") {
		const count = Number(head);
		if (count === -1) return { value: null, next: after };
		const items: unknown[] = [];
		let cursor = after;
		for (let i = 0; i < count; i++) {
			const item = decode(buffer, cursor);
			if (item === null) return null;
			items.push(item.value);
			cursor = item.next;
		}
		return { value: items, next: cursor };
	}
	throw new Error(`unsupported RESP type: ${String(kind)}`);
}

/** One connection, commands issued strictly in order — which is exactly how a real client behaves,
 *  and the reason a blocking read needs a second one. */
function createConnection(): {
	send: RedisCommand;
	close: () => void;
	ready: Promise<void>;
} {
	let buffer = "";
	const waiting: Array<(value: unknown) => void> = [];
	const failures: Array<(error: Error) => void> = [];
	const socket: Socket = connect({ host: HOST, port: PORT });
	socket.setNoDelay(true);
	const ready = new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	socket.on("data", (data: Buffer) => {
		buffer += data.toString("binary");
		while (waiting.length > 0) {
			const parsed = decode(buffer, 0);
			if (parsed === null) break;
			buffer = buffer.slice(parsed.next);
			const settle = waiting.shift();
			failures.shift();
			settle?.(parsed.value);
		}
	});
	socket.on("error", (error: Error) => {
		while (failures.length > 0) failures.shift()?.(error);
		waiting.length = 0;
	});
	return {
		ready,
		close: () => socket.destroy(),
		send: (args) =>
			new Promise((resolve, reject) => {
				waiting.push(resolve);
				failures.push(reject);
				socket.write(encode(args.map(String)), "binary");
			}),
	};
}

async function reachable(): Promise<boolean> {
	try {
		const probe = createConnection();
		await probe.ready;
		const pong = await probe.send(["PING"]);
		probe.close();
		return pong === "PONG";
	} catch {
		return false;
	}
}

const live = await reachable();

describe.skipIf(!live)(
	`redisStream against a live Redis at ${HOST}:${PORT}`,
	() => {
		let main: ReturnType<typeof createConnection>;
		let blocking: ReturnType<typeof createConnection>;
		// Namespaced per run so a re-run never reads the previous one's entries.
		const keyBase = `busyclaw-test:run-stream:${Date.now()}`;
		const key = keyBase;

		beforeAll(async () => {
			main = createConnection();
			blocking = createConnection();
			await Promise.all([main.ready, blocking.ready]);
		});
		afterAll(async () => {
			await main.send(["DEL", key]).catch(() => undefined);
			main.close();
			blocking.close();
		});

		const text = (runId: string, body: string) =>
			({ kind: "text", runId, attempt: 1, text: body }) as const;

		/**
		 * THE ONE A FAKE CANNOT PROVE: a real XREAD reply, parsed. Nested arrays, bulk strings, the
		 * `<ms>-<seq>` id format — every assumption `parseXRead` makes is checked here for the first
		 * time against a server that did not learn its shape from this repo.
		 */
		it("round-trips chunks through a real server", async () => {
			const stream = redisStream({ client: main.send });
			await stream.append(key, text("r1", "one "));
			await stream.append(key, text("r1", "two"));

			const page = await stream.read(key);
			expect(page.stale).toBe(false);
			expect(page.chunks.map((c) => (c.kind === "text" ? c.text : ""))).toEqual(
				["one ", "two"],
			);
			// Redis's own entry id, which is what `Last-Event-ID` carries.
			expect(page.cursor).toMatch(/^\d+-\d+$/);

			// And the cursor resumes rather than replays — XREAD's exclusivity, from the real thing.
			const idle = await stream.read(key, page.cursor);
			expect(idle.chunks).toEqual([]);
			expect(idle.stale).toBe(false);
		});

		/** A key that never existed, read from a non-zero cursor, is the stale case — and `EXISTS` is
		 *  what tells it apart from "caught up", against a real server's integer reply. */
		it("reports stale for a stream that is not there", async () => {
			const stream = redisStream({ client: main.send });
			const page = await stream.read(`${key}:missing`, "999999-0");
			expect(page.stale).toBe(true);
		});

		/**
		 * PUSH, on the real thing: `XREAD BLOCK` returns the moment an entry lands rather than after the
		 * block window. Written from the MAIN connection while the blocking one waits, which is also the
		 * arrangement `blocking` exists to require.
		 */
		it("delivers over XREAD BLOCK as soon as a chunk is written", async () => {
			const pushKey = `${key}:push`;
			const stream = redisStream({
				client: main.send,
				blocking: blocking.send,
				blockMs: 5_000,
			});
			const watch = stream.watch;
			if (!watch)
				throw new Error("expected a watch member with a blocking client");

			const started = Date.now();
			const iterator = watch(pushKey)[Symbol.asyncIterator]();
			const first = iterator.next();
			// Written AFTER the blocking read is already parked, so arrival is push and not a poll.
			await new Promise((resolve) => setTimeout(resolve, 50));
			await stream.append(pushKey, text("r1", "pushed"));

			const page = await first;
			expect(page.done).toBe(false);
			expect(page.value?.chunks).toMatchObject([{ text: "pushed" }]);
			// Well inside the 5s block window — it returned on the write, not on the timeout.
			expect(Date.now() - started).toBeLessThan(4_000);
			await iterator.return?.(undefined);
			await main.send(["DEL", pushKey]);
		});

		/**
		 * TWO WATCHERS ON ONE STREAM — the multiplayer premise, against a real server.
		 *
		 * `XREAD BLOCK` occupies its connection until it returns, so two subscribers sharing one
		 * blocking client would SERIALISE: the second's read cannot even be issued until the first's
		 * has come back. Nothing in the polling backings can show this, because nothing there holds a
		 * connection.
		 */
		it("delivers to two concurrent watchers without one waiting on the other", async () => {
			const key = `${keyBase}:multi`;
			const stream = redisStream({
				client: main.send,
				blocking: blocking.send,
				blockMs: 4_000,
			});
			const watch = stream.watch;
			if (!watch) throw new Error("expected a watch member");

			const first = watch(key)[Symbol.asyncIterator]();
			const second = watch(key)[Symbol.asyncIterator]();
			const both = Promise.all([first.next(), second.next()]);

			// Written once, after both blocking reads are parked. Both must see it.
			await new Promise((resolve) => setTimeout(resolve, 100));
			const started = Date.now();
			await stream.append(key, text("r1", "for both"));

			const [a, b] = await both;
			expect(a.value?.chunks).toMatchObject([{ text: "for both" }]);
			expect(b.value?.chunks).toMatchObject([{ text: "for both" }]);
			// Neither waited out a block window, which is what serialising on one connection costs.
			expect(Date.now() - started).toBeLessThan(3_000);

			await first.return?.(undefined);
			await second.return?.(undefined);
			await main.send(["DEL", key]);
		});

		/**
		 * A NEW SUBSCRIBER WAITS BEHIND AN IN-FLIGHT BLOCK — the cost the previous test masks.
		 *
		 * A queued `XREAD` from an older cursor returns as soon as it is processed, so a second
		 * watcher usually looks instant. It is not: its FIRST read cannot even be issued while
		 * another watcher's block occupies the connection. So somebody joining a quiet conversation
		 * waits out that block before seeing text that is already there.
		 */
		it("makes a joining watcher wait out another's block, on one shared connection", async () => {
			const key = `${keyBase}:join`;
			const blockMs = 1_500;
			const stream = redisStream({
				client: main.send,
				blocking: blocking.send,
				blockMs,
			});
			const watch = stream.watch;
			if (!watch) throw new Error("expected a watch member");

			// One chunk exists, and the first watcher is caught up and now blocking for the next.
			await stream.append(key, text("r1", "already here"));
			const settled = watch(key)[Symbol.asyncIterator]();
			expect((await settled.next()).value?.chunks).toHaveLength(1);
			const parked = settled.next();
			await new Promise((resolve) => setTimeout(resolve, 100));

			// A second watcher attaches from the start. What it wants is already in the stream.
			const started = Date.now();
			const joining = watch(key)[Symbol.asyncIterator]();
			const first = await joining.next();
			const waited = Date.now() - started;

			// WHAT IS ASSERTED is that the joiner is served at all, and within a bound that holds
			// whether or not the sharing below ever gets built. Measured at the time of writing: it
			// waits out most of the block window, because its first read cannot be issued while
			// another watcher occupies the connection.
			//
			// NOT asserted as a floor, deliberately. Pinning "this is slow" would make the fix D17
			// calls for — one shared reader per process per key, fanned out in memory — break this
			// test, and a test that has to be deleted to improve the system is a test that was
			// measuring the wrong thing.
			expect(first.value?.chunks).toMatchObject([{ text: "already here" }]);
			expect(waited).toBeLessThan(blockMs * 2);

			await joining.return?.(undefined);
			await stream.append(key, text("r1", "release"));
			await parked;
			await settled.return?.(undefined);
			await main.send(["DEL", key]);
		});

		/** The TTL is real: a key written with a one-second window is gone a moment later, which is what
		 *  bounds how long best-effort-redacted text exists at all (D17). */
		it("expires a stream, which is the cleanup the design depends on", async () => {
			const ttlKey = `${key}:ttl`;
			const stream = redisStream({ client: main.send, ttlSeconds: 1 });
			await stream.append(ttlKey, text("r1", "briefly"));
			expect(await main.send(["EXISTS", ttlKey])).toBe(1);

			await new Promise((resolve) => setTimeout(resolve, 1_500));
			expect(await main.send(["EXISTS", ttlKey])).toBe(0);
		});
	},
);
