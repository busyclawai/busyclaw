// A WATCH → the AI SDK's UI message stream, so `useChat` renders a turn somebody else is driving
// with no adapter code of its own.
//
// The sibling in ./stream.ts bridges the DRIVER's own deltas. This bridges the WATCHER's view: the
// same turn, read back out of the run stream by anyone with access, which is what makes a second tab
// — or a second person — see the answer land.
//
// ONE RUN PER RESPONSE, and that is the protocol's constraint rather than a choice. Its consumer
// keeps a single `state.message`, and a second `start` RENAMES that message instead of opening
// another (`ai@7`, `processUIMessageStream`). So a whole conversation cannot be sent this way; a
// reader that holds several messages at once takes `watchThread`'s chunks directly and demultiplexes
// on `runId`.
//
// WHY THE CHUNKS ARE NOT SIMPLY STORED IN THIS SHAPE. They outlive a request — a reader can be
// mid-cursor for an hour — they carry a `runId` this protocol has nowhere to put, and an ops view
// watching a cron run does not want a chat message. Encoding at the wire costs nothing and keeps the
// buffer ours.

import type { RunStreamChunk, RunStreamPage } from "@busyclaw/contracts";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessageStreamWriter,
} from "ai";

/**
 * Write one run's chunks as UI message parts.
 *
 * STATEFUL because the protocol brackets text (`text-start` … `text-end`) where chunks are a flat
 * run of deltas: the bracket opens on the first delta and closes before anything that is not text.
 */
function createChunkWriter(writer: UIMessageStreamWriter, runId: string) {
	// One text part per assistant message, named for the run it belongs to.
	const id = runId;
	let textOpen = false;
	let finished = false;

	const closeText = (): void => {
		if (!textOpen) return;
		textOpen = false;
		writer.write({ type: "text-end", id });
	};

	return {
		finished: () => finished,
		closeText,
		write: (chunk: RunStreamChunk): void => {
			switch (chunk.kind) {
				case "run.started":
					// `messageId` is where `runId` goes — the mapping that makes a run and an assistant
					// message the same thing from a client's side, so nothing at the edge says "run".
					writer.write({ type: "start", messageId: runId });
					return;

				case "text":
					if (!textOpen) {
						textOpen = true;
						writer.write({ type: "text-start", id });
					}
					writer.write({ type: "text-delta", id, delta: chunk.text });
					return;

				case "tool": {
					// TEXT CLOSES FIRST. A tool part inside an open text part nests two things the
					// protocol expects to be siblings — and it reads the way an answer actually goes:
					// prose, a tool call, more prose as a new text part.
					closeText();
					if (
						chunk.status === "called" ||
						chunk.status === "waiting_approval"
					) {
						writer.write({
							type: "tool-input-available",
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName,
							// EMPTY, because the chunk carries no arguments by design — a watcher is told
							// which tool runs, never what it was handed. The field is required, so it is
							// present and honest rather than invented.
							input: {},
						});
						return;
					}
					if (chunk.status === "completed") {
						// Same rule coming back: the fact of completion, not the payload.
						writer.write({
							type: "tool-output-available",
							toolCallId: chunk.toolCallId,
							output: {},
						});
						return;
					}
					if (chunk.status === "denied") {
						writer.write({
							type: "tool-output-denied",
							toolCallId: chunk.toolCallId,
						});
						return;
					}
					writer.write({
						type: "tool-output-error",
						toolCallId: chunk.toolCallId,
						errorText: "the tool call failed",
					});
					return;
				}

				case "lifecycle": {
					// NEITHER OF THESE ENDS THE MESSAGE. A resume continues it, and a supersede means a
					// new generation of the same run is about to arrive — which this protocol cannot
					// express, since it has no way to say "discard what I already sent". A client that
					// needs that reads chunks instead.
					if (chunk.event === "superseded" || chunk.event === "resumed") return;
					if (chunk.event === "parked") {
						// PARKED IS NOT FINISHED. `finish` would tell the client the answer is complete
						// while it waits on an approval that may be granted minutes later, and the rest
						// would then arrive after a message the client had already closed.
						closeText();
						return;
					}
					finished = true;
					closeText();
					writer.write({
						type: "finish",
						...(chunk.event === "completed" ? {} : { finishReason: "error" }),
					});
					return;
				}
			}
		},
	};
}

/**
 * Serve `claw.api.watchRun` as the stream `useChat` consumes by default.
 *
 * `pages` is what `watchRun` hands back. It is read to its end, or until the client hangs up —
 * a watch is an infinite subscription until its run goes terminal, so ending the read is the only
 * thing that stops it.
 */
export function watchToUIMessageStreamResponse(input: {
	runId: string;
	pages: AsyncIterable<RunStreamPage>;
}): Response {
	const pages = input.pages[Symbol.asyncIterator]();
	let cancelled = false;
	const uiStream = createUIMessageStream({
		async execute({ writer }) {
			const chunks = createChunkWriter(writer, input.runId);
			try {
				while (!cancelled) {
					const next = await pages.next();
					if (next.done) break;
					for (const chunk of next.value.chunks) chunks.write(chunk);
					// A STALE page means the client's cursor points past the log, so there is nothing
					// further this stream can honestly say. It stops; the client reloads the transcript.
					if (next.value.stale) break;
					if (chunks.finished()) break;
				}
			} finally {
				// An unterminated text part would leave a client rendering a message that never ends,
				// so close it however the loop exited — terminal chunk, stale page, or hang-up.
				chunks.closeText();
				await pages.return?.(undefined);
			}
		},
	});
	return cancellableResponse(
		createUIMessageStreamResponse({ stream: uiStream }),
		() => {
			cancelled = true;
			return pages.return?.(undefined).then(() => undefined);
		},
	);
}

/**
 * Re-wrap a response body so cancelling it reaches the producer.
 *
 * `createUIMessageStream` runs `execute` to completion regardless of what happens to the response, so
 * a client that hangs up mid-turn would otherwise leave this polling a run stream nobody holds. Same
 * problem, same shape, as the one ./stream.ts solves for the driver's own deltas.
 */
function cancellableResponse(
	response: Response,
	onCancel: () => Promise<void> | undefined,
): Response {
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
			await onCancel();
			await reader.cancel(reason);
		},
	});
	return new Response(wrapped, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}
