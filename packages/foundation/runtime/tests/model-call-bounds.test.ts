import { APICallError, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { MODEL_CALL_MAX_RETRIES } from "../src/ai-sdk-loop";
import { createRuntime, type RuntimeEvent } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const USAGE = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/**
 * A provider that answers nothing and — like a real one — rejects when its signal aborts.
 *
 * That second half is the whole point. `fetch` is what turns an abort into a rejection in
 * production, so a stub that ignored the signal would be testing a provider that cannot exist. What
 * it pins is that SOMETHING fires the abort: with no timeout wired, nothing does, and the run waits
 * on this promise until the test runner gives up.
 */
function hangingModel(): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) =>
			new Promise((_resolve, reject) => {
				options.abortSignal?.addEventListener("abort", () => {
					reject(new Error("request aborted"));
				});
			}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

/** Counts every attempt that reaches the provider, and fails them all with an error the SDK
 *  classifies as retryable — so the attempt count IS the configured retry budget plus one. */
function alwaysRetryableModel(attempts: { count: number }): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			attempts.count++;
			throw new APICallError({
				message: "upstream unavailable",
				url: "https://mock.invalid/v1/messages",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
				// Collapses the SDK's 2s/4s exponential backoff to nothing. A real 503 may carry this
				// header and the SDK honours it, so the retry path under test is the real one — it just
				// runs at test speed instead of taking six seconds to prove a count.
				responseHeaders: { "retry-after-ms": "1" },
			});
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

/** Fails `failures` times with a retryable error, then answers. */
function flakyModel(attempts: { count: number }, failures: number): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			attempts.count++;
			if (attempts.count <= failures) {
				throw new APICallError({
					message: "upstream unavailable",
					url: "https://mock.invalid/v1/messages",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: true,
					responseHeaders: { "retry-after-ms": "1" },
				});
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop", raw: undefined },
				usage: USAGE,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

describe("model call bounds", () => {
	// Fails by TIMING OUT without the fix, which is exactly the production symptom: the engine's
	// heartbeat renews the task lease on its own timer whether or not the call is progressing, and
	// `deadlineAt` is only read between steps — so nothing else in the system can end this wait.
	it("ends a model call that never answers, instead of waiting forever", async () => {
		const events: RuntimeEvent[] = [];
		const runtime = createRuntime({
			model: hangingModel(),
			modelCallTimeoutMs: 50,
			events: { emit: (event) => void events.push(event) },
		});

		await expect(runtime.generate("hello")).rejects.toThrow();
		expect(events.map((event) => event.type)).toContain("model.failed");
	});

	// The number reaching the provider is the number this codebase declared — not the SDK's own
	// default, which is what applied while `maxRetries` went unset.
	it("attempts a failing model call exactly the declared number of times", async () => {
		const attempts = { count: 0 };
		const runtime = createRuntime({
			model: alwaysRetryableModel(attempts),
			// Comfortably above the SDK's 2s/4s retry backoff, so the bound under test is the retry
			// budget rather than the clock.
			modelCallTimeoutMs: 30_000,
		});

		await expect(runtime.generate("hello")).rejects.toThrow();
		expect(attempts.count).toBe(MODEL_CALL_MAX_RETRIES + 1);
	});

	// WHY THE RETRIES ARE WORTH KEEPING: a transient provider error that escapes the loop fails the
	// run, and the engine's answer to a failed run is to re-claim the task — a far more expensive
	// retry than re-sending the request. Recovering here is what keeps that path rare.
	it("recovers from a transient provider error without failing the run", async () => {
		const attempts = { count: 0 };
		const runtime = createRuntime({
			model: flakyModel(attempts, MODEL_CALL_MAX_RETRIES),
			modelCallTimeoutMs: 30_000,
		});

		const result = await runtime.generate("hello");

		expect(result).toMatchObject({ status: "completed", text: "done" });
		expect(attempts.count).toBe(MODEL_CALL_MAX_RETRIES + 1);
	});
});
