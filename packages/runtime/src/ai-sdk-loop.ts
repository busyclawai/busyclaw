import {
	configurationError,
	EuroclawError,
	stateError,
} from "@euroclaw/contracts";
import type { Governance } from "@euroclaw/core";
import type { LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { generateText, isStepCount, streamText, wrapLanguageModel } from "ai";
import type {
	RuntimeEventError,
	RuntimeEventPayloadInput,
	RuntimeModelUsage,
} from "./events";
import { modelMiddleware } from "./model-middleware";
import { abortIfNeeded, type RunState } from "./run-state";
import type {
	RuntimeAbortSignal,
	RuntimeModel,
	RuntimeResult,
} from "./runtime";

export type AiSdkLoopInput = {
	model: RuntimeModel;
	/** The selected model opted out of PII redaction: the model boundary rehydrates the prompt for
	 *  it and re-redacts its output, so durable state stays tokenized. Default false. */
	rawPii?: boolean;
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
	/** Stream the model instead of generating it whole — each step uses `streamText` and pushes
	 *  rehydrated text deltas to `onDelta` as they arrive. The transcript still persists placeholders. */
	streaming?: boolean;
	/** Called with each rehydrated text delta while `streaming`. */
	onDelta?: (text: string) => void;
	/** placeholder → original, for turning streamed deltas into the reader-facing text. Identity when
	 *  there is no redactor. Buffered so a `{{pii:…}}` token split across deltas is never mangled. */
	rehydrateValue?: (text: string) => Promise<string>;
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

// The shared *.failed error payload. `reasonCode` is read only off a euroclaw-minted error's
// details — the one way a governed decision (e.g. a model-boundary deny) surfaces as a throw —
// so telemetry can tell "governed no" from "infra broke".
function errorEventPayload(err: unknown): RuntimeEventError {
	if (!(err instanceof Error)) return { message: String(err) };
	const reasonCode =
		err instanceof EuroclawError ? err.details?.reasonCode : undefined;
	return {
		message: err.message,
		name: err.name,
		reasonCode: typeof reasonCode === "string" ? reasonCode : undefined,
	};
}

// Project the AI SDK's usage onto the event mirror: numeric fields only — the provider-raw `raw`
// payload never enters the event stream.
function usageFromModelResult(usage: LanguageModelUsage): RuntimeModelUsage {
	return {
		inputTokens: usage.inputTokens,
		inputTokenDetails: {
			noCacheTokens: usage.inputTokenDetails?.noCacheTokens,
			cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
		},
		outputTokens: usage.outputTokens,
		outputTokenDetails: {
			textTokens: usage.outputTokenDetails?.textTokens,
			reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
		},
		totalTokens: usage.totalTokens,
	};
}

// Both-absent stays absent — a sum of unreported counts is unknown, not zero.
function addTokenCounts(
	a: number | undefined,
	b: number | undefined,
): number | undefined {
	if (a === undefined && b === undefined) return undefined;
	return (a ?? 0) + (b ?? 0);
}

function addRuntimeModelUsage(
	a: RuntimeModelUsage | undefined,
	b: RuntimeModelUsage,
): RuntimeModelUsage {
	if (!a) return b;
	return {
		inputTokens: addTokenCounts(a.inputTokens, b.inputTokens),
		inputTokenDetails: {
			noCacheTokens: addTokenCounts(
				a.inputTokenDetails?.noCacheTokens,
				b.inputTokenDetails?.noCacheTokens,
			),
			cacheReadTokens: addTokenCounts(
				a.inputTokenDetails?.cacheReadTokens,
				b.inputTokenDetails?.cacheReadTokens,
			),
			cacheWriteTokens: addTokenCounts(
				a.inputTokenDetails?.cacheWriteTokens,
				b.inputTokenDetails?.cacheWriteTokens,
			),
		},
		outputTokens: addTokenCounts(a.outputTokens, b.outputTokens),
		outputTokenDetails: {
			textTokens: addTokenCounts(
				a.outputTokenDetails?.textTokens,
				b.outputTokenDetails?.textTokens,
			),
			reasoningTokens: addTokenCounts(
				a.outputTokenDetails?.reasoningTokens,
				b.outputTokenDetails?.reasoningTokens,
			),
		},
		totalTokens: addTokenCounts(a.totalTokens, b.totalTokens),
	};
}

/** The loop's outcome plus the usage aggregate across ITS model calls (undefined when no model
 *  call reported usage) — `runtime.ts` lifts it onto the terminal run event, never onto the
 *  public `RuntimeResult`. */
export type AiSdkLoopResult = RuntimeResult & {
	usage: RuntimeModelUsage | undefined;
};

/**
 * The model-loop VENDOR seam. The runtime is loop-agnostic: it assembles a loop-neutral input
 * (model, tools, the governance core, run state, the redaction seam, event emitter) and hands it to
 * a vendor that knows how to actually drive the LLM. `streaming` declares whether this vendor can
 * stream — the runtime refuses a streaming run against one that can't. `ai-sdk-loop` is the default.
 */
export type ModelLoopVendor = {
	readonly streaming: boolean;
	generate: (input: AiSdkLoopInput) => Promise<AiSdkLoopResult>;
	/** Present iff `streaming`. Same contract as generate, but it pushes rehydrated text deltas to
	 *  `input.onDelta` while it runs, and resolves to the final result. */
	stream?: (input: AiSdkLoopInput) => Promise<AiSdkLoopResult>;
};

/** The default vendor — drives the model through the AI SDK, generate or stream. */
export const aiSdkLoop: ModelLoopVendor = {
	streaming: true,
	generate: (input) => runAiSdkLoop(input),
	stream: (input) => runAiSdkLoop({ ...input, streaming: true }),
};

/**
 * Turns streamed placeholder text into reader-facing text without mangling a `{{pii:…}}` token that
 * straddles two deltas: it holds back everything from the last UNCLOSED `{{` and rehydrates+emits
 * the rest, releasing the tail on flush.
 */
function createStreamRehydrator(
	rehydrate?: (text: string) => Promise<string>,
): {
	push: (delta: string) => Promise<string>;
	flush: () => Promise<string>;
} {
	let buffer = "";
	const emit = async (text: string): Promise<string> =>
		text === "" ? "" : rehydrate ? await rehydrate(text) : text;
	return {
		push: async (delta) => {
			buffer += delta;
			const lastOpen = buffer.lastIndexOf("{{");
			const safeEnd =
				lastOpen === -1 || buffer.indexOf("}}", lastOpen) !== -1
					? buffer.length
					: lastOpen;
			const ready = buffer.slice(0, safeEnd);
			buffer = buffer.slice(safeEnd);
			return emit(ready);
		},
		flush: async () => {
			const rest = buffer;
			buffer = "";
			return emit(rest);
		},
	};
}

export async function runAiSdkLoop(
	input: AiSdkLoopInput,
): Promise<AiSdkLoopResult> {
	const model = wrapLanguageModel({
		model: input.model,
		middleware: modelMiddleware(
			input.core,
			input.model,
			input.ctx,
			input.resolvedCtx,
			input.state,
			input.rawPii ?? false,
		),
	});
	const messages: ModelMessage[] = input.messages
		? [...input.messages]
		: [{ role: "user", content: input.prompt ?? "" }];
	let runUsage: RuntimeModelUsage | undefined;

	for (let step = input.startStep ?? 0; step < input.maxSteps; step++) {
		abortIfNeeded(input.abortSignal);
		const callParams = {
			model,
			tools: input.tools,
			instructions: input.system,
			messages,
			stopWhen: isStepCount(1),
			...(input.abortSignal ? { abortSignal: input.abortSignal as never } : {}),
		};
		// Streaming and non-streaming converge on the same normalized result (usage / finishReason /
		// response.messages / toolCalls / text) — so the whole tool-governance loop below is shared.
		// Streaming additionally pushes rehydrated text deltas to `onDelta` as the model produces them.
		const callModel = async () => {
			if (!input.streaming) return generateText(callParams);
			const streamed = streamText(callParams);
			const rehydrator = createStreamRehydrator(input.rehydrateValue);
			for await (const delta of streamed.textStream) {
				const shown = await rehydrator.push(delta);
				if (shown !== "") input.onDelta?.(shown);
			}
			const tail = await rehydrator.flush();
			if (tail !== "") input.onDelta?.(tail);
			return {
				usage: await streamed.usage,
				finishReason: await streamed.finishReason,
				response: await streamed.response,
				toolCalls: await streamed.toolCalls,
				text: await streamed.text,
			};
		};
		const modelStartedAt = Date.now();
		let res: Awaited<ReturnType<typeof callModel>>;
		try {
			res = await callModel();
		} catch (err) {
			// Provider errors can echo prompt content — same redaction seam as tool.failed's error.
			const redactedError = await redact(input, errorEventPayload(err));
			await input.emitEvent?.({
				durationMs: Date.now() - modelStartedAt,
				error: redactedError,
				step,
				type: "model.failed",
			});
			throw err;
		}
		const modelDurationMs = Date.now() - modelStartedAt;
		const stepUsage = usageFromModelResult(res.usage);
		runUsage = addRuntimeModelUsage(runUsage, stepUsage);
		await input.emitEvent?.({
			durationMs: modelDurationMs,
			finishReason: res.finishReason,
			step,
			type: "model.completed",
			usage: stepUsage,
		});
		abortIfNeeded(input.abortSignal);
		messages.push(...res.response.messages);

		if (res.toolCalls.length === 0) {
			return {
				status: "completed",
				text: res.text,
				steps: step + 1,
				usage: runUsage,
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
			const toolStartedAt = Date.now();
			let result: Awaited<ReturnType<Governance["handleToolCall"]>>;
			try {
				result = await input.core.handleToolCall(
					{ name: toolCall.toolName, args: redactedToolInput },
					input.ctx,
				);
			} catch (err) {
				const redactedError = await redact(input, errorEventPayload(err));
				await input.emitEvent?.({
					durationMs: Date.now() - toolStartedAt,
					error: redactedError,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					type: "tool.failed",
				});
				throw err;
			}
			const toolDurationMs = Date.now() - toolStartedAt;
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
					usage: runUsage,
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
					durationMs: toolDurationMs,
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
				usage: runUsage,
			};
		}
	}

	throw stateError(
		`euroclaw: maxSteps (${input.maxSteps}) exceeded before the agent reached a final answer`,
		{ maxSteps: input.maxSteps },
	);
}
