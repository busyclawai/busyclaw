import type { ClawsStore } from "@busyclaw/contracts";
import type { RuntimeEventSink } from "@busyclaw/runtime";

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
				if (event.runId) {
					const existing = await store.messages.listForThread({
						threadId: recording.threadId,
					});
					const textContent = { text: event.text };
					if (
						existing.some(
							(message) =>
								message.role === "assistant" &&
								message.runId === event.runId &&
								JSON.stringify(message.content) === JSON.stringify(textContent),
						)
					) {
						return;
					}
				}
				await store.messages.append({
					clawId: recording.clawId,
					content: { text: event.text },
					...(event.runId ? { runId: event.runId } : {}),
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
			}
		},
	};
}
