import { configurationError, stateError } from "@euroclaw/contracts";
import type { Governance } from "@euroclaw/core";
import type { ModelMessage, ToolSet } from "ai";
import { generateText, isStepCount, wrapLanguageModel } from "ai";
import type { RuntimeEventPayloadInput } from "./events";
import { modelMiddleware } from "./model-middleware";
import { abortIfNeeded, type RunState } from "./run-state";
import type {
	RuntimeAbortSignal,
	RuntimeModel,
	RuntimeResult,
} from "./runtime";

export type AiSdkLoopInput = {
	model: RuntimeModel;
	tools: ToolSet;
	system?: string;
	/** Arrives ALREADY redacted (the caller redacts at ingress) — the loop never re-redacts it. */
	prompt?: string;
	/** Arrive ALREADY redacted (checkpoints persist the placeholder-clean transcript). */
	messages?: ModelMessage[];
	startStep?: number;
	ctx?: Record<string, unknown>;
	resolvedCtx: Record<string, unknown>;
	core: Governance;
	state: RunState;
	maxSteps: number;
	now: () => string;
	abortSignal?: RuntimeAbortSignal;
	/** Invocation soft deadline (ISO). Past it, the loop parks a yield checkpoint and stops. */
	deadlineAt?: string;
	/** Persists the resume state at a yield point; returns the checkpoint id. The transcript is
	 *  placeholder-clean by construction (redact-at-ingress), so it persists as-is. */
	persistYieldCheckpoint?: (input: {
		nextStep: number;
		messages: ModelMessage[];
	}) => Promise<string>;
	emitEvent?: (payload: RuntimeEventPayloadInput) => Promise<void>;
	/** The redaction seam: applied ONCE to content entering the transcript (tool outputs) and to
	 *  event payloads. Everything downstream — model prompt, events, checkpoints, approvals —
	 *  reads the same placeholder text. */
	redactValue?: <T>(value: T) => Promise<T>;
};

export function toolResultMessage(
	toolCallId: string,
	toolName: string,
	output: unknown,
): ModelMessage {
	const value = serializeToolOutput(output);
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output: {
					type: "text",
					value,
				},
			},
		],
	};
}

function serializeToolOutput(output: unknown): string {
	if (typeof output === "string") return output;
	try {
		const value = JSON.stringify(output);
		if (typeof value === "string") return value;
	} catch (err) {
		throw stateError("tool output is not JSON-serializable", {
			reason: err instanceof Error ? err.message : String(err),
		});
	}
	throw stateError("tool output is not JSON-serializable", {
		reason: "JSON.stringify returned undefined",
	});
}

async function redact<T>(input: AiSdkLoopInput, value: T): Promise<T> {
	return input.redactValue ? await input.redactValue(value) : value;
}

export async function runAiSdkLoop(
	input: AiSdkLoopInput,
): Promise<RuntimeResult> {
	const model = wrapLanguageModel({
		model: input.model,
		middleware: modelMiddleware(
			input.core,
			input.model,
			input.ctx,
			input.resolvedCtx,
			input.state,
		),
	});
	const messages: ModelMessage[] = input.messages
		? [...input.messages]
		: [{ role: "user", content: input.prompt ?? "" }];

	for (let step = input.startStep ?? 0; step < input.maxSteps; step++) {
		abortIfNeeded(input.abortSignal);
		const res = await generateText({
			model,
			tools: input.tools,
			instructions: input.system,
			messages,
			stopWhen: isStepCount(1),
			...(input.abortSignal ? { abortSignal: input.abortSignal as never } : {}),
		});
		abortIfNeeded(input.abortSignal);
		messages.push(...res.response.messages);

		if (res.toolCalls.length === 0) {
			return {
				status: "completed",
				text: res.text,
				steps: step + 1,
			};
		}
		if (res.toolCalls.length > 1) {
			throw stateError(
				"euroclaw runtime currently supports one tool call per model step",
				{ toolCallCount: res.toolCalls.length },
			);
		}

		// The transcript is placeholder-clean by construction (ingress redaction) — snapshot, don't
		// re-redact: re-minting per step is what used to break coreference and prompt caching.
		input.state.currentMessages = [...messages];
		const toolMessages: ModelMessage[] = [];
		for (const toolCall of res.toolCalls) {
			abortIfNeeded(input.abortSignal);
			// Model-authored args may contain NOVEL raw PII the model composed — still redacted here.
			const redactedToolInput = await redact(input, toolCall.input);
			input.state.currentToolCallId = toolCall.toolCallId;
			input.state.currentToolName = toolCall.toolName;
			input.state.currentToolInput = redactedToolInput;
			input.state.currentStep = step;
			input.state.currentEffectId = undefined;
			input.state.currentApprovalWaitId = `${input.state.runInstanceId ?? input.now()}:${step}:${toolCall.toolCallId}`;
			const pendingBefore = new Set(
				(await input.core.approvals?.list({ status: "pending" }))?.map(
					(approval) => approval.id,
				) ?? [],
			);
			await input.emitEvent?.({
				args: redactedToolInput,
				step,
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				type: "tool.called",
			});
			let result: Awaited<ReturnType<Governance["handleToolCall"]>>;
			try {
				result = await input.core.handleToolCall(
					{ name: toolCall.toolName, args: redactedToolInput },
					input.ctx,
				);
			} catch (err) {
				const error =
					err instanceof Error
						? { name: err.name, message: err.message }
						: { message: String(err) };
				const redactedError = await redact(input, error);
				await input.emitEvent?.({
					error: redactedError,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.failed",
				});
				throw err;
			}
			if (result.status === "needs-approval") {
				if (!input.core.approvals) {
					throw configurationError(
						"runtime cannot wait for approval without a durable approval store",
						{ toolName: toolCall.toolName, toolCallId: toolCall.toolCallId },
					);
				}
				const pendingAfter =
					(await input.core.approvals.list({ status: "pending" })) ?? [];
				const approvalIds = pendingAfter
					.filter(
						(approval) =>
							approval.metadata?.waitId === input.state.currentApprovalWaitId,
					)
					.map((approval) => approval.id);
				if (approvalIds.length === 0) {
					const fallbackIds = pendingAfter
						.map((approval) => approval.id)
						.filter((id) => !pendingBefore.has(id));
					throw stateError(
						"approval was parked without runtime checkpoint metadata",
						{
							toolName: toolCall.toolName,
							toolCallId: toolCall.toolCallId,
							approvalIds: fallbackIds,
						},
					);
				}
				await input.emitEvent?.({
					approvalIds,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.waiting_approval",
				});
				return {
					status: "waiting_approval",
					text: "",
					steps: step + 1,
					approvalIds,
				};
			}
			// Tool output is the transcript ingress for world data — redact ONCE; the same
			// placeholder text feeds the event, the transcript, and (via them) checkpoints.
			const output =
				result.status === "ok"
					? await redact(input, result.output)
					: {
							__governance: result.status,
							reason: result.reason,
							reasonCode: result.reasonCode,
						};
			if (result.status === "ok") {
				await input.emitEvent?.({
					...(input.state.currentEffectId !== undefined
						? { effectId: input.state.currentEffectId }
						: {}),
					...(output !== undefined ? { output } : {}),
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.completed",
				});
			} else if (result.status === "denied") {
				await input.emitEvent?.({
					reason: result.reason,
					reasonCode: result.reasonCode,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.denied",
				});
			}
			toolMessages.push(
				toolResultMessage(toolCall.toolCallId, toolCall.toolName, output),
			);
		}
		messages.push(...toolMessages);

		// The resumable point: every tool result of this step is in the transcript, no call is
		// pending. Past the soft deadline, park the resume state and yield instead of paying the
		// next model call. The transcript is already placeholder-clean (ingress redaction), so it
		// persists as-is — pre- and post-yield transcripts are byte-identical by construction.
		// Skipped on the final step — the loop is about to exit anyway.
		if (
			input.deadlineAt !== undefined &&
			step + 1 < input.maxSteps &&
			input.now() >= input.deadlineAt
		) {
			if (!input.persistYieldCheckpoint) {
				throw configurationError(
					"deadline yields require a run checkpoint persister",
				);
			}
			const checkpointId = await input.persistYieldCheckpoint({
				nextStep: step + 1,
				messages,
			});
			return {
				status: "yielded",
				text: "",
				steps: step + 1,
				checkpointId,
			};
		}
	}

	throw stateError(
		`euroclaw: maxSteps (${input.maxSteps}) exceeded before the agent reached a final answer`,
		{ maxSteps: input.maxSteps },
	);
}
