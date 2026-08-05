// TOOL VISIBILITY for a watcher, sourced from the runtime's own event stream.
//
// A tool call is where a turn goes quiet: ten seconds of no text while something runs. Without this
// a watcher sees a stalled answer and cannot tell it from a hung one. With it they see "running
// send_email…" and then its result.
//
// SOURCED FROM EVENTS RATHER THAN FROM THE STREAM PATH, because the runtime already emits exactly
// this — `tool.called` / `tool.completed` / `tool.waiting_approval`, each carrying the recording and
// the run id. The alternative was widening `TextDeltaStream` to carry structure, which would have
// broken the property that makes `sendMessageAndStream` worth having: `{ textStream }` of STRINGS is
// what the AI SDK response bridges accept, so a chat UI drops it straight in.
//
// AN OBSERVER, with an observer's rules. It writes to a transport buffer, so a failure here is
// dropped rather than raised — the same disposition every other write to that buffer has, and the
// reason this can be wired in unconditionally.

import type { RunStreamChunk, RunStreamPort } from "@busyclaw/contracts";
import { runStreamKey, threadStreamKey } from "@busyclaw/contracts";
import type { RuntimeEvent, RuntimeEventSink } from "@busyclaw/runtime";

/** The event types this maps, and the status each becomes. Anything else is ignored: `text` and the
 *  run lifecycle already reach the stream from the engine, which knows its claim's attempt. */
const TOOL_STATUS = {
	"tool.called": "called",
	"tool.completed": "completed",
	"tool.waiting_approval": "waiting_approval",
	"tool.denied": "denied",
	"tool.failed": "failed",
} as const satisfies Record<
	string,
	Extract<RunStreamChunk, { kind: "tool" }>["status"]
>;

/** Narrows to the five variants above — all of which declare `step`, `toolCallId` and `toolName`, so
 *  reading them below needs no cast. `RuntimeEvent` is discriminated on `type`, which is what makes
 *  this a real narrowing rather than an assertion dressed as one. */
function isToolEvent(
	event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: keyof typeof TOOL_STATUS }> {
	return event.type in TOOL_STATUS;
}

/**
 * An event sink that mirrors tool lifecycle into the run stream.
 *
 * Wired whenever a `runStream` is configured. Silent when a run has no id to attribute chunks to —
 * an ad-hoc `generate` has no durable run and therefore no subscription anyone could be watching.
 */
export function createRunStreamEventSink(
	stream: RunStreamPort,
): RuntimeEventSink {
	return {
		async emit(event) {
			if (!isToolEvent(event)) return;
			const runId = event.runId;
			if (runId === undefined) return;
			// The same key the engine writes: the THREAD when there is one, so these chunks interleave
			// with that run's text in the log a watcher is already reading.
			const threadId = event.recording?.threadId;
			const key =
				threadId !== undefined
					? threadStreamKey(threadId)
					: runStreamKey(runId);
			try {
				await stream.append(key, {
					kind: "tool",
					runId,
					step: event.step,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					status: TOOL_STATUS[event.type],
				});
			} catch {
				// Advisory, like every write to this buffer. A tool call whose announcement failed still
				// ran, and the answer it produces still lands in the transcript.
			}
		},
	};
}
