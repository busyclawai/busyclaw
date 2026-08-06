/**
 * The engine protocol — what a durable execution engine IS: the engine-neutral handle
 * (start/continue/optional work), the factory composed by `createClaw`, the run read-model, and
 * the bounded `drainWork` helper cron hosts pump with. Implementations live in `@busyclaw/engine-*`
 * (engine-sql today; a managed-workflow engine implements the same verbs and omits `work`).
 */

import { configurationError } from "@busyclaw/errors";
import type { JsonObject } from "./common";
import type { EntityField } from "./entity";
import type { RunMode } from "./governance/boundary";
import type { BusyclawCronFlag, BusyclawPlugin } from "./governance/plugin";
import type { Principal } from "./governance/principal";
import type { RunMessageMode } from "./run-message";
import type { RunStreamPort } from "./run-stream";

export type EngineRunHandle = {
	id: string;
};

export type EngineRunMetadata = {
	id?: string;
	principal?: Principal;
};

/**
 * WHERE a durable run's output belongs: which claw governs it, which thread its answers append to.
 *
 * Declared HERE rather than imported from `@busyclaw/runtime`, because contracts has near-zero deps
 * and runtime imports contracts, never the reverse. engine-sql widens it with the run id where it
 * builds runtime options.
 *
 * NO `runId`. The recording is not the identity carrier — identity rides `run.id`, in one place — and
 * a second slot for one fact is a second thing to disagree with the first, which is the R-M10 fork
 * the `EngineProceed` doc above memorializes.
 *
 * NOT CALLER-SETTABLE. `claw.api.startRun` enumerates what it forwards and its input schema rejects
 * undeclared keys, both deliberately: this names the run's authz parent, its redaction container and
 * the thread its answers land in, so a caller who could set it would be choosing all three.
 */
export type EngineRecording = {
	clawId: string;
	threadId: string;
	originMessageId?: string;
};

export type EngineStartRunInput = {
	prompt: string;
	ctx?: JsonObject;
	run?: EngineRunMetadata;
	recording?: EngineRecording;
	/**
	 * The model pool entry that answers this run, resolved by the door from the caller's validated
	 * selection. Rides the RUN rather than the invocation because a continuation claimed months later
	 * must reach the model the caller picked, not whichever is default by then. Absent on a
	 * single-`model` claw.
	 */
	model?: string;
	/**
	 * How this run was triggered — STAMPED BY THE DOOR, never accepted from a request body, and the
	 * wire schema drops it for the same reason it drops `recording`.
	 *
	 * A system-posture write is permitted only when confirmed OR `runMode == "interactive"`
	 * (`authz/src/system-posture.ts`), so a caller who could set this would be satisfying the policy
	 * that exists to detect their absence. Absent means `autonomous`, which is the fail-closed
	 * direction and the right default for anything cron reaches.
	 */
	runMode?: RunMode;
	/**
	 * Drive the first slice HERE, in this caller's invocation, instead of leaving it for cron.
	 *
	 * Takes NO task id: the engine claims the task it just enqueued, in the same transaction that
	 * created it. That is what makes the first slice race-free rather than race-resolved — an
	 * uncommitted insert is invisible to another connection, so no replica can see the task before
	 * this caller already holds its lease. The caller wins by construction.
	 *
	 * NOT caller-settable over the wire. `deadlineAt` is a caller-chosen YIELD, which is exactly what
	 * a door mints from its own budget and never reads from a request body.
	 *
	 * `onDelta` is what makes the STREAMING door routable through here at all: with it the engine
	 * drives the first slice through `runtime.stream` instead of `runtime.generate` and pushes the
	 * reader-facing deltas back out. A function in a contract is normally a smell, and it is sound
	 * here for the reason `drive` exists at all — this whole option means "in THIS invocation", so
	 * the callback never crosses a process, a wire, or a serialization boundary. An engine whose
	 * backend cannot drive in-process ignores `drive` entirely and this with it.
	 *
	 * Deltas arrive already REDACTED (R-M04) — the same placeholders the transcript will hold.
	 */
	drive?: {
		/**
		 * A FUNCTION means "ask again each step", which is how a door tells a run in flight that its
		 * reader walked away: it returns the invocation budget while somebody is reading and `now()`
		 * once nobody is, so the slice yields at its next control point instead of running on for an
		 * audience of none. In-process only, like `onDelta` and for the same reason — `drive` means
		 * "in THIS invocation", so nothing here crosses a wire.
		 */
		deadlineAt?: string | (() => string | undefined);
		onDelta?: (text: string) => void | Promise<void>;
	};
};

/**
 * What starting a run produced — and whether THIS invocation is the one that ran it.
 *
 * `driven: false` is not a failure. The run exists, its user message is in the transcript, and the
 * reply will land in the thread; this caller simply is not the one producing it. The reasons are
 * BACKEND-NEUTRAL on purpose: `driver-lost` is engine-sql's frozen-past-the-lease case, but a
 * Temporal or Durable-Objects engine has the same three outcomes under its own mechanics, and naming
 * them after one engine's lease vocabulary would leak it into a contract the others implement.
 */
/** Why an invocation that asked to drive did not produce the answer. Named separately so the door can
 *  pass it through to its caller verbatim instead of flattening three distinct outcomes into one. */
export type EngineNotDrivenReason =
	| "running-elsewhere"
	| "already-terminal"
	| "driver-lost";

export type EngineStartRunResult = {
	id: string;
	/** Absent when this invocation did not drive the run. Shaped by the engine — busyclaw parses it
	 *  against `RuntimeResult`, which contracts deliberately does not import. */
	result?: EngineWorkResult;
	notDriven?: EngineNotDrivenReason;
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
	/**
	 * Drive the admitted slice HERE, in this caller's invocation — the same option `startRun` takes,
	 * for the same reason and with the same shape.
	 *
	 * Without it, advancing a parked run means "enqueue and wait for cron", which is right for an
	 * operator clicking approve and wrong for a door whose caller is awaiting the answer. It is also
	 * what makes a resumed turn REACH ITS WATCHERS: every chunk is written by `driveClaim`, so a
	 * resume that never goes through the engine produces no text and, worse, no terminal event — a
	 * `watchRun` subscription that waits forever for a turn that finished.
	 */
	drive?: {
		deadlineAt?: string | (() => string | undefined);
		onDelta?: (text: string) => void | Promise<void>;
	};
};

/**
 * What advancing a run produced — a superset of {@link EngineRunHandle}, so a caller that only ever
 * wanted the id is unaffected.
 *
 * Same three outcomes as `startRun`, because it is the same question: this invocation either drove
 * the slice or it did not, and the reasons a caller did not are backend-neutral.
 */
export type EngineProceedRunResult = EngineRunHandle & {
	result?: EngineWorkResult;
	notDriven?: EngineNotDrivenReason;
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
	containerKind?: string;
	containerId?: string;
};

export type EngineDeliverMessageResult = {
	id: string;
	seq: number;
	/** False when the row was already there (a redelivery) or the run was terminal (a bounce). */
	admitted: boolean;
	/** Present only on a bounce — the terminal status that refused it. */
	bounced?: string;
};

/**
 * What a prune actually removed, per table rather than as one number.
 *
 * Per table because the numbers answer different questions: `runs` is how many finished turns were
 * swept (what a host schedules against), while the rest is how much exhaust each of them left. One
 * total would hide a claw whose runs are cheap and whose events are not.
 */
export type EnginePruneResult = {
	/** Runs swept — NOT deleted. Their rows stay; their exhaust does not. */
	runs: number;
	events: number;
	tasks: number;
	messages: number;
	/**
	 * WHICH runs were swept, so a caller can prune the stores this engine does not own — checkpoints
	 * live behind `RunCheckpointStore`, which is a different port over the same database.
	 *
	 * Bounded by `limit`, so this is a page of ids rather than an open-ended list. Returning them
	 * beats a second "which runs would you sweep" query that could disagree with the sweep itself.
	 */
	runIds: readonly string[];
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
	/** Where this run's output belongs. Backed by real columns in the same commit, per the rule
	 *  above — `clawId` is the authz parent the run loader climbs to and the redaction container
	 *  `deliverMessage` tokenizes into, `threadId` is where the answers append. */
	clawId?: string;
	threadId?: string;
	originMessageId?: string;
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
	/**
	 * The unfinished runs a principal started in one claw — what revoking that principal's access has
	 * to reach (hazard G6).
	 *
	 * OPTIONAL, because an engine over a backend that does not index runs this way cannot answer it,
	 * and the honest consequence of that is stated where it bites: `unshareResource` deletes the grant
	 * and cannot stop the runs it authorized. A required member would force every engine to grow a
	 * query it may have no index for, and the usual result of that is a table scan nobody sees.
	 */
	listActiveForClaw?: (input: {
		clawId: string;
		principal: string;
	}) => Promise<EngineRunRecord[]>;
	/**
	 * The unfinished runs on one conversation, newest first — "is somebody already answering this?".
	 *
	 * A router asks this to steer a live turn instead of starting a second one beside it. Deliberately
	 * NOT filtered to a single run: two people sending into one thread is two legitimate runs (G8),
	 * so the caller picks, and a caller that assumed one would be wrong exactly when multiplayer is.
	 *
	 * OPTIONAL for the same reason as its sibling — an engine that cannot index runs by thread should
	 * say so rather than grow a table scan.
	 */
	listActiveForThread?: (input: {
		threadId: string;
	}) => Promise<EngineRunRecord[]>;
};

export type ClawEngineHandle<WorkResult = EngineWorkResult> = {
	kind: string;
	/** Create the run and enqueue its first slice. With `drive`, also CLAIM that slice and run it
	 *  here — same claim, lease and terminal transitions a worker uses, because there is no
	 *  caller-driven versus worker-driven, only who holds the lease right now. */
	startRun: (input: EngineStartRunInput) => Promise<EngineStartRunResult>;
	/**
	 * Advance an EXISTING parked run. Admits one durable work item and returns; nothing executes
	 * here. Idempotent per (runId, proceed) — a duplicate loses the insert and gets the same handle.
	 */
	proceedRun: (input: EngineProceedRunInput) => Promise<EngineProceedRunResult>;
	/**
	 * Record an external intent against a run in flight. REQUIRED, deliberately not optional: an
	 * engine that cannot park must throw `unsupportedOperationError` and say so. Optional would mean
	 * every caller writes `engine.controlRun?.(…)`, which silently does nothing — the worst possible
	 * answer to "stop this run", and one nobody would notice until they needed it.
	 */
	controlRun: (input: EngineControlRunInput) => Promise<EngineControlRunResult>;
	/**
	 * The invocation budget, in ms, that a DOOR derives a `drive.deadlineAt` from — so a turn driven
	 * inside a request parks a checkpoint before the platform kills it, instead of dying mid-step.
	 *
	 * Only the cron plugin could compute this before; a door driving its own turn needs the same
	 * number, and it is the engine that knows it. Absent means never yield: a daemon host with no
	 * invocation limit has nothing to park against.
	 */
	softDeadlineMs?: number;
	/**
	 * Whether anything OTHER than this caller will pick up work this run leaves behind.
	 *
	 * A yield writes a checkpoint and enqueues a continuation; on engine-sql that continuation is a
	 * pending task, and pending tasks are claimed only by the cron drain. So on a deployment with no
	 * cron, yielding is not "park and continue later" — it is "stop forever", and a door that yields
	 * on it converts a turn that would have finished into a turn that never lands.
	 *
	 * Which is why this is on the HANDLE rather than inferred: only the engine knows whether its
	 * continuations get claimed, and the door has to know before it decides what a departing reader
	 * means. Absent is read as false — the fail-safe direction, since guessing "yes" strands runs and
	 * guessing "no" merely costs a few tokens finishing one nobody is watching.
	 */
	resumesPendingWork?: boolean;
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
	/**
	 * Delete the OPERATIONAL EXHAUST of finished runs in one claw — retention, host-scheduled.
	 *
	 * Not a cron job this library owns, deliberately. A retention window is host policy: 30 days is
	 * wrong for a regulated tenant and seven years is wrong for a chat toy, and a job we scheduled
	 * would need exactly the knob that should not exist. The host already has cron; this is the
	 * primitive it calls.
	 *
	 * WHAT GOES: run events, scheduling tasks and inbox rows — everything with no reader once a run
	 * is terminal. WHAT STAYS: the `run` row itself, because `message.runId` points at it and
	 * `getRun` answering "cancelled, last March" is worth more than the ~200 bytes; the transcript,
	 * which is the product record and not exhaust; and approvals and effects, which are evidence.
	 *
	 * BOUNDED by `limit` runs per call, so a year of chat cannot be swept inside one request. A host
	 * loops until `runs` comes back 0.
	 *
	 * OPTIONAL: an engine over a backend that owns its own durability prunes differently or not at
	 * all, and the api says so rather than pretending the call happened.
	 */
	pruneRuns?: (input: {
		clawId: string;
		/** Prune runs that reached a terminal status STRICTLY BEFORE this ISO timestamp. */
		before: string;
		limit?: number;
	}) => Promise<EnginePruneResult>;
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

/**
 * What the ASSEMBLY resolved and the engine cannot: infrastructure chosen by `createClaw` after the
 * factory was already constructed.
 *
 * A host writes `engine: sqlEngine({ store })` at config time, long before `createClaw` decides where
 * live deltas go — so before this existed, a host-supplied engine simply never received the claw's
 * `runStream` and NOTHING reached a watcher. Not a degraded stream: an empty one, in the exact
 * configuration the README documents.
 *
 * Optional and additive, so an engine that ignores it compiles and behaves as it always did. An
 * engine given the same thing explicitly should prefer the explicit one — the host said it out loud.
 */
export type ClawEngineServices = {
	/** Where live deltas go, resolved by the assembly (explicit config → secondary storage → the
	 *  claw's own database). Absent when the deployment has no stream at all. */
	runStream?: RunStreamPort;
};

export type ClawEngineFactory<
	RuntimeLike = unknown,
	Handle extends ClawEngineHandle = ClawEngineHandle,
	HasCron extends BusyclawCronFlag = "unknown-cron",
> = {
	kind: Handle["kind"];
	/**
	 * Build the engine. `services` carries what the assembly resolved and the factory could not know
	 * at config time — see {@link ClawEngineServices}. Optional so an engine may ignore it entirely.
	 */
	create: (
		runtime: RuntimeLike,
		services?: ClawEngineServices,
	) => ClawEngineInstance<Handle, HasCron>;
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
