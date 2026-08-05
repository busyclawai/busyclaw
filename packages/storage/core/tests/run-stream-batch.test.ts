import type { RunStreamChunk, RunStreamPort } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { batchedStream } from "../src/index";

// DECLARED, like src does: this package compiles with no DOM or Node lib. See src/run-stream/polling.ts.
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** A port that records exactly what reached the backend — which is the whole subject here. */
function recordingPort() {
	const written: Array<{ key: string; chunk: RunStreamChunk }> = [];
	const port: RunStreamPort = {
		append: async (key, chunk) => {
			written.push({ key, chunk });
		},
		read: async () => ({ chunks: [], cursor: "0", stale: false }),
	};
	return { port, written };
}

const text = (runId: string, body: string, attempt = 1) =>
	({ kind: "text", runId, attempt, text: body }) as const;

const settle = () =>
	new Promise<void>((resolve) => {
		setTimeout(() => resolve(), 40);
	});

describe("batchedStream", () => {
	/**
	 * THE POINT. A model emits 200–500 deltas a turn; one write each is ten times what the design
	 * budgets. Coalescing is CONCATENATION, so a reader sees exactly the characters produced, in
	 * order, just in fewer pieces — which is why this is safe to apply by default.
	 */
	it("writes many deltas as one chunk, losing nothing", async () => {
		const { port, written } = recordingPort();
		const stream = batchedStream(port, { windowMs: 10_000 });

		for (const word of ["one ", "two ", "three"]) {
			await stream.append("thread:t1", text("r1", word));
		}
		// Nothing yet — the window has not closed and nothing forced it.
		expect(written).toHaveLength(0);

		await stream.append("thread:t1", {
			kind: "lifecycle",
			runId: "r1",
			attempt: 1,
			event: "completed",
		});

		expect(written).toHaveLength(2);
		expect(written[0]?.chunk).toMatchObject({
			kind: "text",
			text: "one two three",
		});
		expect(written[1]?.chunk).toMatchObject({ kind: "lifecycle" });
	});

	/**
	 * ORDER IS THE SAFETY PROPERTY. Flushing before a non-text chunk is what keeps a `completed` from
	 * overtaking the words it completes — a watcher would otherwise see the turn end and then receive
	 * its last sentence. It is also what makes an explicit flush unnecessary: every slice ends with a
	 * lifecycle chunk, so the buffer cannot outlive the work that filled it.
	 */
	it("never lets a lifecycle chunk overtake the text before it", async () => {
		const { port, written } = recordingPort();
		const stream = batchedStream(port, { windowMs: 10_000 });

		await stream.append("thread:t1", text("r1", "the answer"));
		await stream.append("thread:t1", {
			kind: "lifecycle",
			runId: "r1",
			attempt: 1,
			event: "parked",
			reason: "approval",
		});

		expect(written.map((w) => w.chunk.kind)).toEqual(["text", "lifecycle"]);
	});

	it("flushes on its own timer when nothing else forces it", async () => {
		const { port, written } = recordingPort();
		const stream = batchedStream(port, { windowMs: 5 });

		await stream.append("thread:t1", text("r1", "mid-answer"));
		expect(written).toHaveLength(0);

		await settle();
		expect(written).toHaveLength(1);
		expect(written[0]?.chunk).toMatchObject({ text: "mid-answer" });
	});

	/**
	 * TWO RUNS IN ONE THREAD must not be concatenated into each other. Multiplayer writes one key
	 * from two drivers, so a buffer that ignored `runId` would splice one person's answer into
	 * another's — the exact failure the per-chunk tag exists to prevent, reintroduced at the writer.
	 */
	it("does not concatenate across runs sharing a key", async () => {
		const { port, written } = recordingPort();
		const stream = batchedStream(port, { windowMs: 10_000 });

		await stream.append("thread:t1", text("alice", "hello "));
		await stream.append("thread:t1", text("bob", "goodbye"));

		// Alice's buffer was flushed when Bob's text arrived, rather than absorbing it.
		expect(written).toHaveLength(1);
		expect(written[0]?.chunk).toMatchObject({
			runId: "alice",
			text: "hello ",
		});
	});

	/** A SUPERSEDING ATTEMPT is the same hazard one level down: the same run, a different generation,
	 *  and concatenating them would build a sentence from two answers. */
	it("does not concatenate across attempts of one run", async () => {
		const { port, written } = recordingPort();
		const stream = batchedStream(port, { windowMs: 10_000 });

		await stream.append("thread:t1", text("r1", "first try", 1));
		await stream.append("thread:t1", text("r1", "second try", 2));

		expect(written).toHaveLength(1);
		expect(written[0]?.chunk).toMatchObject({ attempt: 1, text: "first try" });
	});

	/** Separate conversations keep separate buffers — one process drives many. */
	it("buffers each stream key independently", async () => {
		const { port, written } = recordingPort();
		const stream = batchedStream(port, { windowMs: 10_000 });

		await stream.append("thread:a", text("r1", "aaa"));
		await stream.append("thread:b", text("r2", "bbb"));
		await stream.append("thread:a", text("r1", "AAA"));

		await stream.append("thread:a", {
			kind: "lifecycle",
			runId: "r1",
			attempt: 1,
			event: "completed",
		});

		const textWrites = written.filter((w) => w.chunk.kind === "text");
		expect(textWrites).toHaveLength(1);
		expect(textWrites[0]).toMatchObject({
			key: "thread:a",
			chunk: { text: "aaaAAA" },
		});
	});

	/** A very fast answer must not hold a large string for the whole window. */
	it("flushes early once the buffer is large", async () => {
		const { port, written } = recordingPort();
		const stream = batchedStream(port, { windowMs: 10_000, maxChars: 10 });

		await stream.append("thread:t1", text("r1", "12345"));
		expect(written).toHaveLength(0);
		await stream.append("thread:t1", text("r1", "67890"));
		expect(written).toHaveLength(1);
		expect(written[0]?.chunk).toMatchObject({ text: "1234567890" });
	});

	/** `read` and `watch` pass through untouched — this wraps writing only. */
	it("leaves the reading half alone", async () => {
		const { port } = recordingPort();
		const stream = batchedStream(port);
		await expect(stream.read("thread:t1")).resolves.toMatchObject({
			cursor: "0",
			stale: false,
		});
	});
});
