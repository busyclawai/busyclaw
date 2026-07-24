import {
	type Event,
	type EventSink,
	errorMessage,
	jsonObject,
	jsonValue,
	RESERVED_CONTEXT_PREFIX,
	type Redactor,
	validationError,
} from "@euroclaw/contracts";
import { type as ark } from "arktype";

export const RUNTIME_RECORDING_CONTEXT_KEY = `${RESERVED_CONTEXT_PREFIX}recording`;
export const RUNTIME_RECORDING_OPTION: unique symbol = Symbol(
	"euroclaw.runtime.recording",
);

export const runtimeRecordingContext = ark({
	clawId: "string",
	threadId: "string",
	"runId?": "string | undefined",
	"userMessageId?": "string | undefined",
});
export type RuntimeRecordingContext = typeof runtimeRecordingContext.infer;

const runtimeEventBaseShape = {
	id: "string",
	createdAt: "string",
	"runId?": "string | undefined",
	"recording?": runtimeRecordingContext.or("undefined"),
} as const;

// One error shape for every *.failed event. `reasonCode` is present exactly when the outcome is a
// governed decision (a gate said no) — its absence means infrastructure broke.
export const runtimeEventError = ark({
	message: "string",
	"name?": "string | undefined",
	"reasonCode?": "string | undefined",
});
export type RuntimeEventError = typeof runtimeEventError.infer;

// Mirrors the numeric fields of ai@7.0.22's `LanguageModelUsage` (generateText's result usage),
// all optional — providers vary. Its non-numeric `raw` provider payload is deliberately dropped.
export const runtimeModelUsage = ark({
	"inputTokens?": "number | undefined",
	"inputTokenDetails?": ark({
		"noCacheTokens?": "number | undefined",
		"cacheReadTokens?": "number | undefined",
		"cacheWriteTokens?": "number | undefined",
	}).or("undefined"),
	"outputTokens?": "number | undefined",
	"outputTokenDetails?": ark({
		"textTokens?": "number | undefined",
		"reasoningTokens?": "number | undefined",
	}).or("undefined"),
	"totalTokens?": "number | undefined",
});
export type RuntimeModelUsage = typeof runtimeModelUsage.infer;

export const runStartedEvent = ark({
	...runtimeEventBaseShape,
	type: "'run.started'",
	prompt: "string",
});

// Terminal `usage` is the field-wise sum across the model calls of THIS runtime invocation only —
// a continuation's terminal event covers post-resume steps, never the whole logical run.
export const runCompletedEvent = ark({
	...runtimeEventBaseShape,
	type: "'run.completed'",
	text: "string",
	steps: "number",
	"usage?": runtimeModelUsage.or("undefined"),
});

export const runWaitingApprovalEvent = ark({
	...runtimeEventBaseShape,
	type: "'run.waiting_approval'",
	text: "string",
	steps: "number",
	"approvalIds?": ark("string").array().or("undefined"),
	"usage?": runtimeModelUsage.or("undefined"),
});

export const runYieldedEvent = ark({
	...runtimeEventBaseShape,
	type: "'run.yielded'",
	steps: "number",
	checkpointId: "string",
	"usage?": runtimeModelUsage.or("undefined"),
});

export const runDeniedEvent = ark({
	...runtimeEventBaseShape,
	type: "'run.denied'",
	text: "string",
	steps: "number",
	approvalId: "string",
	"decidedBy?": "string | undefined",
	"reasonCode?": "string | undefined",
});

export const toolCalledEvent = ark({
	...runtimeEventBaseShape,
	type: "'tool.called'",
	step: "number",
	toolCallId: "string",
	toolName: "string",
	args: jsonObject,
});

export const toolCompletedEvent = ark({
	...runtimeEventBaseShape,
	type: "'tool.completed'",
	step: "number",
	toolCallId: "string",
	toolName: "string",
	"durationMs?": "number | undefined",
	"effectId?": "string | undefined",
	"output?": jsonValue.or("undefined"),
});

export const toolWaitingApprovalEvent = ark({
	...runtimeEventBaseShape,
	type: "'tool.waiting_approval'",
	step: "number",
	toolCallId: "string",
	toolName: "string",
	approvalIds: ark("string").array(),
});

export const toolDeniedEvent = ark({
	...runtimeEventBaseShape,
	type: "'tool.denied'",
	step: "number",
	toolCallId: "string",
	toolName: "string",
	reason: "string",
	"decidedBy?": "string | undefined",
	"reasonCode?": "string | undefined",
});

export const toolFailedEvent = ark({
	...runtimeEventBaseShape,
	type: "'tool.failed'",
	step: "number",
	toolCallId: "string",
	toolName: "string",
	"durationMs?": "number | undefined",
	error: runtimeEventError,
});

export const modelCompletedEvent = ark({
	...runtimeEventBaseShape,
	type: "'model.completed'",
	step: "number",
	durationMs: "number",
	usage: runtimeModelUsage,
	// The AI SDK's unified finish reason (result `finishReason`, not the provider-raw variant).
	finishReason: "string",
});

export const modelFailedEvent = ark({
	...runtimeEventBaseShape,
	type: "'model.failed'",
	step: "number",
	durationMs: "number",
	error: runtimeEventError,
});

// The operational catalog. Correlation spine: `runId` on every event, plus clawId/threadId via
// `recording` when the api layer runs the turn — the one id set that ties events, claws rows, and
// spans together. engine-sql's `run_event` table deliberately shares kind NAMES (`run.started`, …)
// but is durable execution state with engine payloads (taskId/workerId), written transactionally
// with status flips — same names, different plane; never unify the two.
export const runtimeEvent = runStartedEvent
	.or(runCompletedEvent)
	.or(runWaitingApprovalEvent)
	.or(runYieldedEvent)
	.or(runDeniedEvent)
	.or(toolCalledEvent)
	.or(toolCompletedEvent)
	.or(toolWaitingApprovalEvent)
	.or(toolDeniedEvent)
	.or(toolFailedEvent)
	.or(modelCompletedEvent)
	.or(modelFailedEvent);

export type RuntimeEvent = typeof runtimeEvent.infer;

export type RuntimeEventBase = Pick<
	RuntimeEvent,
	"createdAt" | "id" | "recording" | "runId"
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, Extract<keyof T, K>>
	: never;

export type RuntimeEventPayload = DistributiveOmit<
	RuntimeEvent,
	"createdAt" | "id" | "recording" | "runId"
>;

export type RuntimeEventPayloadInput = { type: RuntimeEvent["type"] } & Record<
	string,
	unknown
>;

// The runtime's event sink is the core `EventSink` port specialised to the concrete RuntimeEvent
// union — `RuntimeEvent` carries `type: string`, so it satisfies the base `event` shape core owns.
export type RuntimeEventSink = EventSink<RuntimeEvent>;

export function createRuntimeEvent(input: {
	createdAt: string;
	id: string;
	payload: RuntimeEventPayloadInput;
	recording?: RuntimeRecordingContext;
	runId?: string;
}): RuntimeEvent {
	const candidate = {
		createdAt: input.createdAt,
		id: input.id,
		recording: input.recording,
		runId: input.runId ?? input.recording?.runId,
		...input.payload,
	};
	const valid = runtimeEvent(candidate);
	if (valid instanceof ark.errors) {
		throw validationError("runtime event invalid", valid.summary);
	}
	return valid;
}

export function eventSinksFrom(
	input: RuntimeEventSink | readonly RuntimeEventSink[] | undefined,
): readonly RuntimeEventSink[] {
	if (!input) return [];
	return "emit" in input ? [input] : input;
}

export function runtimeRecordingContextFrom(
	ctx: Record<string, unknown> | undefined,
): RuntimeRecordingContext | undefined {
	const value = ctx?.[RUNTIME_RECORDING_CONTEXT_KEY];
	if (value === undefined) return undefined;
	const valid = runtimeRecordingContext(value);
	if (valid instanceof ark.errors) {
		throw validationError("runtime recording context invalid", valid.summary);
	}
	return valid;
}

/**
 * The runtime's event fan-out, split by what a sink failure means: the (at most one) `recording`
 * sink is load-bearing — it persists the transcript, so it is awaited first and its failures
 * PROPAGATE (a run that cannot record must fail). Every `observers` sink is telemetry — awaited
 * sequentially for deterministic ordering, but isolated: a throw is swallowed and reported via
 * `warn` (default `console.warn`), never propagated into the run.
 */
export type RuntimeEventFanout = {
	recording?: RuntimeEventSink;
	observers: readonly RuntimeEventSink[];
	warn?: (message: string) => void;
};

async function fanoutRuntimeEvent(
	fanout: RuntimeEventFanout,
	event: RuntimeEvent,
): Promise<void> {
	if (fanout.recording) await fanout.recording.emit(event);
	for (const sink of fanout.observers) {
		try {
			await sink.emit(event);
		} catch (err) {
			const warn = fanout.warn ?? ((message: string) => console.warn(message));
			warn(
				`euroclaw runtime: observer event sink failed on "${event.type}" — ${errorMessage(err)}`,
			);
		}
	}
}

/**
 * Door redaction: under a redacted posture, a door event's plugin-authored payload is tokenized
 * BEFORE fan-out, so no sink ever holds raw PII. The assembly passes this only when redaction is
 * ARMED (a detector or custom redactor exists) — the no-redaction recipe and posture "raw" hand
 * the door nothing, and that path stays byte-identical (the payload is never even walked).
 */
export type PluginEventRedaction = {
	/** The deployment's ONE resolved redactor, per-claw routing included — a raw-posture claw's
	 *  door events pass through by the same decision its transcript writes do. */
	redactor: Redactor;
	/** The emitting plugin's id: a claw-less event (boot/cron/webhook — no `recording`) redacts
	 *  into the ("plugin", <id>) container, mirroring the ("claw", <clawId>) transcript container. */
	plugin: string;
};

// The runtime-owned envelope; every other key on a door event is plugin-authored payload.
const DOOR_ENVELOPE_KEYS = new Set([
	"createdAt",
	"id",
	"recording",
	"runId",
	"type",
]);

async function redactDoorEvent(
	event: Event,
	redaction: PluginEventRedaction,
): Promise<Event> {
	const envelope: Record<string, unknown> = {};
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(event)) {
		if (DOOR_ENVELOPE_KEYS.has(key)) envelope[key] = value;
		else payload[key] = value;
	}
	// A well-formed recording attributes the event to a claw → its container, shared with the
	// transcript. Anything else is claw-less and fails CLOSED into the per-plugin container
	// (under per-claw routing, a non-claw scope resolves to the configured default posture).
	const recording = runtimeRecordingContext(
		(event as { recording?: unknown }).recording,
	);
	const ctx =
		recording instanceof ark.errors
			? { scope: "plugin", scopeId: redaction.plugin }
			: { scope: "claw", scopeId: recording.clawId };
	const redacted = await redaction.redactor.redactValue(payload, ctx);
	// Envelope last: it stays verbatim no matter what a custom redactor returned.
	return { ...redacted, ...envelope } as Event;
}

/**
 * Adapt the runtime's operational event fan-out to the neutral `EventSink` port handed to plugins
 * via `EuroclawPluginConfigureContext.events`. Plugin-emitted events ride the SAME pipeline as
 * runtime events (recording first, then isolated observers); each sink reads `type` and ignores
 * events it doesn't recognise (e.g. the durable sink early-returns), so a plugin event simply
 * lands wherever a sink knows what to do with it. With `redaction` present the payload is
 * tokenized before fan-out (see {@link PluginEventRedaction}); the runtime's own kinds never pass
 * through here — they are redacted at their source boundaries (`emitRuntimeEvent` is untouched).
 * The cast is the documented seam: plugin events are base `event`s today and become part of the
 * `RuntimeEvent` union as concrete schemas (skill.*, channel.*) are added in later tasks.
 */
export function pluginEventSink(
	fanout: RuntimeEventFanout,
	redaction?: PluginEventRedaction,
): EventSink {
	return {
		async emit(event) {
			const out = redaction ? await redactDoorEvent(event, redaction) : event;
			await fanoutRuntimeEvent(fanout, out as RuntimeEvent);
		},
	};
}

export async function emitRuntimeEvent(
	fanout: RuntimeEventFanout,
	event: RuntimeEvent,
): Promise<void> {
	const valid = runtimeEvent(event);
	if (valid instanceof ark.errors) {
		throw validationError("runtime event invalid", valid.summary);
	}
	await fanoutRuntimeEvent(fanout, valid);
}
