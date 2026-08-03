import {
	BusyclawError,
	configurationError,
	type HandleResult,
	stateError,
} from "@busyclaw/contracts";
import type { Governance } from "@busyclaw/core";
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
	RunParkReason,
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
	/**
	 * The tool-call INGRESS translation: the wire encoding the provider emitted → the canonical path
	 * and the target's own args. Applied once, at the top of the call, so governance, dispatch, the
	 * audit, approvals, effects and the transcript all speak the one canonical id. Two encodings
	 * arrive here — a flattened wire name, and an `busyclaw__execute` envelope naming a discoverable
	 * tool — and neither survives the translation. Absent (or a name nothing declared) leaves the
	 * call exactly as it arrived.
	 */
	resolveToolCall?: (call: { name: string; input: unknown }) => {
		path: string;
		args: unknown;
	};
	/**
	 * Does this run have a tool at that canonical path? Checked BEFORE the governance chokepoint, so a
	 * name nothing declared is answered "no such tool" rather than "not permitted".
	 *
	 * The two used to be the same event by accident: an unmodeled action skipped the floor and fell
	 * through to dispatch, which raised the crisp error. With every call gated, the floor answers first
	 * and denies a path it has no action for — safe, but it tells a model that named a tool wrongly
	 * that it lacks permission, which is the one message guaranteed to make it stop rather than fix the
	 * call. Existence is not an authorization question; it is asked first.
	 */
	knownToolPath?: (path: string) => boolean;
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
	/**
	 * The one place the loop looks OUTWARD, called at the top of every step. Returns a park reason
	 * when an external actor has asked this run to stop, `undefined` to carry on.
	 *
	 * This is the whole seam: durable intents are somebody else's problem, and the loop never learns
	 * WHY beyond the reason it is handed. That is what lets the intent set grow without this call
	 * site changing again. Absent — an ad-hoc `generate` with no database — is one branch and zero
	 * reads, and behaviour is byte-identical to a loop that never had it.
	 */
	controlPoint?: (step: number) => Promise<RunParkReason | undefined>;
	emitEvent?: (payload: RuntimeEventPayloadInput) => Promise<void>;
	/** The redaction seam: applied ONCE to content entering the transcript (MODEL output and tool
	 *  outputs) and to event payloads. Everything downstream — model prompt, events, checkpoints,
	 *  approvals — reads the same placeholder text. Model output is included because a model can
	 *  EMIT PII it was never shown, and an untokenized value is one erasure can never reach. */
	redactValue?: <T>(value: T) => Promise<T>;
	/** Stream the model instead of generating it whole — each step uses `streamText` and pushes
	 *  rehydrated text deltas to `onDelta` as they arrive. The transcript still persists placeholders. */
	streaming?: boolean;
	/** Called with each rehydrated text delta while `streaming`. AWAITED: a consumer whose buffer is
	 *  full answers with a promise, and awaiting it here is what stops the read from the provider —
	 *  backpressure only exists if the producer is willing to wait. */
	onDelta?: (text: string) => void | Promise<void>;
	/** placeholder → original, for turning streamed deltas into the reader-facing text. Identity when
	 *  there is no redactor. Buffered so a `{{pii:…}}` token split across deltas is never mangled. */
	/** REMOVED — see {@link createStreamGuard}. Streamed deltas are redacted, never re-identified:
	 *  the stream carries what the transcript carries. Kept out of the input rather than left unused,
	 *  so nothing can quietly start rehydrating again. */
};

/**
 * The tool result as the provider expects it back. `toolName` is the MODEL-FACING wire name — the
 * one the provider emitted, not the canonical path — because a result is correlated by the pair the
 * call arrived as: most providers match on `toolCallId` alone, but some (Gemini's `functionResponse`)
 * match on the name. This is the one place inside the loop that still speaks the wire.
 */
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

/**
 * What the MODEL is told when a governed call did not go through. The one builder for it, shared by
 * the loop and the approval resume, because it is the door author-written policy text uses to reach
 * an agent and a second copy would drift.
 *
 * `annotations` here is the MODEL-audience bag only — the keys a plugin declared `audience: "model"`
 * (`@guidance("ask the requester to route this to People Ops")`). The host's bag is a different field
 * on the result and is not read here at all: an `@escalate("betterauth:org_123")` is an internal id
 * for an after-gate to route on, and nothing internal should be spent on, or exposed to, a context
 * window. Advisory like the rest of this payload — it explains a decision already made.
 */
export function governanceToolResult(
	result: Extract<HandleResult, { status: "denied" | "needs-approval" }>,
): Record<string, unknown> {
	return {
		__governance: result.status,
		reason: result.reason,
		reasonCode: result.reasonCode,
		...(result.modelAnnotations
			? { annotations: result.modelAnnotations }
			: {}),
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

// The shared *.failed error payload. `reasonCode` is read only off a busyclaw-minted error's
// details — the one way a governed decision (e.g. a model-boundary deny) surfaces as a throw —
// so telemetry can tell "governed no" from "infra broke".
function errorEventPayload(err: unknown): RuntimeEventError {
	if (!(err instanceof Error)) return { message: String(err) };
	const reasonCode =
		err instanceof BusyclawError ? err.details?.reasonCode : undefined;
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
 * Makes a streamed delta safe to put on the wire, and holds back only what it must.
 *
 * R-M04. This used to be a REHYDRATOR: it turned `{{pii:…}}` placeholders back into the real values
 * as the deltas flew past. So a run whose whole point was that durable state stays tokenized shipped
 * the untokenized values to the reader anyway — no authorization, no audit, and in direct
 * contradiction of the api layer, which says so explicitly: "re-identifying deltas as they fly past
 * would put raw PII on the wire under a flag meant for one audited read." The transcript and the
 * stream disagreed about what the run had said, and the stream was the leaky one.
 *
 * Now the stream carries what the TRANSCRIPT carries. Placeholders stay placeholders, and the text is
 * run through the same redactor the final result gets, so novel PII the model emits from training or
 * reassembles from fragments the ingress detector missed is tokenized before it leaves rather than
 * only after. A caller who wants the original reads it back through `listMessages` once the run has
 * landed — one audited read of a finished value, which is the shape that was always intended.
 *
 * Two things are held back to make that possible, both released on flush:
 *   - everything from the last UNCLOSED `{{`, so a placeholder split across deltas is never mangled;
 *   - any trailing partial word, so a value is not offered to the detector cut in half.
 *
 * The residual, stated rather than papered over: a span the detector would match ACROSS a held
 * boundary — a two-word name whose halves land in different emitted chunks — is not caught, because
 * catching it would mean buffering the whole stream and streaming nothing. The final result is
 * redacted whole, so what is persisted is complete either way; it is the wire that is best-effort.
 */
function createStreamGuard(redact?: (text: string) => Promise<string>): {
	push: (delta: string) => Promise<string>;
	flush: () => Promise<string>;
} {
	let buffer = "";
	const emit = async (text: string): Promise<string> =>
		text === "" ? "" : redact ? await redact(text) : text;
	return {
		push: async (delta) => {
			buffer += delta;
			// Never split a placeholder…
			const lastOpen = buffer.lastIndexOf("{{");
			const tokenEnd =
				lastOpen === -1 || buffer.indexOf("}}", lastOpen) !== -1
					? buffer.length
					: lastOpen;
			// …and never hand the detector half a word: cut at the last whitespace before that point,
			// so "alice@examp" + "le.com" is offered as one string rather than two unrecognisable ones.
			const boundary = buffer.slice(0, tokenEnd).search(/\s\S*$/);
			const safeEnd = boundary === -1 ? 0 : Math.min(boundary + 1, tokenEnd);
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

	const startStep = input.startStep ?? 0;

	// Park the run HERE: every tool result of the previous step is already in `messages` and no call
	// is pending, so the transcript is a legal resume point by construction. The transcript is also
	// placeholder-clean (ingress redaction), so it persists as-is — pre- and post-park transcripts
	// are byte-identical.
	const parkHere = async (
		step: number,
		reason: RunParkReason | "deadline",
	): Promise<AiSdkLoopResult> => {
		if (!input.persistYieldCheckpoint) {
			throw configurationError(
				reason === "deadline"
					? "deadline yields require a run checkpoint persister"
					: "suspending a run requires a run checkpoint persister",
			);
		}
		const checkpointId = await input.persistYieldCheckpoint({
			nextStep: step,
			messages,
		});
		// The two differ in ONE thing, and it is the thing the worker branches on: a yield leaves a
		// continuation behind, a park does not. Same checkpoint, same transcript, different answer to
		// "does this run come back on its own?".
		return reason === "deadline"
			? {
					status: "yielded",
					text: "",
					steps: step,
					checkpointId,
					usage: runUsage,
				}
			: {
					status: "parked",
					text: "",
					steps: step,
					checkpointId,
					reason,
					usage: runUsage,
				};
	};

	for (let step = startStep; step < input.maxSteps; step++) {
		abortIfNeeded(input.abortSignal);

		// THE CONTROL POINT — one await, and only when a control seam was supplied.
		const requested = await input.controlPoint?.(step);
		if (requested) return parkHere(step, requested);

		// The deadline arm lives here too, so there is one park site rather than two. It requires
		// PROGRESS: without `step > startStep` a run resumed at its deadline parks again immediately at
		// the same step, forever, burning a task per round. The intent arm above has no such rule on
		// purpose — "stop before you start" is exactly what a suspend must be able to say.
		if (
			input.deadlineAt !== undefined &&
			step > startStep &&
			input.now() >= input.deadlineAt
		) {
			return parkHere(step, "deadline");
		}

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
			if (!input.streaming) {
				// Projected onto the same PLAIN shape the streaming branch returns, so the convergence
				// below is literal. generateText resolves to a class INSTANCE, and the redactor walks
				// only plain objects/arrays (a class instance is passed through untouched by design) —
				// so without this projection the re-redaction below would silently no-op on the whole
				// generate path.
				const generated = await generateText(callParams);
				return {
					usage: generated.usage,
					finishReason: generated.finishReason,
					response: generated.response,
					toolCalls: generated.toolCalls,
					text: generated.text,
				};
			}
			const streamed = streamText(callParams);
			// The SAME redactor the final result gets — so the stream and the transcript agree, and a
			// value tokenized at rest is tokenized on the wire.
			const guard = createStreamGuard(
				input.redactValue
					? async (text) => String(await input.redactValue?.(text))
					: undefined,
			);
			for await (const delta of streamed.textStream) {
				const shown = await guard.push(delta);
				if (shown !== "") await input.onDelta?.(shown);
			}
			const tail = await guard.flush();
			if (tail !== "") await input.onDelta?.(tail);
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
		// Everything the loop persists downstream comes out of `res`: the transcript messages it pushes,
		// `res.text` on the durable assistant message, the tool args a checkpoint parks for an approval,
		// the yield checkpoint. A strict-mode model only ever SAW placeholders — but nothing stops it
		// EMITTING raw PII it holds from training or reassembles from fragments the ingress detector
		// missed, and a value with no mapping is one per-subject erasure can never reach. Redacted ONCE
		// here, where streaming and generate converge and ahead of the first consumer, instead of at
		// each persistence site (those are easy to add and easy to forget). Idempotent on the common
		// path: placeholders already in the output are skipped, not re-tokenized. Tool args are
		// rehydrated at the tool edge, so execution still sees the real value — only what lands at rest
		// is tokenized.
		res = await redact(input, res);
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
				"busyclaw runtime currently supports one tool call per model step",
				{ toolCallCount: res.toolCalls.length },
			);
		}

		// The transcript is placeholder-clean by construction (ingress redaction) — snapshot, don't
		// re-redact: re-minting per step is what used to break coreference and prompt caching.
		input.state.currentMessages = [...messages];
		const toolMessages: ModelMessage[] = [];
		for (const toolCall of res.toolCalls) {
			abortIfNeeded(input.abortSignal);
			// THE INGRESS. What arrives is a WIRE encoding: the flattened projection of a path (providers
			// reject dots), or an `busyclaw__execute` envelope naming a discoverable tool. Resolve it to
			// the canonical path and the target's own args ONCE, here, and nothing downstream has to
			// know either encoding existed: the floor decides on this id, dispatch looks it up, the
			// audit and the transcript record it, an approval parks under it. That is also what stops
			// `execute` from becoming the thing governance decides on — there is no path through this
			// loop on which a routed call is dispatched as anything but its target.
			// The wire name survives exactly where the wire needs it — the tool RESULT, which must come
			// back correlated the way the provider sent it (some providers match a result by NAME, not
			// only by call id), so `toolResultMessage` below keeps `toolCall.toolName` verbatim.
			const resolved = input.resolveToolCall
				? input.resolveToolCall({
						name: toolCall.toolName,
						input: toolCall.input,
					})
				: { path: toolCall.toolName, args: toolCall.input };
			const toolPath = resolved.path;
			// Model-authored args may contain NOVEL raw PII the model composed — still redacted here.
			const redactedToolInput = await redact(input, resolved.args);
			input.state.currentToolCallId = toolCall.toolCallId;
			input.state.currentToolPath = toolPath;
			input.state.currentToolWireName = toolCall.toolName;
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
				toolName: toolPath,
				type: "tool.called",
			});
			const toolStartedAt = Date.now();
			// Before the gate: a tool this run does not have is not a decision to make.
			if (input.knownToolPath && !input.knownToolPath(toolPath)) {
				throw stateError(`busyclaw: no executable tool "${toolPath}"`, {
					toolName: toolPath,
				});
			}
			let result: Awaited<ReturnType<Governance["handleToolCall"]>>;
			try {
				result = await input.core.handleToolCall(
					{ name: toolPath, args: redactedToolInput },
					input.ctx,
				);
			} catch (err) {
				const redactedError = await redact(input, errorEventPayload(err));
				await input.emitEvent?.({
					durationMs: Date.now() - toolStartedAt,
					error: redactedError,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolPath,
					type: "tool.failed",
				});
				throw err;
			}
			const toolDurationMs = Date.now() - toolStartedAt;
			if (result.status === "needs-approval") {
				if (!input.core.approvals) {
					throw configurationError(
						"runtime cannot wait for approval without a durable approval store",
						{ toolName: toolPath, toolCallId: toolCall.toolCallId },
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
							toolName: toolPath,
							toolCallId: toolCall.toolCallId,
							approvalIds: fallbackIds,
						},
					);
				}
				await input.emitEvent?.({
					approvalIds,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolPath,
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
					: governanceToolResult(result);
			if (result.status === "ok") {
				await input.emitEvent?.({
					durationMs: toolDurationMs,
					...(input.state.currentEffectId !== undefined
						? { effectId: input.state.currentEffectId }
						: {}),
					...(output !== undefined ? { output } : {}),
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolPath,
					type: "tool.completed",
				});
			} else if (result.status === "denied") {
				await input.emitEvent?.({
					reason: result.reason,
					reasonCode: result.reasonCode,
					step,
					toolCallId: toolCall.toolCallId,
					toolName: toolPath,
					type: "tool.denied",
				});
			}
			toolMessages.push(
				toolResultMessage(toolCall.toolCallId, toolCall.toolName, output),
			);
		}
		messages.push(...toolMessages);

		// The deadline check used to sit HERE, at end-of-step. It moved to the top of the loop: the two
		// are the same instant one `for` increment apart (the checkpoint's `nextStep` is N+1 either
		// way), and collapsing them buys one park site instead of two, coverage of the instant BEFORE
		// a step's model call, and one predicate that later intents extend without touching this file.
	}

	throw stateError(
		`busyclaw: maxSteps (${input.maxSteps}) exceeded before the agent reached a final answer`,
		{ maxSteps: input.maxSteps },
	);
}
