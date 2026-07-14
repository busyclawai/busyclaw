import type {
	RuntimeEvent,
	RuntimeEventSink,
	RuntimeModelUsage,
} from "@euroclaw/runtime";
import {
	type Attributes,
	ROOT_CONTEXT,
	type Span,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import {
	ATTR_ERROR_TYPE,
	ATTR_EUROCLAW_CHECKPOINT_ID,
	ATTR_EUROCLAW_CLAW_ID,
	ATTR_EUROCLAW_REASON_CODE,
	ATTR_EUROCLAW_RUN_ID,
	ATTR_EUROCLAW_RUN_OUTCOME,
	ATTR_EUROCLAW_STEP,
	ATTR_EUROCLAW_TOOL_OUTCOME,
	ATTR_GEN_AI_CONVERSATION_ID,
	ATTR_GEN_AI_OPERATION_NAME,
	ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
	ATTR_GEN_AI_TOOL_CALL_ID,
	ATTR_GEN_AI_TOOL_NAME,
	ATTR_GEN_AI_USAGE_INPUT_TOKENS,
	ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from "./attrs";

export type OtelEventsOptions = {
	/** Required — the host owns provider/exporter setup; there is no global-tracer fallback. */
	tracer: Tracer;
};

type RunSpans = {
	root: Span;
	/** Open `execute_tool` spans keyed by toolCallId. */
	tools: Map<string, Span>;
};

type ToolIdentity = { toolCallId: string; toolName: string; step: number };

/**
 * An observer sink mapping the operational event stream onto OTel spans: one `invoke_agent`
 * root span per runId (opened on `run.started`, or lazily on the first event of an unknown
 * runId — a continuation gets a NEW root span; `euroclaw.run.id` is the cross-trace link),
 * a retrospective `chat` child per model call, an `execute_tool` child per tool call.
 * Span times come from each event's `createdAt` (durations subtracted for retrospective
 * children), so traces are deterministic and independent of delivery latency.
 */
export function otelEvents(options: OtelEventsOptions): RuntimeEventSink {
	const tracer = options.tracer;
	const runs = new Map<string, RunSpans>();

	function ensureRun(
		runId: string,
		event: RuntimeEvent,
		timeMs: number,
	): RunSpans {
		const existing = runs.get(runId);
		if (existing !== undefined) return existing;
		const recording = event.recording;
		const attributes: Attributes = {
			[ATTR_GEN_AI_OPERATION_NAME]: "invoke_agent",
			[ATTR_EUROCLAW_RUN_ID]: runId,
		};
		if (recording !== undefined) {
			attributes[ATTR_EUROCLAW_CLAW_ID] = recording.clawId;
			attributes[ATTR_GEN_AI_CONVERSATION_ID] = recording.threadId;
		}
		const root = tracer.startSpan(
			recording === undefined
				? "invoke_agent"
				: `invoke_agent ${recording.clawId}`,
			{ attributes, root: true, startTime: timeMs },
			ROOT_CONTEXT,
		);
		const state: RunSpans = { root, tools: new Map() };
		runs.set(runId, state);
		return state;
	}

	function childContext(state: RunSpans) {
		return trace.setSpan(ROOT_CONTEXT, state.root);
	}

	function toolAttributes(tool: ToolIdentity): Attributes {
		return {
			[ATTR_GEN_AI_OPERATION_NAME]: "execute_tool",
			[ATTR_GEN_AI_TOOL_NAME]: tool.toolName,
			[ATTR_GEN_AI_TOOL_CALL_ID]: tool.toolCallId,
			[ATTR_EUROCLAW_STEP]: tool.step,
		};
	}

	/** The open span for this toolCallId, or — approval-resume path: the continuation trace
	 *  never saw `tool.called` — a retrospective span started at `startTimeMs`. */
	function takeToolSpan(
		state: RunSpans,
		tool: ToolIdentity,
		startTimeMs: number,
	): Span {
		const open = state.tools.get(tool.toolCallId);
		if (open !== undefined) {
			state.tools.delete(tool.toolCallId);
			return open;
		}
		return tracer.startSpan(
			`execute_tool ${tool.toolName}`,
			{ attributes: toolAttributes(tool), startTime: startTimeMs },
			childContext(state),
		);
	}

	function usageAttributes(usage: RuntimeModelUsage | undefined): Attributes {
		const attributes: Attributes = {};
		if (typeof usage?.inputTokens === "number") {
			attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS] = usage.inputTokens;
		}
		if (typeof usage?.outputTokens === "number") {
			attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = usage.outputTokens;
		}
		return attributes;
	}

	/** Terminal close: a governed outcome (waiting_approval / yielded / denied) is not an
	 *  infra error, so the root always ends OK with the outcome as an attribute. */
	function endRun(
		runId: string,
		state: RunSpans,
		timeMs: number,
		attributes: Attributes,
	): void {
		// Leak-prevention only — a tool span still open at a terminal event is a defect upstream.
		for (const span of state.tools.values()) {
			span.end(timeMs);
		}
		state.root.setAttributes(attributes);
		state.root.setStatus({ code: SpanStatusCode.OK });
		state.root.end(timeMs);
		runs.delete(runId);
	}

	/** `model.failed`/`tool.failed` rethrow — the run dies without a terminal event, so the
	 *  root (and any still-open tool span) must close HERE or it leaks open forever. */
	function failRun(
		runId: string,
		state: RunSpans,
		timeMs: number,
		message: string,
	): void {
		for (const span of state.tools.values()) {
			span.setStatus({ code: SpanStatusCode.ERROR });
			span.end(timeMs);
		}
		state.root.setStatus({ code: SpanStatusCode.ERROR, message });
		state.root.end(timeMs);
		runs.delete(runId);
	}

	function handle(event: RuntimeEvent): void {
		const runId = event.runId;
		if (typeof runId !== "string" || runId.length === 0) return;
		const parsed = Date.parse(event.createdAt);
		const timeMs = Number.isFinite(parsed) ? parsed : Date.now();
		switch (event.type) {
			case "run.started": {
				ensureRun(runId, event, timeMs);
				return;
			}
			case "run.completed": {
				const state = ensureRun(runId, event, timeMs);
				endRun(runId, state, timeMs, usageAttributes(event.usage));
				return;
			}
			case "run.waiting_approval": {
				const state = ensureRun(runId, event, timeMs);
				endRun(runId, state, timeMs, {
					...usageAttributes(event.usage),
					[ATTR_EUROCLAW_RUN_OUTCOME]: "waiting_approval",
				});
				return;
			}
			case "run.yielded": {
				const state = ensureRun(runId, event, timeMs);
				endRun(runId, state, timeMs, {
					...usageAttributes(event.usage),
					[ATTR_EUROCLAW_RUN_OUTCOME]: "yielded",
					[ATTR_EUROCLAW_CHECKPOINT_ID]: event.checkpointId,
				});
				return;
			}
			case "run.denied": {
				const state = ensureRun(runId, event, timeMs);
				const attributes: Attributes = {
					[ATTR_EUROCLAW_RUN_OUTCOME]: "denied",
				};
				if (event.reasonCode !== undefined) {
					attributes[ATTR_EUROCLAW_REASON_CODE] = event.reasonCode;
				}
				endRun(runId, state, timeMs, attributes);
				return;
			}
			case "tool.called": {
				const state = ensureRun(runId, event, timeMs);
				const span = tracer.startSpan(
					`execute_tool ${event.toolName}`,
					{ attributes: toolAttributes(event), startTime: timeMs },
					childContext(state),
				);
				state.tools.set(event.toolCallId, span);
				return;
			}
			case "tool.completed": {
				const state = ensureRun(runId, event, timeMs);
				const span = takeToolSpan(
					state,
					event,
					timeMs - (event.durationMs ?? 0),
				);
				span.setStatus({ code: SpanStatusCode.OK });
				span.end(timeMs);
				return;
			}
			case "tool.waiting_approval": {
				const state = ensureRun(runId, event, timeMs);
				const open = state.tools.get(event.toolCallId);
				if (open === undefined) return;
				state.tools.delete(event.toolCallId);
				// Approvals can take days — a span cannot stay open; the outcome says why it closed.
				open.setAttribute(ATTR_EUROCLAW_TOOL_OUTCOME, "waiting_approval");
				open.setStatus({ code: SpanStatusCode.OK });
				open.end(timeMs);
				return;
			}
			case "tool.denied": {
				const state = ensureRun(runId, event, timeMs);
				const span = takeToolSpan(state, event, timeMs);
				if (event.reasonCode !== undefined) {
					span.setAttribute(ATTR_EUROCLAW_REASON_CODE, event.reasonCode);
				}
				span.setStatus({ code: SpanStatusCode.ERROR, message: event.reason });
				span.end(timeMs);
				return;
			}
			case "tool.failed": {
				const state = ensureRun(runId, event, timeMs);
				const span = takeToolSpan(
					state,
					event,
					timeMs - (event.durationMs ?? 0),
				);
				if (event.error.name !== undefined) {
					span.setAttribute(ATTR_ERROR_TYPE, event.error.name);
				}
				if (event.error.reasonCode !== undefined) {
					span.setAttribute(ATTR_EUROCLAW_REASON_CODE, event.error.reasonCode);
				}
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: event.error.message,
				});
				span.end(timeMs);
				failRun(runId, state, timeMs, event.error.message);
				return;
			}
			case "model.completed": {
				const state = ensureRun(runId, event, timeMs);
				const span = tracer.startSpan(
					"chat",
					{
						attributes: {
							[ATTR_GEN_AI_OPERATION_NAME]: "chat",
							[ATTR_EUROCLAW_STEP]: event.step,
							[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [event.finishReason],
							...usageAttributes(event.usage),
						},
						startTime: timeMs - event.durationMs,
					},
					childContext(state),
				);
				span.end(timeMs);
				return;
			}
			case "model.failed": {
				const state = ensureRun(runId, event, timeMs);
				const span = tracer.startSpan(
					"chat",
					{
						attributes: {
							[ATTR_GEN_AI_OPERATION_NAME]: "chat",
							[ATTR_EUROCLAW_STEP]: event.step,
						},
						startTime: timeMs - event.durationMs,
					},
					childContext(state),
				);
				if (event.error.name !== undefined) {
					span.setAttribute(ATTR_ERROR_TYPE, event.error.name);
				}
				if (event.error.reasonCode !== undefined) {
					span.setAttribute(ATTR_EUROCLAW_REASON_CODE, event.error.reasonCode);
				}
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: event.error.message,
				});
				span.end(timeMs);
				failRun(runId, state, timeMs, event.error.message);
				return;
			}
			default:
				// Unknown/future kinds (plugin-emitted base events) are a no-op.
				return;
		}
	}

	return {
		emit(event) {
			// An observer must never reach into the run — don't rely on the fan-out's isolation:
			// an internal defect degrades to a no-op for that event.
			try {
				handle(event);
			} catch {
				// no-op by contract
			}
		},
	};
}
