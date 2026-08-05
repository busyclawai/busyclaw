import type { RunStreamPage, RunStreamPort } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	memorySecondaryStorage,
	secondaryStorageStream,
	sharedStream,
} from "../src/index";

declare const setTimeout: (callback: () => void, ms: number) => unknown;
const settle = () =>
	new Promise<void>((resolve) => {
		setTimeout(() => resolve(), 5);
	});

/**
 * A port that counts how many watchers reached the BACKING — which is the whole subject: sharing is
 * invisible from the outside except in this number.
 */
function countingPort() {
	const watchers: Array<{ key: string; cursor: string | undefined }> = [];
	const feeds: Array<(page: RunStreamPage) => void> = [];
	const closers: Array<() => void> = [];
	const port: RunStreamPort = {
		append: async () => undefined,
		read: async () => ({ chunks: [], cursor: "0", stale: false }),
		watch: (key, cursor) => {
			watchers.push({ key, cursor });
			const queue: RunStreamPage[] = [];
			let wake: (() => void) | undefined;
			let ended = false;
			feeds.push((page) => {
				queue.push(page);
				wake?.();
				wake = undefined;
			});
			closers.push(() => {
				ended = true;
				wake?.();
				wake = undefined;
			});
			return {
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
			};
		},
	};
	return {
		port,
		watchers,
		/** Emit a page to every underlying watcher this port handed out. */
		emit: (page: RunStreamPage) => {
			for (const feed of feeds) feed(page);
		},
		close: () => {
			for (const closer of closers) closer();
		},
	};
}

const page = (cursor: string, text: string): RunStreamPage => ({
	chunks: [{ kind: "text", runId: "r1", attempt: 1, text }],
	cursor,
	stale: false,
});

/** Read `count` pages from an iterator, so a test can hold several subscribers at once. */
async function take(
	iterator: AsyncIterator<RunStreamPage>,
	count: number,
): Promise<RunStreamPage[]> {
	const out: RunStreamPage[] = [];
	for (let i = 0; i < count; i++) {
		const next = await iterator.next();
		if (next.done) break;
		out.push(next.value);
	}
	return out;
}

describe("sharedStream", () => {
	/**
	 * THE POINT. Several people opening one conversation is the case this exists for, and they all
	 * arrive the same way — with no cursor — so `undefined === undefined` is the join point and one
	 * reader serves the room.
	 */
	it("opens ONE underlying watcher for three subscribers on one key", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		const a = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		const b = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		const c = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!a || !b || !c) throw new Error("expected watch");
		await settle();

		expect(backing.watchers).toHaveLength(1);

		backing.emit(page("1", "hello"));
		const seen = await Promise.all([take(a, 1), take(b, 1), take(c, 1)]);
		for (const pages of seen) {
			expect(pages).toMatchObject([{ cursor: "1" }]);
		}
	});

	/** Separate conversations are separate loops — sharing is per KEY, not per process. */
	it("keeps one loop per key", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);
		stream.watch?.("thread:a")[Symbol.asyncIterator]().next();
		stream.watch?.("thread:b")[Symbol.asyncIterator]().next();
		await settle();
		expect(backing.watchers.map((w) => w.key).sort()).toEqual([
			"thread:a",
			"thread:b",
		]);
	});

	/**
	 * A JOINER IS CAUGHT UP FROM MEMORY, never from the backing. This is the latency the whole file
	 * exists to remove: on Redis, a second watcher's first read would otherwise queue behind another
	 * watcher's in-flight `XREAD BLOCK` and wait out the block window for text already in the stream.
	 */
	it("serves a late subscriber the pages it missed without touching the backing", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		const first = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!first) throw new Error("expected watch");
		await settle();
		backing.emit(page("1", "one "));
		backing.emit(page("2", "two"));
		await take(first, 2);

		// Arrives the same way the first did — no cursor — so it shares, and gets the history.
		const late = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!late) throw new Error("expected watch");
		const caught = await take(late, 2);

		expect(caught.map((p) => p.cursor)).toEqual(["1", "2"]);
		// Still ONE reader on the backing: the joiner never asked it for anything.
		expect(backing.watchers).toHaveLength(1);
	});

	/**
	 * A CURSOR THE LOOP HAS NOT STOOD AT gets its own reader. Cursors are opaque — a numeric offset
	 * here, a `<ms>-<seq>` there — so this can only test equality, and guessing about ordering is
	 * how a subscriber would silently miss chunks. Falling back is exactly today's behaviour.
	 */
	it("gives a subscriber at an unknown position its own reader", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		stream.watch?.("thread:t1")[Symbol.asyncIterator]().next();
		await settle();
		stream
			.watch?.("thread:t1", "some-cursor-nobody-emitted")
			[Symbol.asyncIterator]()
			.next();
		await settle();

		expect(backing.watchers).toHaveLength(2);
		expect(backing.watchers[1]?.cursor).toBe("some-cursor-nobody-emitted");
	});

	/** …and a subscriber resuming from a page the loop DID emit rejoins it rather than forking. */
	it("rejoins a subscriber whose cursor is one the loop already emitted", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		const first = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!first) throw new Error("expected watch");
		await settle();
		backing.emit(page("1", "one "));
		backing.emit(page("2", "two"));
		await take(first, 2);

		const resumed = stream.watch?.("thread:t1", "1")[Symbol.asyncIterator]();
		if (!resumed) throw new Error("expected watch");
		const after = await take(resumed, 1);

		// Everything AFTER its cursor, nothing before it, and no second reader.
		expect(after.map((p) => p.cursor)).toEqual(["2"]);
		expect(backing.watchers).toHaveLength(1);
	});

	/**
	 * THE LOOP OUTLIVES ANY ONE SUBSCRIBER AND NO LONGER. A reader left running after the last
	 * watcher leaves is a connection held open — on Redis, a blocking one — for nobody.
	 */
	it("starts a fresh loop once every subscriber has gone", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		const only = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!only) throw new Error("expected watch");
		await settle();
		backing.emit(page("1", "one"));
		await take(only, 1);
		await only.return?.(undefined);
		await settle();

		stream.watch?.("thread:t1")[Symbol.asyncIterator]().next();
		await settle();
		// A second reader, because the first was retired rather than left running for nobody.
		expect(backing.watchers).toHaveLength(2);
	});

	/** One slow subscriber must not stall the shared read, or it stalls everyone else with it. */
	it("does not let an unread subscriber hold up the others", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		const reading = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		// Attached and never read from — the tab nobody is looking at.
		const idle = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!reading || !idle) throw new Error("expected watch");
		await settle();

		backing.emit(page("1", "one "));
		backing.emit(page("2", "two "));
		backing.emit(page("3", "three"));
		expect((await take(reading, 3)).map((p) => p.cursor)).toEqual([
			"1",
			"2",
			"3",
		]);
	});

	/** A stale page ends the log for everyone on that loop: their cursors all point past what the
	 *  backing still holds, so continuing to serve any of them would be a lie. */
	it("ends every subscriber when the log goes stale", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		const a = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		const b = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!a || !b) throw new Error("expected watch");
		await settle();

		backing.emit({ chunks: [], cursor: "9", stale: true });
		expect(await take(a, 5)).toMatchObject([{ stale: true }]);
		expect(await take(b, 5)).toMatchObject([{ stale: true }]);
	});

	/**
	 * AGAINST A REAL BACKING, because everything above runs on a fake whose semantics I wrote to
	 * match my own expectations. That is how the `memoryAdapter` uniques gap and the `decodeChunk`
	 * allowlist both hid — a double that agrees with the code proves the code agrees with itself.
	 *
	 * The KV backing has real cursors, real paging and a real `read`, and no `watch` at all — so this
	 * also exercises the path where the shared loop drives `pollingWatch` rather than a push.
	 */
	it("shares one loop over a real KV backing, and every subscriber gets the whole log", async () => {
		const backing = secondaryStorageStream(memorySecondaryStorage());
		const stream = sharedStream(backing);
		const chunk = (text: string) =>
			({ kind: "text", runId: "r1", attempt: 1, text }) as const;

		const a = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		const b = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!a || !b) throw new Error("expected watch");

		await backing.append("thread:t1", chunk("one "));
		await backing.append("thread:t1", chunk("two"));

		const textOf = (pages: RunStreamPage[]) =>
			pages
				.flatMap((p) => p.chunks)
				.map((c) => (c.kind === "text" ? c.text : ""))
				.join("");

		// Both see everything, whatever page boundaries the poller happened to produce.
		const seenA: RunStreamPage[] = [];
		while (textOf(seenA) !== "one two") seenA.push(...(await take(a, 1)));
		const seenB: RunStreamPage[] = [];
		while (textOf(seenB) !== "one two") seenB.push(...(await take(b, 1)));

		expect(textOf(seenA)).toBe("one two");
		expect(textOf(seenB)).toBe("one two");
		await a.return?.(undefined);
		await b.return?.(undefined);
	});

	/**
	 * A LIVE PAGE ARRIVING WHILE A JOINER IS BEING SET UP must not overtake its replay.
	 *
	 * Safe today only because the tail snapshot, the subscriber's registration and the replay push
	 * all happen in ONE synchronous block — no await for the loop to interleave into. That is
	 * load-bearing and invisible, so it is asserted rather than trusted: a refactor that awaits
	 * anything between them reorders a watcher's text.
	 */
	it("replays before live pages, with no gap for the loop to cut in", async () => {
		const backing = countingPort();
		const stream = sharedStream(backing.port);

		const first = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!first) throw new Error("expected watch");
		await settle();
		backing.emit(page("1", "one "));
		backing.emit(page("2", "two "));
		await take(first, 2);

		// Joined and immediately fed a live page, with no await in between on this side either.
		const joiner = stream.watch?.("thread:t1")[Symbol.asyncIterator]();
		if (!joiner) throw new Error("expected watch");
		backing.emit(page("3", "three"));

		expect((await take(joiner, 3)).map((p) => p.cursor)).toEqual([
			"1",
			"2",
			"3",
		]);
	});
});
