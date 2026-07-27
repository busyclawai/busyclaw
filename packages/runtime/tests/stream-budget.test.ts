// The stream channel's two budgets: how much it will hold, and how long it will produce.
//
// M-16. `runtime.stream` handed deltas to an unbounded array and iterated it. Both halves of that
// were a resource decision made by accident:
//
//   - A reader slower than the model — a browser on a bad link, a sink that writes to disk — is the
//     normal case, not the pathological one. Every delta the reader has not taken yet lived in an
//     array with no ceiling, so the gap between the two rates WAS the memory footprint.
//   - A reader that stops reading was invisible. The tab closes, the transport hangs up, the
//     consumer `break`s — and nothing downstream could tell.
//
// What a departure MEANS turns on where the answer goes, and both halves are pinned below. A
// recorded run detaches and finishes, because the transcript is what the reader comes back to; an
// ad-hoc run has nowhere to put its output, so with no reader it has nothing left to serve.
//
// All of it is tested against a model that only produces when it is READ, because a mock that
// enqueues its whole script up front measures nothing about backpressure.

import { describe, expect, it } from "vitest";
import { createRuntime, runtimeRunOptionsWithRecording } from "../src/index";

type V2Model = Parameters<typeof createRuntime>[0]["model"];

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/**
 * A model that streams `count` deltas one PULL at a time, and records how many it has been asked
 * for. `pulls` is the whole point: it measures how far ahead of the reader the pipeline runs.
 */
function pullModel(count: number): { model: V2Model; pulls: () => number } {
	let pulled = 0;
	const model = {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock-pull",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: "" }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage,
			warnings: [],
		}),
		doStream: async () => {
			let index = 0;
			return {
				stream: new ReadableStream({
					// `pull`, not `start`: the stream produces one part per request, so nothing is
					// generated until something downstream asks. That is what makes the count mean
					// "how far ahead did we run" rather than "how long is the script".
					pull(controller: ReadableStreamDefaultController) {
						pulled += 1;
						if (index === 0) {
							controller.enqueue({ type: "text-start", id: "0" });
							index += 1;
							return;
						}
						if (index <= count) {
							controller.enqueue({
								type: "text-delta",
								id: "0",
								delta: `${index} `,
							});
							index += 1;
							return;
						}
						controller.enqueue({ type: "text-end", id: "0" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage,
						});
						controller.close();
					},
				}),
				warnings: [],
			};
		},
	};
	return { model: model as unknown as V2Model, pulls: () => pulled };
}

const DELTAS = 20_000;

describe("runtime.stream — resource budget", () => {
	it("stops producing when the reader stops reading (backpressure)", async () => {
		const { model, pulls } = pullModel(DELTAS);
		const runtime = createRuntime({ model });

		const stream = runtime.stream("go");
		// Take exactly one delta, then let everything else that wants to run, run. An unbounded
		// buffer drains the entire model stream into memory here; a bounded one stalls the producer.
		const deltas = stream.textStream[Symbol.asyncIterator]();
		await deltas.next();
		for (let i = 0; i < 50; i += 1) await new Promise(setImmediate);

		// Measured: 530 with the bound (the channel's 512 plus the SDK pipeline's own small queues),
		// 20002 without it — the entire generation resident in an array nobody was draining. The
		// assertion is loose because the pipeline's buffering is not ours to pin, but the two numbers
		// are two orders of magnitude apart, so nothing subtle rides on where the line sits.
		expect(pulls()).toBeLessThan(DELTAS / 4);

		// And it is a stall, not a stop: reading again lets the producer go on.
		const before = pulls();
		for (let i = 0; i < 600; i += 1) await deltas.next();
		for (let i = 0; i < 50; i += 1) await new Promise(setImmediate);
		expect(pulls()).toBeGreaterThan(before);

		await deltas.return?.();
		await stream.result.catch(() => {});
	});

	it("aborts an AD-HOC run when the reader walks away", async () => {
		// Nothing is recording, so this run has no claw and no thread — nowhere to put what it
		// produces. With no reader either, every further token is spent on output that cannot be
		// read now or later.
		const { model, pulls } = pullModel(DELTAS);
		const runtime = createRuntime({ model });

		const stream = runtime.stream("go");
		let taken = 0;
		for await (const _delta of stream.textStream) {
			taken += 1;
			if (taken === 3) break; // the tab closes, the transport hangs up
		}

		await expect(stream.result).rejects.toThrow(/abort/i);

		const settled = pulls();
		for (let i = 0; i < 50; i += 1) await new Promise(setImmediate);
		expect(pulls()).toBe(settled);
	});

	it("lets a RECORDED run finish when the reader walks away, so the answer is there later", async () => {
		// The behaviour anyone who has closed a chat tab expects: come back and the answer is in the
		// thread. The transcript sink is writing to a claw, so finishing puts the answer exactly
		// where the reader will look for it — throwing that away to save the tail of one generation
		// would trade the entire point of the run for a few tokens already mostly spent.
		const { model } = pullModel(40);
		const recorded: string[] = [];
		const runtime = createRuntime({
			model,
			recording: {
				emit: async (event) => {
					recorded.push(event.type);
				},
			},
		});

		const stream = runtime.stream(
			"go",
			undefined,
			runtimeRunOptionsWithRecording(undefined, {
				clawId: "claw-1",
				threadId: "thread-1",
			}),
		);
		let taken = 0;
		for await (const _delta of stream.textStream) {
			taken += 1;
			if (taken === 3) break;
		}

		// Not rejected, not parked — finished.
		const result = await stream.result;
		expect(result.status).toBe("completed");
		expect(result.text.length).toBeGreaterThan(0);
		// And it reached the sink that persists it, which is what makes finishing worth anything.
		expect(recorded).toContain("run.completed");
	});

	it("a reader that stays to the end still gets the whole answer", async () => {
		// The regression guard on the ordinary path: bounding the buffer and adding a cancellation
		// hook must not cost a delta or stall a stream that nobody abandons.
		//
		// The `!drained` guard in that hook — don't call it cancellation when the iterator simply
		// ran out — is NOT proven here, and mutation says so: removing it leaves all three tests
		// green. It cannot be observed through this surface because the channel closes only after
		// the run has already settled, so an abort raised afterwards has nothing left to stop. It
		// stays because "cancelled" should mean cancelled, not because a test forces it.
		const { model } = pullModel(20);
		const runtime = createRuntime({ model });

		const stream = runtime.stream("go");
		const deltas: string[] = [];
		for await (const delta of stream.textStream) deltas.push(delta);

		const result = await stream.result;
		expect(result.status).toBe("completed");
		expect(deltas.join("")).toBe(result.text);
	});
});
