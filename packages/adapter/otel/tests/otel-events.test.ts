import type { RuntimeEvent } from "@euroclaw/runtime";
import {
	type Attributes,
	type AttributeValue,
	type Context,
	type Span,
	type SpanContext,
	type SpanOptions,
	type SpanStatus,
	SpanStatusCode,
	type TimeInput,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { otelEvents } from "../src/index";

let spanSeq = 0;

class FakeSpan implements Span {
	readonly name: string;
	readonly parent: FakeSpan | undefined;
	readonly startTime: TimeInput | undefined;
	readonly attributes: Attributes;
	status: SpanStatus | undefined;
	endTime: TimeInput | undefined;
	ended = false;
	private readonly selfContext: SpanContext;

	constructor(
		name: string,
		options: SpanOptions | undefined,
		parent: FakeSpan | undefined,
	) {
		this.name = name;
		this.parent = parent;
		this.startTime = options?.startTime;
		this.attributes = { ...(options?.attributes ?? {}) };
		spanSeq += 1;
		this.selfContext = {
			spanId: `span-${spanSeq}`,
			traceId:
				parent === undefined ? `trace-${spanSeq}` : parent.selfContext.traceId,
			traceFlags: 1,
		};
	}

	spanContext(): SpanContext {
		return this.selfContext;
	}
	setAttribute(key: string, value: AttributeValue): this {
		this.attributes[key] = value;
		return this;
	}
	setAttributes(attributes: Attributes): this {
		Object.assign(this.attributes, attributes);
		return this;
	}
	addEvent(): this {
		return this;
	}
	addLink(): this {
		return this;
	}
	addLinks(): this {
		return this;
	}
	setStatus(status: SpanStatus): this {
		this.status = status;
		return this;
	}
	updateName(): this {
		return this;
	}
	end(endTime?: TimeInput): void {
		this.ended = true;
		this.endTime = endTime;
	}
	isRecording(): boolean {
		return !this.ended;
	}
	recordException(): void {
		// the bridge never records exceptions
	}
}

class FakeTracer implements Tracer {
	readonly spans: FakeSpan[] = [];

	startSpan(name: string, options?: SpanOptions, context?: Context): Span {
		const parentSpan =
			context === undefined ? undefined : trace.getSpan(context);
		const parent = parentSpan instanceof FakeSpan ? parentSpan : undefined;
		const span = new FakeSpan(
			name,
			options,
			options?.root === true ? undefined : parent,
		);
		this.spans.push(span);
		return span;
	}

	startActiveSpan: Tracer["startActiveSpan"] = () => {
		throw new Error("otelEvents never uses startActiveSpan");
	};
}

function spanAt(tracer: FakeTracer, index: number): FakeSpan {
	const span = tracer.spans[index];
	if (span === undefined) throw new Error(`no span at index ${index}`);
	return span;
}

const T0 = Date.parse("2026-07-14T10:00:00.000Z");

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

let eventSeq = 0;

function base(runId: string, offsetMs: number) {
	eventSeq += 1;
	return {
		id: `evt-${eventSeq}`,
		createdAt: iso(offsetMs),
		runId,
		recording: { clawId: "claw-1", threadId: "thread-1", runId },
	};
}

describe("otelEvents", () => {
	it("maps a 2-step tool run to root + chat×2 + execute_tool with retrospective timing and terminal usage on the root", () => {
		const tracer = new FakeTracer();
		const sink = otelEvents({ tracer });
		const runId = "run-golden";

		sink.emit({
			...base(runId, 0),
			type: "run.started",
			prompt: "email alice",
		});
		sink.emit({
			...base(runId, 1000),
			type: "model.completed",
			step: 0,
			durationMs: 800,
			finishReason: "tool-calls",
			usage: { inputTokens: 11, outputTokens: 5 },
		});
		sink.emit({
			...base(runId, 1010),
			type: "tool.called",
			step: 0,
			toolCallId: "c1",
			toolName: "send_email",
			args: {},
		});
		sink.emit({
			...base(runId, 1050),
			type: "tool.completed",
			step: 0,
			toolCallId: "c1",
			toolName: "send_email",
			durationMs: 40,
		});
		sink.emit({
			...base(runId, 1800),
			type: "model.completed",
			step: 1,
			durationMs: 700,
			finishReason: "stop",
			usage: { inputTokens: 20, outputTokens: 7 },
		});
		sink.emit({
			...base(runId, 1810),
			type: "run.completed",
			steps: 2,
			text: "done",
			usage: { inputTokens: 31, outputTokens: 12 },
		});

		expect(tracer.spans.map((span) => span.name)).toEqual([
			"invoke_agent claw-1",
			"chat",
			"execute_tool send_email",
			"chat",
		]);
		const root = spanAt(tracer, 0);
		const chat1 = spanAt(tracer, 1);
		const tool = spanAt(tracer, 2);
		const chat2 = spanAt(tracer, 3);
		expect(root.parent).toBeUndefined();
		expect(root.startTime).toBe(T0);
		expect(root.endTime).toBe(T0 + 1810);
		expect(root.status).toEqual({ code: SpanStatusCode.OK });
		expect(root.attributes).toMatchObject({
			"gen_ai.operation.name": "invoke_agent",
			"euroclaw.run.id": runId,
			"euroclaw.claw.id": "claw-1",
			"gen_ai.conversation.id": "thread-1",
			"gen_ai.usage.input_tokens": 31,
			"gen_ai.usage.output_tokens": 12,
		});
		// Chat spans are retrospective children: start = event time − duration.
		expect(chat1.parent).toBe(root);
		expect(chat1.startTime).toBe(T0 + 1000 - 800);
		expect(chat1.endTime).toBe(T0 + 1000);
		expect(chat1.status).toBeUndefined();
		expect(chat1.attributes).toMatchObject({
			"gen_ai.operation.name": "chat",
			"euroclaw.step": 0,
			"gen_ai.response.finish_reasons": ["tool-calls"],
			"gen_ai.usage.input_tokens": 11,
			"gen_ai.usage.output_tokens": 5,
		});
		expect(chat2.parent).toBe(root);
		expect(chat2.startTime).toBe(T0 + 1800 - 700);
		expect(chat2.endTime).toBe(T0 + 1800);
		expect(tool.parent).toBe(root);
		expect(tool.startTime).toBe(T0 + 1010);
		expect(tool.endTime).toBe(T0 + 1050);
		expect(tool.status).toEqual({ code: SpanStatusCode.OK });
		expect(tool.attributes).toMatchObject({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "send_email",
			"gen_ai.tool.call.id": "c1",
			"euroclaw.step": 0,
		});
	});

	it("waiting_approval closes tool and root with outcome attributes; a continuation opens a NEW lazy root linked by run id", () => {
		const tracer = new FakeTracer();
		const sink = otelEvents({ tracer });
		const runId = "run-approval";

		sink.emit({ ...base(runId, 0), type: "run.started", prompt: "send it" });
		sink.emit({
			...base(runId, 90),
			type: "model.completed",
			step: 0,
			durationMs: 80,
			finishReason: "tool-calls",
			usage: { inputTokens: 3, outputTokens: 2 },
		});
		sink.emit({
			...base(runId, 100),
			type: "tool.called",
			step: 0,
			toolCallId: "c1",
			toolName: "send_email",
			args: {},
		});
		sink.emit({
			...base(runId, 150),
			type: "tool.waiting_approval",
			step: 0,
			toolCallId: "c1",
			toolName: "send_email",
			approvalIds: ["ap-1"],
		});
		sink.emit({
			...base(runId, 160),
			type: "run.waiting_approval",
			steps: 1,
			text: "",
			approvalIds: ["ap-1"],
			usage: { inputTokens: 3, outputTokens: 2 },
		});

		const firstRoot = spanAt(tracer, 0);
		const tool = spanAt(tracer, 2);
		expect(tool.ended).toBe(true);
		expect(tool.endTime).toBe(T0 + 150);
		expect(tool.status).toEqual({ code: SpanStatusCode.OK });
		expect(tool.attributes).toMatchObject({
			"euroclaw.tool.outcome": "waiting_approval",
		});
		expect(firstRoot.ended).toBe(true);
		expect(firstRoot.endTime).toBe(T0 + 160);
		expect(firstRoot.status).toEqual({ code: SpanStatusCode.OK });
		expect(firstRoot.attributes).toMatchObject({
			"euroclaw.run.outcome": "waiting_approval",
			"gen_ai.usage.input_tokens": 3,
			"gen_ai.usage.output_tokens": 2,
		});

		// The approved continuation re-emits under the SAME runId but never a run.started:
		// a new root opens lazily and the resumed tool result becomes a retrospective child.
		const DAY = 86_400_000;
		sink.emit({
			...base(runId, DAY),
			type: "tool.completed",
			step: 0,
			toolCallId: "c1",
			toolName: "send_email",
			durationMs: 5000,
		});
		sink.emit({
			...base(runId, DAY + 10),
			type: "run.completed",
			steps: 1,
			text: "done",
			usage: { inputTokens: 4, outputTokens: 1 },
		});

		expect(tracer.spans).toHaveLength(5);
		const secondRoot = spanAt(tracer, 3);
		const resumedTool = spanAt(tracer, 4);
		expect(secondRoot.name).toBe("invoke_agent claw-1");
		expect(secondRoot).not.toBe(firstRoot);
		expect(secondRoot.startTime).toBe(T0 + DAY);
		expect(secondRoot.endTime).toBe(T0 + DAY + 10);
		// Both traces carry the same run id — the cross-trace link.
		expect(firstRoot.attributes["euroclaw.run.id"]).toBe(runId);
		expect(secondRoot.attributes["euroclaw.run.id"]).toBe(runId);
		expect(secondRoot.attributes).toMatchObject({
			"gen_ai.usage.input_tokens": 4,
			"gen_ai.usage.output_tokens": 1,
		});
		expect(resumedTool.name).toBe("execute_tool send_email");
		expect(resumedTool.parent).toBe(secondRoot);
		expect(resumedTool.startTime).toBe(T0 + DAY - 5000);
		expect(resumedTool.endTime).toBe(T0 + DAY);
		expect(resumedTool.status).toEqual({ code: SpanStatusCode.OK });
	});

	it("model.failed records an ERROR chat span, fails the root, ends open tool spans, and drops run state", () => {
		const tracer = new FakeTracer();
		const sink = otelEvents({ tracer });
		const runId = "run-fail";

		sink.emit({ ...base(runId, 0), type: "run.started", prompt: "boom" });
		sink.emit({
			...base(runId, 10),
			type: "tool.called",
			step: 0,
			toolCallId: "c1",
			toolName: "send_email",
			args: {},
		});
		sink.emit({
			...base(runId, 500),
			type: "model.failed",
			step: 1,
			durationMs: 300,
			error: { message: "model exploded", name: "TypeError" },
		});

		const root = spanAt(tracer, 0);
		const tool = spanAt(tracer, 1);
		const chat = spanAt(tracer, 2);
		expect(chat.parent).toBe(root);
		expect(chat.startTime).toBe(T0 + 500 - 300);
		expect(chat.endTime).toBe(T0 + 500);
		expect(chat.status).toEqual({
			code: SpanStatusCode.ERROR,
			message: "model exploded",
		});
		expect(chat.attributes).toMatchObject({
			"error.type": "TypeError",
			"euroclaw.step": 1,
		});
		// The run dies without a terminal event (model.failed rethrows) — everything closes NOW.
		expect(tool.ended).toBe(true);
		expect(tool.endTime).toBe(T0 + 500);
		expect(tool.status).toEqual({ code: SpanStatusCode.ERROR });
		expect(root.ended).toBe(true);
		expect(root.status).toEqual({
			code: SpanStatusCode.ERROR,
			message: "model exploded",
		});
		// State dropped: the next event under this runId opens a fresh root.
		sink.emit({ ...base(runId, 600), type: "run.started", prompt: "retry" });
		expect(tracer.spans).toHaveLength(4);
		expect(spanAt(tracer, 3).name).toBe("invoke_agent claw-1");
		expect(spanAt(tracer, 3)).not.toBe(root);
	});

	it("run.denied ends the root OK with outcome=denied and reason_code — a governed no is not an infra error", () => {
		const tracer = new FakeTracer();
		const sink = otelEvents({ tracer });
		const runId = "run-denied";

		sink.emit({
			...base(runId, 0),
			type: "run.started",
			prompt: "do the thing",
		});
		sink.emit({
			...base(runId, 20),
			type: "run.denied",
			steps: 1,
			text: "",
			approvalId: "ap-1",
			decidedBy: "user:reviewer",
			reasonCode: "approval.denied",
		});

		const root = spanAt(tracer, 0);
		expect(root.ended).toBe(true);
		expect(root.endTime).toBe(T0 + 20);
		expect(root.status).toEqual({ code: SpanStatusCode.OK });
		expect(root.attributes).toMatchObject({
			"euroclaw.run.outcome": "denied",
			"euroclaw.reason_code": "approval.denied",
		});
	});

	it("an unknown event kind is a no-op — no spans, no throw", () => {
		const tracer = new FakeTracer();
		const sink = otelEvents({ tracer });
		// The plugin emit door forwards base events into RuntimeEvent sinks unvalidated (the
		// documented cast seam in runtime's pluginEventSink) — reproduce that widening here.
		const doorEvent: {
			type: string;
			id?: string;
			createdAt?: string;
			runId?: string;
		} = {
			id: "evt-door",
			createdAt: iso(0),
			runId: "run-unknown",
			type: "skill.loaded",
		};

		expect(() => sink.emit(doorEvent as RuntimeEvent)).not.toThrow();
		expect(tracer.spans).toHaveLength(0);
	});
});
