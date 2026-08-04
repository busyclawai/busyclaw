/**
 * The engine protocol — what a durable execution engine IS: the engine-neutral handle
 * (start/continue/optional work), the factory composed by `createClaw`, the run read-model, and
 * the bounded `drainWork` helper cron hosts pump with. Implementations live in `@busyclaw/engine-*`
 * (engine-sql today; a managed-workflow engine implements the same verbs and omits `work`).
 */

import { configurationError } from "@busyclaw/errors";
import type { JsonObject } from "./common";
import type { EntityField } from "./entity";
import type { BusyclawCronFlag, BusyclawPlugin } from "./governance/plugin";
import type { Principal } from "./governance/principal";
import type { RunMessageMode } from "./run-message";

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

/**
 * WHAT advances a parked run. Every variant names a DURABLE RECORD that knows its own run id, and
 * that is the load-bearing property: it lets `runId` be an input the engine VERIFIES rather than one
 * it trusts. A disagreement between the two is refused, never resolved in either direction — R-M10
 * taught that a continuation which picks its own run identity forks the run.
 *
 * A tagged union rather than sibling verbs. `ClawEngineHandle` is a structural type with an already
 * optional member, so a verb an engine forgets is a missing property discovered at call time; a
 * missing tag in an exhaustive switch is a compile error. And the admit body is identical for all of
 * them — verify, refuse terminal, insert, flip, event — so separate verbs would mean separate copies
 * of the R-M10 reasoning and separate chances to reintroduce the fork.
 *
 * A `message` tag joins in the slice that adds the mailbox. It is deliberately NOT declared ahead of
 * its task kind: a tag the engine cannot enact is a promise the type system would enforce on callers
 * and the engine would break at runtime.
 */
export type EngineProceed =
	| { kind: "approval"; approvalId: string }
	| { kind: "checkpoint"; checkpointId: string };

export type EngineProceedRunInput = {
	/** The run the CALLER says this advances. Verified against the record's own id, never trusted. */
	runId: string;
	proceed: EngineProceed;
	ctx?: JsonObject;
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

export type EngineDeliverMessageInput = {
	toRunId: string;
	/** The message body, ALREADY tokenized into the receiving run's container by the door. */
	body: JsonObject;
	mode: RunMessageMode;
	sender: Principal;
	/** Makes the admission idempotent: the row id is derived from it, so a redelivered message loses
	 *  the insert instead of appearing twice in somebody's context window. */
	idempotencyKey: string;
	containerScope?: string;
	containerScopeId?: string;
};

export type EngineDeliverMessageResult = {
	id: string;
	seq: number;
	/** False when the row was already there (a redelivery) or the run was terminal (a bounce). */
	admitted: boolean;
	/** Present only on a bounce — the terminal status that refused it. */
	bounced?: string;
};

export type EngineWorkResult = unknown;

export type EngineRunRecord = {
	id: string;
	status: string;
	input: JsonObject;
	principal?: Principal;
	/**
	 * The boundary this run's authority actually resolved to, recorded by the engine after the run's
	 * first slice. Absent before that, and absent forever on a deployment that resolves no scope.
	 *
	 * Backed by real columns — unlike `team`, which lived here for months with nothing behind it and
	 * read as a fact to everyone who typed against this. The review rule that replaced it holds: a
	 * new field on this type requires a `runFields` column in the same commit, or it does not land.
	 */
	scope?: string;
	scopeId?: string;
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
	/**
	 * Advance an EXISTING parked run. Admits one durable work item and returns; nothing executes
	 * here. Idempotent per (runId, proceed) — a duplicate loses the insert and gets the same handle.
	 */
	proceedRun: (input: EngineProceedRunInput) => Promise<EngineRunHandle>;
	/**
	 * Record an external intent against a run in flight. REQUIRED, deliberately not optional: an
	 * engine that cannot park must throw `unsupportedOperationError` and say so. Optional would mean
	 * every caller writes `engine.controlRun?.(…)`, which silently does nothing — the worst possible
	 * answer to "stop this run", and one nobody would notice until they needed it.
	 */
	controlRun: (input: EngineControlRunInput) => Promise<EngineControlRunResult>;
	/**
	 * Admit a message into a run's inbox. Admission only — nothing is delivered here; the receiving
	 * run drains it at its next control point.
	 *
	 * A message to a TERMINAL run bounces rather than queueing against a corpse, and the bounce is
	 * decided by the same write that admits: a read-then-insert loses the race with a terminal
	 * transition committing in another process, and both adapters run the driver's default isolation.
	 */
	deliverMessage: (
		input: EngineDeliverMessageInput,
	) => Promise<EngineDeliverMessageResult>;
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
	/**
	 * The tables THIS engine needs, readable without constructing it.
	 *
	 * On the FACTORY rather than the instance, and that placement is the whole point: the schema
	 * collectors (`getBusyclawModels` / the `$tables` getter) run before `create()` — the engine is
	 * born after the runtime it wraps — so a contribution shaped like a plugin's is structurally too
	 * late, while one shaped like this is exactly on time.
	 *
	 * `run` and `run_event` are NOT here. They are core, because they are the GOVERNANCE record — the
	 * authz parent, the tenancy anchor, the control latch, the id every transcript row points at —
	 * which euroclaw needs whether or not this particular engine is the one scheduling the work. What
	 * belongs here is scheduling state: queues, leases, whatever this backend uses to find work again.
	 * An engine over a backend that owns its own durability declares nothing and migrates nothing.
	 *
	 * A model key colliding with a core model throws, exactly as a plugin's would: schema is additive,
	 * never a rewrite.
	 */
	models?: Record<
		string,
		{
			fields: Record<string, EntityField>;
			uniques?: readonly (readonly string[])[];
		}
	>;
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
