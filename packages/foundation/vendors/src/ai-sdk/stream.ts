// @busyclaw/vendors/ai-sdk — bridge a generic text-delta stream to the AI SDK's client wire
// protocols, so a frontend `useChat` / `useCompletion` talks to any producer of `{ textStream }`.
//
// This is deliberately NOT busyclaw-coupled: it takes a plain async-iterable of text plus an
// optional "finished" promise, so `runtime.stream` / `claw.api.stream` satisfy it structurally with
// no import. The only coupling is to the AI SDK (this package's whole reason to exist).
import type { TextDeltaStream } from "@busyclaw/contracts";
import {
	createTextStreamResponse,
	createUIMessageStream,
	createUIMessageStreamResponse,
} from "ai";

/**
 * The producer, held as an explicit iterator so a transport that hangs up can hand it back.
 *
 * `for await` returns its iterator on an early exit — but only for exits IT can see: a `break`, or a
 * throw from the loop body. A client closing the connection ends the response from the OUTSIDE, and
 * the loop never learns of it. Returning the iterator is the producer's only notice that nobody is
 * reading; without it a cancelled response leaves the run generating tokens into a closed socket.
 */
function deltaSource(stream: TextDeltaStream) {
	const deltas = stream.textStream[Symbol.asyncIterator]();
	return {
		next: () => deltas.next(),
		/** Idempotent, and a no-op once the iterator has finished on its own. */
		cancel: async () => {
			await deltas.return?.();
		},
		/** Let the producing run finish before the response ends. */
		finished: () => stream.result,
	};
}

type DeltaSource = ReturnType<typeof deltaSource>;

/** Walk the deltas to their end, telling the producer whatever else ends the walk. */
async function drain(
	source: DeltaSource,
	onDelta: (delta: string) => void,
): Promise<void> {
	try {
		while (true) {
			const next = await source.next();
			if (next.done) break;
			onDelta(next.value);
		}
	} finally {
		await source.cancel();
	}
	await source.finished();
}

/**
 * Re-wrap a response body so cancelling it reaches the producer.
 *
 * `createUIMessageStream` runs its `execute` callback to completion regardless of what happens to
 * the response — a client that hangs up mid-generation leaves it writing parts into a stream nobody
 * holds. There is no hook for it, so the body is wrapped in a stream that has one.
 */
function cancellable(response: Response, source: DeltaSource): Response {
	const body = response.body;
	if (!body) return response;
	const reader = body.getReader();
	const wrapped = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					controller.close();
					return;
				}
				controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			await source.cancel();
			await reader.cancel(reason);
		},
	});
	return new Response(wrapped, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

/**
 * The AI SDK **text** stream protocol (`text/plain`, raw concatenated deltas) — consumed by
 * `useCompletion({ streamProtocol: "text" })` or `useChat` with a `TextStreamChatTransport`.
 */
export function toTextStreamResponse(stream: TextDeltaStream): Response {
	const source = deltaSource(stream);
	return createTextStreamResponse({
		// `pull`, not `start`: the stream asks for the next delta only when its queue has room, so
		// the reader's own pace reaches the producer instead of the whole generation being pushed
		// into a queue as fast as the model can write it.
		stream: new ReadableStream<string>({
			async pull(controller) {
				try {
					const next = await source.next();
					if (!next.done) {
						controller.enqueue(next.value);
						return;
					}
					await source.finished();
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
			cancel: () => source.cancel(),
		}),
	});
}

/**
 * The AI SDK **UI message** stream protocol (SSE of typed parts) — the DEFAULT `useChat` consumes.
 * The deltas become one assistant text part (`start` → `text-start` → `text-delta`* → `text-end` →
 * `finish`); tool/data parts are a later extension of the same writer.
 */
export function toUIMessageStreamResponse(stream: TextDeltaStream): Response {
	const id = "text";
	const source = deltaSource(stream);
	const uiStream = createUIMessageStream({
		async execute({ writer }) {
			writer.write({ type: "start" });
			writer.write({ type: "text-start", id });
			await drain(source, (delta) =>
				writer.write({ type: "text-delta", id, delta }),
			);
			writer.write({ type: "text-end", id });
			writer.write({ type: "finish" });
		},
	});
	return cancellable(
		createUIMessageStreamResponse({ stream: uiStream }),
		source,
	);
}
