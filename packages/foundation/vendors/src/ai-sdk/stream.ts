// @euroclaw/vendors/ai-sdk — bridge a generic text-delta stream to the AI SDK's client wire
// protocols, so a frontend `useChat` / `useCompletion` talks to any producer of `{ textStream }`.
//
// This is deliberately NOT euroclaw-coupled: it takes a plain async-iterable of text plus an
// optional "finished" promise, so `runtime.stream` / `claw.api.stream` satisfy it structurally with
// no import. The only coupling is to the AI SDK (this package's whole reason to exist).
import type { TextDeltaStream } from "@euroclaw/contracts";
import {
	createTextStreamResponse,
	createUIMessageStream,
	createUIMessageStreamResponse,
} from "ai";

async function drain(
	stream: TextDeltaStream,
	onDelta: (delta: string) => void,
): Promise<void> {
	for await (const delta of stream.textStream) onDelta(delta);
	await stream.result; // let the producing run finish before the response ends
}

/**
 * The AI SDK **text** stream protocol (`text/plain`, raw concatenated deltas) — consumed by
 * `useCompletion({ streamProtocol: "text" })` or `useChat` with a `TextStreamChatTransport`.
 */
export function toTextStreamResponse(stream: TextDeltaStream): Response {
	return createTextStreamResponse({
		stream: new ReadableStream<string>({
			async start(controller) {
				try {
					await drain(stream, (delta) => controller.enqueue(delta));
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
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
	const uiStream = createUIMessageStream({
		async execute({ writer }) {
			writer.write({ type: "start" });
			writer.write({ type: "text-start", id });
			await drain(stream, (delta) =>
				writer.write({ type: "text-delta", id, delta }),
			);
			writer.write({ type: "text-end", id });
			writer.write({ type: "finish" });
		},
	});
	return createUIMessageStreamResponse({ stream: uiStream });
}
