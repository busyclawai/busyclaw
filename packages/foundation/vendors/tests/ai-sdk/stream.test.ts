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

/** Parse an AI SDK UI-message SSE body into its JSON chunks (skips the `[DONE]` sentinel). */
function parseSse(body: string): Array<Record<string, unknown>> {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.filter((payload) => payload !== "" && payload !== "[DONE]")
		.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe("toTextStreamResponse", () => {
	it("concatenates deltas as a text/plain body", async () => {
		const response = toTextStreamResponse(fakeStream(["he", "llo"]));
		expect(await response.text()).toBe("hello");
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
