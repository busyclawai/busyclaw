import type {
	RuntimeEvent,
	RuntimeEventSink,
	RuntimeModelUsage,
} from "@euroclaw/runtime";

/**
 * Zero-dependency pretty dev sink: one compact line per operational event — the kind, then
 * greppable `key=value` pairs for ids/counters (absent fields are omitted). Wire it as
 * `createClaw({ events: logEvents() })`; `log` is injectable purely for tests and defaults
 * to `console.log`.
 */
export function logEvents(options?: {
	log?: (line: string) => void;
}): RuntimeEventSink {
	const log = options?.log ?? ((line: string) => console.log(line));
	return {
		emit(event) {
			// Never throws: the plugin emit door forwards base events unvalidated, so an event may
			// wear a known `type` without its shape — a defect here degrades to a dropped line.
			try {
				log(lineFor(event));
			} catch {
				// a dev log sink must never reach into the run
			}
		},
	};
}

function lineFor(event: RuntimeEvent): string {
	const known = knownLineFor(event);
	if (known !== undefined) return known;
	// Plugin-emitted events land here: their only guaranteed field is `type`.
	const base: { type: string; runId?: string | undefined } = event;
	return join([base.type, runPart(base.runId)]);
}

function knownLineFor(event: RuntimeEvent): string | undefined {
	switch (event.type) {
		case "run.started":
			return join([event.type, runPart(event.runId)]);
		case "run.completed":
			return join([
				event.type,
				runPart(event.runId),
				`steps=${event.steps}`,
				tokensPart(event.usage),
			]);
		case "run.waiting_approval":
			return join([
				event.type,
				runPart(event.runId),
				`steps=${event.steps}`,
				approvalsPart(event.approvalIds),
				tokensPart(event.usage),
			]);
		case "run.yielded":
			return join([
				event.type,
				runPart(event.runId),
				`steps=${event.steps}`,
				`checkpoint=${event.checkpointId}`,
				tokensPart(event.usage),
			]);
		case "run.denied":
			return join([
				event.type,
				runPart(event.runId),
				`steps=${event.steps}`,
				reasonPart(event.reasonCode, undefined),
			]);
		case "tool.called":
			return join([
				event.type,
				runPart(event.runId),
				`step=${event.step}`,
				event.toolName,
			]);
		case "tool.completed":
			return join([
				event.type,
				runPart(event.runId),
				`step=${event.step}`,
				event.toolName,
				durationPart(event.durationMs),
			]);
		case "tool.waiting_approval":
			return join([
				event.type,
				runPart(event.runId),
				`step=${event.step}`,
				event.toolName,
				approvalsPart(event.approvalIds),
			]);
		case "tool.denied":
			return join([
				event.type,
				runPart(event.runId),
				`step=${event.step}`,
				event.toolName,
				reasonPart(event.reasonCode, event.reason),
			]);
		case "tool.failed":
			return join([
				event.type,
				runPart(event.runId),
				`step=${event.step}`,
				event.toolName,
				durationPart(event.durationMs),
				event.error.message,
			]);
		case "model.completed":
			return join([
				event.type,
				runPart(event.runId),
				`step=${event.step}`,
				durationPart(event.durationMs),
				event.finishReason,
				tokensPart(event.usage),
			]);
		case "model.failed":
			return join([
				event.type,
				runPart(event.runId),
				`step=${event.step}`,
				durationPart(event.durationMs),
				event.error.message,
			]);
		default:
			return undefined;
	}
}

function join(parts: readonly (string | undefined)[]): string {
	return parts
		.filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		)
		.join(" ");
}

function runPart(runId: string | undefined): string | undefined {
	if (typeof runId !== "string" || runId.length === 0) return undefined;
	return `run=${runId.slice(0, 8)}`;
}

function tokensPart(usage: RuntimeModelUsage | undefined): string | undefined {
	const input = usage?.inputTokens;
	const output = usage?.outputTokens;
	if (typeof input !== "number" && typeof output !== "number") return undefined;
	return `tokens=${typeof input === "number" ? input : "-"}/${typeof output === "number" ? output : "-"}`;
}

function approvalsPart(
	approvalIds: readonly string[] | undefined,
): string | undefined {
	if (approvalIds === undefined) return undefined;
	return `approvals=${approvalIds.length}`;
}

function durationPart(durationMs: number | undefined): string | undefined {
	if (typeof durationMs !== "number") return undefined;
	return `${durationMs}ms`;
}

function reasonPart(
	reasonCode: string | undefined,
	reason: string | undefined,
): string | undefined {
	const value = reasonCode ?? reason;
	if (value === undefined) return undefined;
	return `reason=${value}`;
}
