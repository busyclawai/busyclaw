import { describe, expect, it } from "vitest";
import {
	type TextDeltaStream,
	toTextStreamResponse,
	toUIMessageStreamResponse,
} from "../../src/ai-sdk/index";

/** A `TextDeltaStream` from a fixed list of deltas, with a `result` we can gate manually. */
function fakeStream(
	deltas: readonly string[],
	result?: Promise<unknown>,
): TextDeltaStream {
	return {
		result,
		textStream: (async function* () {
			for (const delta of deltas) yield delta;
		})(),
	};
}

/** Let pending timers and microtasks run — the producer parks on a real timer between deltas. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i += 1)
		await new Promise((resolve) => setTimeout(resolve, 1));
}

/** Parse an AI SDK UI-message SSE body into its JSON chunks (skips the `[DONE]` sentinel). */
function parseSse(body: string): Array<Record<string, unknown>> {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.filter((payload) => payload !== "" && payload !== "[DONE]")
		.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

/**
 * A stream that never ends, reporting how many deltas it produced and whether it was ever told to
 * stop. `cleanedUp` is the load-bearing one: a suspended generator and a CANCELLED one look
 * identical from the outside, and only the second runs the producer's `finally` — which is where
 * the runtime learns to abort the run.
 */
function endlessStream(): TextDeltaStream & {
	produced: () => number;
	cleanedUp: () => boolean;
} {
	let produced = 0;
	let cleanedUp = false;
	return {
		produced: () => produced,
		cleanedUp: () => cleanedUp,
		result: new Promise<never>(() => {}),
		textStream: (async function* () {
			try {
				while (true) {
					produced += 1;
					yield `${produced} `;
					// A real timer, not a bare microtask. Without one an uncancelled producer spins
					// tightly enough to starve vitest's own timeout, so a broken bridge wedges the
					// run instead of failing an assertion — which is a much worse thing to inherit.
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			} finally {
				cleanedUp = true;
			}
		})(),
	};
}

describe("toTextStreamResponse", () => {
	it("concatenates deltas as a text/plain body", async () => {
		const response = toTextStreamResponse(fakeStream(["he", "llo"]));
		expect(await response.text()).toBe("hello");
	});

	it("tells the producer when the client hangs up", async () => {
		// The bridge is where a cancelled HTTP response becomes a signal the run can act on. Merely
		// stopping to pull is not that signal: it leaves the producer suspended mid-yield, forever
		// believing it has a reader. Returning the iterator is what runs its cleanup — and in the
		// runtime that cleanup is what aborts the run.
		const stream = endlessStream();
		const body = toTextStreamResponse(stream).body;
		if (!body) throw new Error("no body");

		const reader = body.getReader();
		await reader.read();
		await reader.cancel();

		await settle();
		expect(stream.cleanedUp()).toBe(true);
	});

	it("asks for one delta at a time rather than draining the producer", async () => {
		// `pull`-driven, so the reader's pace is the producer's pace. A `start`-driven bridge runs
		// the whole generation into the stream's queue no matter how slowly it is read.
		const stream = endlessStream();
		const body = toTextStreamResponse(stream).body;
		if (!body) throw new Error("no body");

		const reader = body.getReader();
		await reader.read();
		await settle();

		expect(stream.produced()).toBeLessThan(10);
		await reader.cancel();
	});
});

describe("toUIMessageStreamResponse", () => {
	it("frames deltas as a UI-message stream useChat can consume", async () => {
		const response = toUIMessageStreamResponse(fakeStream(["he", "llo"]));
		const chunks = parseSse(await response.text());

		expect(chunks.map((c) => c.type)).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
			"finish",
		]);
		// The two deltas carry the reader-facing text under a single stable part id.
		const deltas = chunks.filter((c) => c.type === "text-delta");
		expect(deltas.map((c) => c.delta)).toEqual(["he", "llo"]);
		const ids = new Set(
			chunks.filter((c) => typeof c.id === "string").map((c) => c.id),
		);
		expect(ids.size).toBe(1);
	});

	it("tells the producer when the client hangs up", async () => {
		// This is the protocol `useChat` speaks by default, so a browser closing the tab is the
		// canonical cancellation — and it was the path that did NOT propagate one. The SDK runs its
		// `execute` callback to completion no matter what becomes of the response, which is why the
		// body is re-wrapped in a stream that has a cancel hook.
		const stream = endlessStream();
		const body = toUIMessageStreamResponse(stream).body;
		if (!body) throw new Error("no body");

		const reader = body.getReader();
		await reader.read();
		await reader.cancel();

		await settle();
		expect(stream.cleanedUp()).toBe(true);
	});
});

describe("result gating", () => {
	it("holds the response open until the producing run's result settles", async () => {
		let finishRun = (): void => {};
		const result = new Promise<void>((resolve) => {
			finishRun = resolve;
		});
		const response = toTextStreamResponse(fakeStream(["done"], result));

		let closed = false;
		const bodyPromise = response.text().then((text) => {
			closed = true;
			return text;
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closed).toBe(false); // deltas drained, but result is still pending

		finishRun();
		expect(await bodyPromise).toBe("done");
		expect(closed).toBe(true);
	});
});
