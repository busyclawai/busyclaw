import type { ClawsStore, JsonObject } from "@busyclaw/contracts";
import type { RuntimeEventSink } from "@busyclaw/runtime";

/**
 * A row in the thread saying a run stopped without answering, and why.
 *
 * WHY A MESSAGE AND NOT A CHECKPOINT. A reader has no run id to ask about until something in the
 * thread hands them one, and `listMessages` is the only thread-scoped door there is — there is no
 * `listCheckpoints` and no thread→runs listing. So a state written only as a checkpoint answers
 * nobody, and a turn that parks, waits on approval or is denied simply stops mid-air (D10).
 *
 * `visibility: "internal"` is what separates it from an answer: it is a record of what happened to
 * the run, not the assistant addressing the user, and a client that renders only `user` visibility
 * never sees it. It carries the assistant's partial text too, when there was any, because those
 * words were produced, paid for and often already streamed — dropping them at the boundary loses the
 * only record that they happened.
 *
 * NOT `once: true`, and that is load-bearing rather than an omission. The `once` fence is keyed on
 * `(threadId, runId)` and belongs to the run's ONE assistant reply; a notice claiming it would make
 * the actual answer — appended later by `run.completed` — lose the fence and never land. A run can
 * also legitimately park more than once, and each stop is its own record.
 */
async function appendRunNotice(input: {
	store: ClawsStore;
	recording: { clawId: string; threadId: string };
	event: { id: string; runId?: string | undefined };
	text?: string | undefined;
	marker: JsonObject;
}): Promise<void> {
	const { store, recording, event, text, marker } = input;
	await store.messages.append({
		clawId: recording.clawId,
		content: { text: text ?? "", run: marker },
		...(event.runId ? { runId: event.runId } : {}),
		role: "assistant",
		threadId: recording.threadId,
		visibility: "internal",
	});
}

async function findToolCall(input: {
	store: ClawsStore;
	runId: string | undefined;
	toolCallId: string;
}) {
	if (!input.runId) return null;
	return input.store.toolCalls.getByToolCallId({
		runId: input.runId,
		toolCallId: input.toolCallId,
	});
}

/** Persist runtime lifecycle events into the durable Claw domain model. */
export function createClawRuntimeEventSink(
	store: ClawsStore,
): RuntimeEventSink {
	return {
		async emit(event) {
			const recording = event.recording;
			if (!recording) return;
			if (event.type === "tool.called") {
				if (!event.runId) return;
				await store.toolCalls.create({
					args: event.args,
					clawId: recording.clawId,
					runId: event.runId,
					status: "proposed",
					threadId: recording.threadId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				});
				return;
			}

			if (event.type === "tool.waiting_approval") {
				const call = await findToolCall({
					store,
					runId: event.runId,
					toolCallId: event.toolCallId,
				});
				if (call) {
					await store.toolCalls.updateStatus(call.id, {
						approvalId: event.approvalIds[0],
						status: "waiting_approval",
					});
				}
				return;
			}

			if (event.type === "tool.completed") {
				if (!event.runId) return;
				const call = await findToolCall({
					store,
					runId: event.runId,
					toolCallId: event.toolCallId,
				});
				if (call) {
					await store.toolCalls.updateStatus(call.id, {
						...(event.effectId ? { effectId: event.effectId } : {}),
						status: "completed",
					});
				}
				const existingResults = await store.toolResults.listForToolCall({
					runId: event.runId,
					toolCallId: event.toolCallId,
				});
				if (!existingResults.some((result) => result.status === "completed")) {
					await store.toolResults.create({
						clawId: recording.clawId,
						output: event.output,
						outputMode: "redacted",
						runId: event.runId,
						status: "completed",
						threadId: recording.threadId,
						toolCallId: event.toolCallId,
					});
				}
				return;
			}

			if (event.type === "tool.denied") {
				if (!event.runId) return;
				const call = await findToolCall({
					store,
					runId: event.runId,
					toolCallId: event.toolCallId,
				});
				if (call)
					await store.toolCalls.updateStatus(call.id, { status: "denied" });
				const existingResults = await store.toolResults.listForToolCall({
					runId: event.runId,
					toolCallId: event.toolCallId,
				});
				if (existingResults.length === 0) {
					await store.toolResults.create({
						clawId: recording.clawId,
						error: {
							...(event.decidedBy ? { decidedBy: event.decidedBy } : {}),
							reason: event.reason,
							...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
						},
						outputMode: "redacted",
						runId: event.runId,
						status: "failed",
						threadId: recording.threadId,
						toolCallId: event.toolCallId,
					});
				}
				return;
			}

			if (event.type === "tool.failed") {
				if (!event.runId) return;
				const call = await findToolCall({
					store,
					runId: event.runId,
					toolCallId: event.toolCallId,
				});
				if (call)
					await store.toolCalls.updateStatus(call.id, { status: "failed" });
				const existingResults = await store.toolResults.listForToolCall({
					runId: event.runId,
					toolCallId: event.toolCallId,
				});
				if (existingResults.length === 0) {
					await store.toolResults.create({
						clawId: recording.clawId,
						error: event.error,
						outputMode: "redacted",
						runId: event.runId,
						status: "failed",
						threadId: recording.threadId,
						toolCallId: event.toolCallId,
					});
				}
				return;
			}

			if (event.type === "run.completed") {
				// AT MOST ONCE per run, fenced by an insert the database arbitrates.
				//
				// This used to scan the thread and compare content: if an assistant message for this run
				// already carried the same text, skip. Two things wrong with it. It cannot survive a
				// NONDETERMINISTIC model — the replay produces different words, the comparison misses,
				// and the reader gets one question answered twice in two ways. And it was a
				// read-then-write with nothing atomic between the halves, so two drivers of one run both
				// saw nothing and both appended.
				//
				// The window is real: this append runs INSIDE `runTask`, before `completeTask`, so a
				// lease lapsing in between leaves the reply committed and the task un-completed, and the
				// re-claim replays the slice.
				await store.messages.append({
					clawId: recording.clawId,
					content: { text: event.text },
					...(event.runId ? { runId: event.runId, once: true } : {}),
					role: "assistant",
					threadId: recording.threadId,
					visibility: "user",
				});
				return;
			}

			if (event.type === "run.waiting_approval") {
				await store.checkpoints.create({
					clawId: recording.clawId,
					kind: "approval_wait",
					runId: event.runId ?? event.id,
					state: { approvalIds: event.approvalIds ?? [] },
					threadId: recording.threadId,
				});
				// AND A ROW A THREAD READER CAN SEE. The checkpoint above answers nobody: there is no
				// `listCheckpoints` and no thread→runs listing, so anything written only as a checkpoint
				// is invisible to `listMessages`, which is the one thread-scoped door there is. Without
				// this, "waiting for your approval" is indistinguishable from "still working" and from
				// "dead" (D10).
				await appendRunNotice({
					event,
					recording,
					store,
					text: event.text,
					marker: {
						state: "waiting_approval",
						approvalIds: event.approvalIds ?? [],
					},
				});
				return;
			}

			if (event.type === "run.parked") {
				// Product-history record, kind `park` rather than `step`: a yield comes back on its own
				// and this does not, and a reader who cannot tell them apart cannot tell a run that is
				// working from one that is waiting for a verb.
				await store.checkpoints.create({
					clawId: recording.clawId,
					kind: "park",
					runId: event.runId ?? event.id,
					state: {
						checkpointId: event.checkpointId,
						reason: event.reason,
					},
					step: event.steps,
					threadId: recording.threadId,
				});
				await appendRunNotice({
					event,
					recording,
					store,
					text: event.text,
					marker: { state: "parked", reason: event.reason },
				});
				return;
			}

			if (event.type === "run.denied") {
				// A denied run used to leave a `denied` tool_call, a failed tool_result, and SILENCE at
				// the run level — the thread simply stopped, with the reason readable only by joining two
				// tool tables by run id.
				await appendRunNotice({
					event,
					recording,
					store,
					text: event.text,
					marker: {
						state: "denied",
						approvalId: event.approvalId,
						...(event.decidedBy !== undefined
							? { decidedBy: event.decidedBy }
							: {}),
						...(event.reasonCode !== undefined
							? { reasonCode: event.reasonCode }
							: {}),
					},
				});
				return;
			}

			if (event.type === "run.yielded") {
				// Product-history record of the slice boundary; the operational resume state lives in
				// the runtime's run_checkpoint store, not here.
				await store.checkpoints.create({
					clawId: recording.clawId,
					kind: "step",
					runId: event.runId ?? event.id,
					state: { checkpointId: event.checkpointId },
					step: event.steps,
					threadId: recording.threadId,
				});
				// NO NOTICE HERE, deliberately, and it is the one non-terminal end that gets none: a
				// yield's continuation is already enqueued, so the turn is still going and a "stopped"
				// marker in the thread would be false. The slice's own text rides the run EVENT instead
				// — the transcript still shows one assistant message per turn, written by whichever
				// slice completes it, which is what D6 chose over per-step messages.
			}
		},
	};
}
