import type { SecondaryStorage } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { memorySecondaryStorage, secondaryStorageStream } from "../src/index";

const text = (runId: string, attempt: number, body: string) =>
	({ kind: "text", runId, attempt, text: body }) as const;

describe("secondaryStorageStream", () => {
	it("reads back what was appended, in order, and resumes from a cursor", async () => {
		const stream = secondaryStorageStream(memorySecondaryStorage());
		await stream.append("thread:t1", text("r1", 1, "one "));
		await stream.append("thread:t1", text("r1", 1, "two "));
		await stream.append("thread:t1", text("r1", 1, "three"));

		const first = await stream.read("thread:t1");
		expect(first.chunks).toHaveLength(3);
		expect(first.stale).toBe(false);

		// Resuming from the returned cursor yields nothing new — the property `Last-Event-ID` rides on.
		const second = await stream.read("thread:t1", first.cursor);
		expect(second.chunks).toEqual([]);
		expect(second.cursor).toBe(first.cursor);

		await stream.append("thread:t1", text("r1", 1, "!"));
		const third = await stream.read("thread:t1", first.cursor);
		expect(third.chunks).toMatchObject([{ text: "!" }]);
	});

	/**
	 * TWO RUNS IN ONE THREAD is the normal multiplayer case, and it is why `increment` is required:
	 * both drivers append concurrently to one log. A get-then-set counter drops chunks here.
	 */
	it("interleaves concurrent runs without losing a chunk, and tags each with its run", async () => {
		const stream = secondaryStorageStream(memorySecondaryStorage());
		await Promise.all([
			...Array.from({ length: 20 }, (_, i) =>
				stream.append("thread:t1", text("alice-run", 1, `a${i}`)),
			),
			...Array.from({ length: 20 }, (_, i) =>
				stream.append("thread:t1", text("bob-run", 1, `b${i}`)),
			),
		]);

		const page = await stream.read("thread:t1");
		expect(page.chunks).toHaveLength(40);
		// The client demultiplexes on runId — both turns arrive whole.
		const byRun = (id: string) =>
			page.chunks.filter((c) => c.runId === id).length;
		expect(byRun("alice-run")).toBe(20);
		expect(byRun("bob-run")).toBe(20);
	});

	/**
	 * A substrate without `increment` is REFUSED, not degraded. The port marks the member optional; a
	 * consumer that needs it must say what it cannot do without it rather than race quietly.
	 */
	it("refuses a secondaryStorage that cannot allocate offsets atomically", () => {
		const noIncrement: SecondaryStorage = {
			get: async () => null,
			set: async () => undefined,
			delete: async () => undefined,
		};
		expect(() => secondaryStorageStream(noIncrement)).toThrow(/no `increment`/);
	});

	/**
	 * THE STALE RULE. A thread's log is sparse and long-lived while its entries expire, so a client
	 * away longer than the ttl returns with a cursor above a counter that has since reset. Replaying
	 * whatever now sits at those offsets would show them another conversation's text.
	 */
	it("reports stale rather than replaying unrelated chunks at matching offsets", async () => {
		let clock = 0;
		const kv = memorySecondaryStorage({ now: () => clock });
		const stream = secondaryStorageStream(kv, { ttlSeconds: 10 });
		await stream.append("thread:t1", text("r1", 1, "before"));
		const page = await stream.read("thread:t1");
		expect(page.cursor).toBe("1");

		// The window passes; counter and chunk both expire. A new turn starts numbering at 1 again.
		clock += 11_000;
		await stream.append("thread:t1", text("r2", 1, "after"));

		const resumed = await stream.read("thread:t1", "5");
		expect(resumed.stale).toBe(true);
		expect(resumed.chunks).toEqual([]);
	});

	/**
	 * A HOLE — an offset allocated whose chunk never landed, because the writer died between
	 * `increment` and `set`. Skipping is what keeps the reader moving; treating it as the end would
	 * strand them below a `max` that never comes back down, on a cursor that can never advance.
	 */
	it("steps over a missing chunk instead of stopping at it forever", async () => {
		const kv = memorySecondaryStorage();
		const stream = secondaryStorageStream(kv);
		await stream.append("thread:t1", text("r1", 1, "one"));
		await stream.append("thread:t1", text("r1", 1, "two"));
		await stream.append("thread:t1", text("r1", 1, "three"));
		await kv.delete("thread:t1:2");

		const page = await stream.read("thread:t1");
		expect(page.chunks.map((c) => (c.kind === "text" ? c.text : ""))).toEqual([
			"one",
			"three",
		]);
		// And the cursor advanced past the hole, so the next read does not retry it.
		expect(page.cursor).toBe("3");
	});

	it("pages a long answer rather than issuing one read per chunk up front", async () => {
		const stream = secondaryStorageStream(memorySecondaryStorage(), {
			maxChunksPerRead: 10,
		});
		for (let i = 0; i < 25; i++) {
			await stream.append("thread:t1", text("r1", 1, `d${i}`));
		}

		const first = await stream.read("thread:t1");
		expect(first.chunks).toHaveLength(10);
		expect(first.stale).toBe(false);
		const second = await stream.read("thread:t1", first.cursor);
		expect(second.chunks).toHaveLength(10);
		const third = await stream.read("thread:t1", second.cursor);
		expect(third.chunks).toHaveLength(5);
	});

	/** A buffer is not a record: one unreadable entry must not take down the live view. */
	it("drops an unparseable entry and keeps serving the rest", async () => {
		const kv = memorySecondaryStorage();
		const stream = secondaryStorageStream(kv);
		await stream.append("thread:t1", text("r1", 1, "one"));
		await stream.append("thread:t1", text("r1", 1, "two"));
		await kv.set("thread:t1:1", "{not json");

		const page = await stream.read("thread:t1");
		expect(page.chunks).toMatchObject([{ text: "two" }]);
	});
});
