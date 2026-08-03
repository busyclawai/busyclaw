/**
 * The engine protocol — what a durable execution engine IS: the engine-neutral handle
 * (start/continue/optional work), the factory composed by `createClaw`, the run read-model, and
 * the bounded `drainWork` helper cron hosts pump with. Implementations live in `@busyclaw/engine-*`
 * (engine-sql today; a managed-workflow engine implements the same verbs and omits `work`).
 */

import { configurationError } from "@busyclaw/errors";
import type { JsonObject } from "./common";
import type { BusyclawCronFlag, BusyclawPlugin } from "./governance/plugin";
import type { Principal } from "./governance/principal";

export type EngineRunHandle = {
	id: string;
};

export type EngineRunMetadata = {
	id?: string;
	principal?: Principal;
};

export type EngineStartRunInput = {
	prompt: string;
	ctx?: JsonObject;
	run?: EngineRunMetadata;
};

export type EngineContinueRunInput = {
	approvalId: string;
	ctx?: JsonObject;
	run?: EngineRunMetadata;
};

/**
 * What an external actor is asking of a run in flight, as a MONOTONE ladder: `suspend < stop <
 * abort`. The intent may only ever be RAISED, so two requesters cannot fight — a stop lands on top
 * of a suspend, and a suspend arriving after a stop changes nothing. One latch, no "who wins"
 * question, and no state where a run is both suspend-requested and stop-requested with no answer.
 *
 * Only `suspend` is honoured today (it parks and is resumable); `stop` and `abort` are declared here
 * because the ladder must be total from the start — a value added later cannot be compared against
 * intents already written to rows.
 */
export const runControlIntentValues = ["suspend", "stop", "abort"] as const;
export type RunControlIntent = (typeof runControlIntentValues)[number];

/**
 * WHY a run is `waiting`, which decides what un-waits it: `approval` ⇒ a human decision does;
 * `suspended` ⇒ an explicit resume does. Without this the two are one status and a resumer has to
 * guess which door to knock on.
 */
export const runWaitReasonValues = ["approval", "suspended"] as const;
export type RunWaitReason = (typeof runWaitReasonValues)[number];

export type EngineControlRunInput = {
	runId: string;
	intent: RunControlIntent;
	/** Stamped by the door from the authenticated caller — never read from a request body. */
	requestedBy?: Principal;
	/** An operator's explanation, read back by a human. May carry a name or a ticket subject. */
	reason?: string;
};

export type EngineControlRunResult = {
	/** False when there was nothing to control — the run had already reached a terminal status. */
	accepted: boolean;
	/**
	 * True when the intent was honoured IN THIS CALL rather than latched for the holder to observe.
	 * A run with nothing in flight is settled synchronously; a running one is not, and the caller
	 * must not read `accepted` as "it has stopped".
	 */
	settled: boolean;
	reason?: string;
};

export type EngineWorkResult = unknown;

export type EngineRunRecord = {
	id: string;
	status: string;
	input: JsonObject;
	principal?: Principal;
	createdAt: string;
	updatedAt: string;
};

export type EngineRunEvent = {
	id: string;
	runId: string;
	type: string;
	payload: JsonObject;
	createdAt: string;
};

export type ClawRunReadModel = {
	get: (id: string) => Promise<EngineRunRecord | null>;
	events: (runId: string) => Promise<EngineRunEvent[]>;
};

export type ClawEngineHandle<WorkResult = EngineWorkResult> = {
	kind: string;
	startRun: (input: EngineStartRunInput) => Promise<EngineRunHandle>;
	continueRun: (input: EngineContinueRunInput) => Promise<EngineRunHandle>;
	/**
	 * Record an external intent against a run in flight. REQUIRED, deliberately not optional: an
	 * engine that cannot park must throw `unsupportedOperationError` and say so. Optional would mean
	 * every caller writes `engine.controlRun?.(…)`, which silently does nothing — the worst possible
	 * answer to "stop this run", and one nobody would notice until they needed it.
	 */
	controlRun: (input: EngineControlRunInput) => Promise<EngineControlRunResult>;
	/** Engines with an explicit worker lifecycle expose this; managed engines may omit it. */
	work?: () => Promise<WorkResult>;
};

export type ClawEngineInstance<
	Handle extends ClawEngineHandle = ClawEngineHandle,
	HasCron extends BusyclawCronFlag = "unknown-cron",
> = {
	engine: Handle;
	runs?: ClawRunReadModel;
	plugins?: readonly BusyclawPlugin<HasCron>[];
	$HasCron?: HasCron;
};

export type ClawEngineFactory<
	RuntimeLike = unknown,
	Handle extends ClawEngineHandle = ClawEngineHandle,
	HasCron extends BusyclawCronFlag = "unknown-cron",
> = {
	kind: Handle["kind"];
	create: (runtime: RuntimeLike) => ClawEngineInstance<Handle, HasCron>;
	$HasCron?: HasCron;
};

export type DrainWorkStatus = "idle" | "limit";

export type DrainWorkResult<WorkResult = EngineWorkResult> = {
	processed: number;
	results: WorkResult[];
	status: DrainWorkStatus;
};

export type DrainWorkInput<WorkResult = EngineWorkResult> = {
	work: () => Promise<WorkResult | null | undefined>;
	limit?: number;
	isIdle?: (result: WorkResult | null | undefined) => boolean;
};

function defaultIsIdle<WorkResult>(
	result: WorkResult | null | undefined,
): boolean {
	if (result == null) return true;
	return (
		typeof result === "object" &&
		"status" in result &&
		(result as { status?: unknown }).status === "idle"
	);
}

/** Drain worker ticks until idle or the bounded limit is reached. */
export async function drainWork<WorkResult = EngineWorkResult>(
	input: DrainWorkInput<WorkResult>,
): Promise<DrainWorkResult<WorkResult>> {
	const limit = input.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1) {
		throw configurationError("drainWork limit must be a positive integer", {
			limit,
		});
	}
	const isIdle = input.isIdle ?? defaultIsIdle<WorkResult>;
	const results: WorkResult[] = [];
	for (let i = 0; i < limit; i++) {
		const result = await input.work();
		// null/undefined can never be a WorkResult — idle by definition. Checking it explicitly (not
		// just via isIdle, which returns boolean, not a guard) is what lets the push stay cast-free:
		// the old `as WorkResult` would have smuggled null into the results under a custom isIdle.
		if (result == null || isIdle(result))
			return { processed: results.length, results, status: "idle" };
		results.push(result);
	}
	return { processed: results.length, results, status: "limit" };
}
