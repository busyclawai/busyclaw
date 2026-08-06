/**
 * Portions of this file are adapted from NullTickets and informed by NullBoiler
 * (patterns/architecture, not copied code), Copyright (c) 2026 nullclaw contributors,
 * licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * - The lease/claim/heartbeat/idempotency shape is adapted from NullTickets' SQLite tracker:
 *   `/Users/konstantinponomarev/Downloads/nulltickets-main/src/store.zig` and `src/api.zig`.
 * - The run/event/checkpoint/orchestrator shape is informed by NullBoiler:
 *   `/Users/konstantinponomarev/Downloads/nullboiler-main/src/store.zig` and `src/engine.zig`.
 *
 * This is an independent TypeScript implementation over busyclaw's storage Adapter. Runtime history
 * produced here is operational state, not compliance audit; compliance evidence stays in @busyclaw/core.
 */

import type {
	Adapter,
	EngineRecording,
	JsonObject,
	RunMessageMode,
	RunMode,
} from "@busyclaw/contracts";
import {
	asPrincipal,
	configurationError,
	errorMessage,
	isConflict,
	jsonObject as jsonObjectSchema,
	nonTerminalRunStatuses,
	type Principal,
	runMessageFields,
	stateError,
	terminalRunStatuses,
	validationError,
} from "@busyclaw/contracts";
import {
	type EntityPatch,
	type EntityWhere,
	entityDb,
} from "@busyclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type as ark } from "arktype";
import {
	idempotencyFields,
	leaseFields,
	runEventFields,
	runFields,
	runtimeTaskFields,
} from "./schema";

export const RunStatus = ark(
	"'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'",
);
export type RunStatus = typeof RunStatus.infer;

export const TaskStatus = ark(
	"'pending' | 'leased' | 'completed' | 'failed' | 'dead'",
);
export type TaskStatus = typeof TaskStatus.infer;

const JsonRecord = jsonObjectSchema;
const OptionalString = ark("string | undefined");

/**
 * The row id for a message. Derived so the INSERT is the admission — the same construction the
 * channels inbox uses, NUL-joined for the same reason: three opaque ids from different sources must
 * not be able to collide by concatenation. Written as the escape rather than a literal NUL byte,
 * because a source file carrying a raw NUL is binary to git.
 *
 * Lives HERE rather than beside the engine because both the admit door and the thread-inbox adoption
 * mint one, and the adoption is a store operation — a second copy of this construction is a second
 * chance for two ids of the same message to disagree.
 */
export function messageRowId(
	toRunId: string,
	sender: string,
	idempotencyKey: string,
): string {
	return bytesToHex(
		sha256(utf8ToBytes(`${toRunId}\u0000${sender}\u0000${idempotencyKey}`)),
	);
}

export const RunControlIntentValue = ark("'suspend' | 'stop' | 'abort'");
export const RunWaitReasonValue = ark("'approval' | 'suspended'");

export const RunRecord = ark({
	id: "string",
	status: RunStatus,
	input: JsonRecord,
	"principal?": OptionalString,
	// The tenancy anchor, absent until a slice has resolved one.
	"scope?": OptionalString,
	"scopeId?": OptionalString,
	// Where the run's output belongs — the authz parent and the redaction containerKind.
	"clawId?": OptionalString,
	"threadId?": OptionalString,
	"originMessageId?": OptionalString,
	// Which model answers, and whether a human was present when it was asked. Both fixed at create
	// and read back on every claim — see the field comments in contracts/src/run.ts.
	"model?": OptionalString,
	"runMode?": ark("'interactive' | 'autonomous' | undefined"),
	// The control latch. Absent on every row written before it existed, and on every run nobody has
	// asked anything of — which is almost all of them.
	"controlRequestedAt?": OptionalString,
	"controlIntent?": RunControlIntentValue.or("undefined"),
	"controlRequestedBy?": OptionalString,
	"controlReason?": OptionalString,
	"controlSeq?": "number | undefined",
	// When this run's exhaust was swept, `""` for never. A written sentinel rather than null or a
	// boolean — see the field's own comment for why both of those are unportable.
	"prunedAt?": OptionalString,
	// Split out of `controlSeq` so a careless control write cannot renumber a message (C3). Absent on
	// every row written before it existed, which is what `admitMessage`'s seeding path is for.
	"messageSeq?": "number | undefined",
	"waitReason?": RunWaitReasonValue.or("undefined"),
	"resumeCheckpointId?": OptionalString,
	createdAt: "string",
	updatedAt: "string",
});
// `principal` is the branded Principal (the `run.principal` stamp column, validated by the entityDb
// read schema); the local arktype checks the string shape, the type carries the brand.
export type RunRecord = Omit<
	typeof RunRecord.infer,
	"principal" | "controlRequestedBy"
> & {
	principal?: Principal;
	controlRequestedBy?: Principal;
};

export const RuntimeTask = ark({
	id: "string",
	runId: "string",
	kind: "string",
	status: TaskStatus,
	payload: JsonRecord,
	dueAt: "string",
	attempt: "number",
	"errorAttempt?": "number | undefined",
	maxAttempts: "number",
	retryDelayMs: "number",
	"leaseId?": OptionalString,
	"workerId?": OptionalString,
	"leasedUntil?": OptionalString,
	"lastError?": OptionalString,
	"output?": JsonRecord.or("undefined"),
	createdAt: "string",
	updatedAt: "string",
	"completedAt?": OptionalString,
});
export type RuntimeTask = typeof RuntimeTask.infer;

export const RunEvent = ark({
	id: "string",
	runId: "string",
	type: "string",
	payload: JsonRecord,
	createdAt: "string",
});
export type RunEvent = typeof RunEvent.infer;

export const LeaseRecord = ark({
	id: "string",
	taskId: "string",
	workerId: "string",
	tokenHash: "string",
	expiresAt: "string",
	lastHeartbeatAt: "string",
	createdAt: "string",
});
export type LeaseRecord = typeof LeaseRecord.infer;

export type ClaimedTask = {
	task: RuntimeTask;
	leaseId: string;
	leaseToken: string;
	expiresAt: string;
};

export const IdempotencyRecord = ark({
	id: "string",
	key: "string",
	method: "string",
	path: "string",
	"scope?": OptionalString,
	"scopeId?": OptionalString,
	"principal?": OptionalString,
	requestHash: "string",
	responseStatus: "number",
	responseBody: JsonRecord,
	createdAt: "string",
});
export type IdempotencyRecord = typeof IdempotencyRecord.infer;

export type SqlEngineStoreOptions = {
	now?: () => string;
	runModel?: string;
	taskModel?: string;
	eventModel?: string;
	leaseModel?: string;
	idempotencyModel?: string;
};

export type CreateRunInput = {
	id?: string;
	input?: Record<string, unknown>;
	principal?: Principal;
	/** Where this run's output belongs — the claw that governs it and the thread its answers append
	 *  to. Columns, not task payload: the payload is gone by the time a reader asks, and the
	 *  `deliverMessage` door needs the claw before any task has been claimed. */
	recording?: EngineRecording;
	/** Which model answers this run. Columns for the same reason as `recording`: a continuation
	 *  claimed months later reads the row, and a payload cannot answer it. */
	model?: string;
	/** Whether a human was present when this run was asked for. STAMPED BY THE DOOR — a caller who
	 *  could set it would satisfy the policy that exists to detect their absence. Absent means
	 *  `autonomous`, the fail-closed direction. */
	runMode?: RunMode;
};

export type EnqueueTaskInput = {
	id?: string;
	runId: string;
	kind: string;
	payload?: Record<string, unknown>;
	dueAt?: string;
	maxAttempts?: number;
	retryDelayMs?: number;
};

export type ClaimTaskInput = {
	workerId: string;
	leaseTtlMs?: number;
	limit?: number;
};

export type IdempotencyLookup = {
	key: string;
	method: string;
	path: string;
	scope?: string;
	scopeId?: string;
	// The request's principal — a component of the idempotency key tuple. The (future) request handler
	// passes ctx's already-branded Principal; it is a plain string at runtime, so it hashes into the
	// key exactly as before.
	principal?: Principal;
	requestHash: string;
};

export type SaveIdempotencyInput = IdempotencyLookup & {
	responseStatus: number;
	responseBody: Record<string, unknown>;
};

export type SqlEngineStore = {
	/** The store's time source — the engine's single clock (worker deadline checks, cron budgets). */
	now: () => string;
	transaction: <R>(fn: (tx: SqlEngineStore) => Promise<R>) => Promise<R>;
	createRun: (input?: CreateRunInput) => Promise<RunRecord>;
	getRun: (id: string) => Promise<RunRecord | null>;
	/**
	 * The runs in this claw that a given principal started and that have not finished — what
	 * revoking that principal's access has to reach (hazard G6).
	 *
	 * NARROW ON PURPOSE. This is not a run browser: it answers one question, from two indexed
	 * columns, for a caller that already holds `manage` on the claw. A general "list runs" surface is
	 * a different decision with a paging and authorization story this does not need.
	 */
	listActiveForClaw: (input: {
		clawId: string;
		principal: string;
	}) => Promise<RunRecord[]>;
	updateRun: (
		id: string,
		patch: EntityPatch<typeof runFields>,
	) => Promise<RunRecord | null>;
	/**
	 * `updateRun`, but only when the run is currently in one of `from` — a compare-and-swap, so it
	 * returns the row it changed or `null` when the run had moved on. Every write that could land on
	 * a run somebody else already finished belongs here rather than on `updateRun`: an unconditional
	 * status write is how a terminal run gets resurrected by a claim that was already too late.
	 */
	updateRunIfStatus: (
		id: string,
		input: {
			from: readonly RunStatus[];
			patch: EntityPatch<typeof runFields>;
		},
	) => Promise<RunRecord | null>;
	enqueueTask: (input: EnqueueTaskInput) => Promise<RuntimeTask>;
	getTask: (id: string) => Promise<RuntimeTask | null>;
	claimDueTask: (input: ClaimTaskInput) => Promise<ClaimedTask | null>;
	/**
	 * Claim ONE task by primary key — the same acquisition `claimDueTask` performs, without its
	 * candidate scan.
	 *
	 * Deliberately NOT on `ClawEngineHandle` and never reachable from `clawApiRoutes`, because a
	 * leased task is a strictly bigger privilege loan than any api verb hands out: whoever holds the
	 * lease can also `completeTask` it with arbitrary `output`. The taskId is never caller-supplied.
	 *
	 * The scan is what it must not share. A caller that ran `claimDueTask` after enqueuing its own
	 * task would take the OLDEST due task, drive somebody else's run under that run's principal, and
	 * hand back that other tenant's result — a cross-tenant disclosure, not a latency question.
	 */
	claimTask: (
		taskId: string,
		input: ClaimTaskInput,
	) => Promise<ClaimedTask | null>;
	heartbeatLease: (input: {
		leaseId: string;
		leaseToken: string;
		leaseTtlMs?: number;
	}) => Promise<LeaseRecord | null>;
	completeTask: (input: {
		taskId: string;
		leaseToken: string;
		output?: Record<string, unknown>;
	}) => Promise<RuntimeTask | null>;
	failTask: (input: {
		taskId: string;
		leaseToken: string;
		reason: string;
	}) => Promise<RuntimeTask | null>;
	/** CAS every still-pending task of a run to `dead`. What makes a synchronous suspend terminal:
	 *  a withheld task cannot be picked up later by a host that never saw the intent. Returns how
	 *  many were withheld. */
	deadLetterPendingTasks: (runId: string, reason: string) => Promise<number>;
	/**
	 * Delete the operational rows of finished runs in one claw, oldest first, and report the counts.
	 *
	 * Retention, not correctness: nothing here has a reader once the run is terminal. The `run` row
	 * itself STAYS — `message.runId` points at it, and `getRun` answering "cancelled, last March" is
	 * worth more than the bytes.
	 */
	pruneRuns: (input: {
		clawId: string;
		before: string;
		limit?: number;
	}) => Promise<{
		runs: number;
		events: number;
		tasks: number;
		messages: number;
		runIds: string[];
	}>;
	/** The unfinished runs on one thread, newest first — what a router reads to steer a live turn
	 *  instead of starting a second one beside it. */
	listActiveForThread: (threadId: string) => Promise<RunRecord[]>;
	/** The highest inbox seq this run's rows already hold, or 0. Seeds `run.messageSeq` on a run that
	 *  predates that column — see the field's own doc for why zero would be wrong. */
	maxMessageSeq: (toRunId: string) => Promise<number>;
	/**
	 * Take over the messages this thread's FINISHED runs never read, and report how many.
	 *
	 * `at_turn_end` is wake fuel for the next turn by definition, and a `next_step` message typed
	 * while a turn was finishing has no step left to be seen at — both leave words addressed to a
	 * conversation that the run they named will never read (hazard C6). Called at the start of a
	 * conversational run, which is the first moment a next run exists to hand them to.
	 */
	adoptThreadInbox: (input: {
		threadId: string;
		toRunId: string;
	}) => Promise<number>;
	/** Take every undelivered message for a run past `afterSeq`, in the run's own order, and mark it
	 *  delivered at `step`. Exactly one reader — the run itself, already fenced by the engine lease on
	 *  its own task — so there is no claim and no lease on the row. */
	drainMessages: (input: {
		toRunId: string;
		afterSeq: number;
		step: number;
		/** WHO this slice is executing as. A message from anyone else is not drained — it becomes the
		 *  next slice's, under its own sender. Absent means "drain regardless", which is what a run
		 *  with no principal (an unauthenticated start) can honestly do. */
		runAs?: Principal;
	}) => Promise<{
		readonly delivered: readonly { seq: number; body: JsonObject }[];
		/** Set when the drain STOPPED at a message from another principal. The slice hands over: it
		 *  checkpoints here and its continuation runs as this sender. */
		readonly handoverTo?: Principal;
	}>;
	/** Is there an undelivered `interrupt`-mode message for this run? The one question the heartbeat
	 *  asks on behalf of a model call already in flight. */
	hasPendingInterrupt: (runId: string) => Promise<boolean>;
	/** Admit a message to a run's inbox. Mints `seq` and decides the bounce in ONE conditional write
	 *  against the run row — see the implementation for why those cannot be two. */
	admitMessage: (input: {
		id: string;
		toRunId: string;
		body: JsonObject;
		mode: RunMessageMode;
		sender: Principal;
		containerKind?: string;
		containerId?: string;
	}) => Promise<
		| { admitted: true; id: string; seq: number }
		| { admitted: false; id: string; seq: number; bounced?: string }
	>;
	reapExpiredLeases: () => Promise<number>;
	/** Append a `run_event` EXECUTION-STATE row (every worker emit lands here) — not the
	 *  operational stream; observability is the runtime `EventSink`. See schema.ts. */
	appendEvent: (input: {
		runId: string;
		type: string;
		payload?: Record<string, unknown>;
	}) => Promise<RunEvent>;
	events: (runId: string) => Promise<RunEvent[]>;
	requestHash: (body: unknown) => string;
	getIdempotency: (
		input: IdempotencyLookup,
	) => Promise<IdempotencyRecord | null>;
	saveIdempotency: (input: SaveIdempotencyInput) => Promise<IdempotencyRecord>;
};

/**
 * A run in one of these still has work ahead of it; anything else is finished and must not be
 * written back into flight by a claim that lost its race.
 *
 * RE-EXPORTED, not re-declared. This was its own literal, and the api and the engine each had their
 * own copy of the complement — three answers to "is this run over", any two of which could disagree
 * the moment a status was added. The partition lives in contracts now, with a compile-time guard
 * that a new status joins exactly one half.
 */
export const NON_TERMINAL_RUN_STATUSES = nonTerminalRunStatuses;

/**
 * How many finished runs one prune call sweeps.
 *
 * Bounded so a year of chat cannot be swept inside one request — the host loops until the count comes
 * back 0. Not a config knob: the number that matters is the RETENTION WINDOW, which the caller
 * passes, and this is only how big a bite each call takes.
 */
const DEFAULT_PRUNE_LIMIT = 500;

/** How many times a task may be CLAIMED before it is abandoned, however it lost each claim. The
 *  backstop against a flapping host, deliberately not a config knob: it bounds crash loops, and a
 *  deployment that wants more retries wants a higher `maxAttempts`, which is a different question. */
const MAX_CLAIMS = 8;

/** CAS-retry bound for minting a message `seq`. Contention here is two admits racing on one run,
 *  which is rare and short-lived; a bound that is hit means something else is wrong. */
const MAX_SEQ_ATTEMPTS = 8;

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function newId(): string {
	return bytesToHex(randomBytes(16));
}

function newToken(): string {
	return bytesToHex(randomBytes(32));
}

function hashText(text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text)));
}

export function addMs(iso: string, ms: number): string {
	return new Date(Date.parse(iso) + ms).toISOString();
}

/** Narrow a caller-supplied `Record<string, unknown>` json payload to JsonObject at the write seam —
 *  a parse, never a cast (the entity layer re-validates the whole record on create). */
function asJsonRecord(value: unknown, label: string): JsonObject {
	const valid = jsonObjectSchema(value);
	if (valid instanceof ark.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	return valid;
}

function stringifyJson(value: unknown, label: string): string {
	const valid = jsonObjectSchema(value);
	if (valid instanceof ark.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	try {
		const json = JSON.stringify(valid);
		if (typeof json !== "string") {
			throw validationError(`${label} invalid`, "must be JSON-serializable");
		}
		return json;
	} catch (err) {
		if (err instanceof Error && err.name === "BusyclawError") throw err;
		throw validationError(`${label} invalid`, errorMessage(err));
	}
}

function pendingWhere(now: string): EntityWhere<typeof runtimeTaskFields>[] {
	return [
		{ field: "status", value: "pending" },
		{ field: "dueAt", value: now, operator: "lte", connector: "AND" },
	];
}

function idempotencyId(input: IdempotencyLookup): string {
	return hashText(
		JSON.stringify({
			key: input.key,
			method: input.method,
			path: input.path,
			scope: input.scope ?? null,
			scopeId: input.scopeId ?? null,
			principal: input.principal ?? null,
		}),
	);
}

export function createSqlEngineStore(
	adapter: Adapter,
	options: SqlEngineStoreOptions = {},
): SqlEngineStore {
	const runTransaction = adapter.transaction;
	if (!runTransaction) {
		throw configurationError(
			"@busyclaw/engine-sql requires a transactional storage adapter",
			{ adapter: adapter.id },
		);
	}
	const now = options.now ?? (() => new Date().toISOString());
	const runModel = options.runModel ?? "run";
	const taskModel = options.taskModel ?? "runtime_task";
	const eventModel = options.eventModel ?? "run_event";
	const leaseModel = options.leaseModel ?? "lease";
	const idempotencyModel = options.idempotencyModel ?? "idempotency_key";
	// Every engine table persists through the entity layer (logical↔physical names, JSON
	// encode/decode, undefined-dropping, immutable enforcement) — and every row crossing the adapter
	// boundary is parsed against its record schema, so the ops speak validated native records. Each
	// table's *Model option pins its physical name via modelName.
	const db = entityDb(adapter, {
		run: { fields: runFields, modelName: runModel },
		runtime_task: { fields: runtimeTaskFields, modelName: taskModel },
		run_event: { fields: runEventFields, modelName: eventModel },
		lease: { fields: leaseFields, modelName: leaseModel },
		idempotency_key: { fields: idempotencyFields, modelName: idempotencyModel },
		// CORE-owned (it joins CORE_MODELS, not sqlEngineSchema), but read and written from here: the
		// admit transaction has to touch the `run` row and the message in one place, and this is the
		// only store that holds both.
		run_message: { fields: runMessageFields },
	});

	/**
	 * ACQUISITION — everything a claim does once a candidate has been chosen, and nothing about
	 * choosing one. Extracted verbatim from `claimDueTask` so the two claim paths cannot drift: the
	 * MAX_CLAIMS retirement, the control-latch fence, the lease mint, the task CAS, its unwind, the
	 * non-terminal run guard and ITS unwind are one body carrying one set of race arguments.
	 *
	 * `null` means "not claimable", for every reason it can mean that — retired, withheld, CAS lost,
	 * run already finished. `claimDueTask` reads that as "try the next candidate"; a targeted claim
	 * reads it as "somebody else owns this". Both are correct without either branching on which.
	 */
	async function attemptClaim(
		candidate: RuntimeTask,
		input: ClaimTaskInput,
		ts: string,
	): Promise<ClaimedTask | null> {
		if (candidate.attempt >= MAX_CLAIMS) {
			await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: candidate.id },
					{ field: "status", value: "pending", connector: "AND" },
				],
				update: {
					status: "dead",
					lastError: `abandoned after ${MAX_CLAIMS} claims without completing`,
					updatedAt: ts,
				},
			});
			// CONDITIONAL. This retires ONE task; the run may be perfectly healthy and, under a
			// caller-driven claim, may be `running` under somebody's live lease right now. An
			// unconditional write marked that turn `failed` from underneath its driver — and marked an
			// already-`completed` run `failed` too. `queued` is the only status where an exhausted task
			// is genuinely the run's last hope. The reaper's own exhaustion path already had this shape
			// (`store.ts` `reapExpiredLeases`); this is the copy that was never made.
			await store.updateRunIfStatus(candidate.runId, {
				from: ["queued"],
				patch: { status: "failed" },
			});
			return null;
		}
		// THE FENCE. A run somebody has asked to stop must not receive another slice on any
		// host — and a queued run has no holder to observe the latch for it, so the claim path
		// is where that intent gets honoured. One PK read per candidate, on the path that is
		// already doing several writes.
		const candidateRun = await store.getRun(candidate.runId);
		if (candidateRun?.controlRequestedAt !== undefined) {
			// BRANCH ON THE INTENT, exactly as the synchronous control path does
			// (`engine.ts:277-311`). This used to write `waiting`/`suspended` whatever the latch said,
			// so a `stop` or `abort` that lost the CAS there and fell through to a bare latch was
			// honoured here as a SUSPEND — the claim path quietly relabelled a cancellation as a park,
			// and the requester who asked for the run to end was told it was merely waiting.
			const stops = candidateRun.controlIntent !== "suspend";
			const withheld = await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: candidate.id },
					{ field: "status", value: "pending", connector: "AND" },
				],
				update: {
					status: "dead",
					lastError: stops
						? "run cancelled before this task was claimed"
						: "run suspended before this task was claimed",
					updatedAt: ts,
				},
			});
			if (withheld) {
				// THE LATCH IS RUN-SCOPED; this task is not. Retiring one task is task-scoped and always
				// correct, but SETTLING the run on its behalf is only correct when no holder exists to
				// observe the latch itself — otherwise a stale duplicate task swallows a stop the live
				// driver never sees, and the run keeps working with its intent already cleared (C4).
				// `from` excludes `running` for that reason, matching the synchronous path.
				const holders = await db.findMany({
					model: "runtime_task",
					where: [
						{ field: "runId", value: candidate.runId },
						{ field: "status", value: "leased", connector: "AND" },
						{
							field: "leasedUntil",
							value: ts,
							operator: "gt",
							connector: "AND",
						},
					],
					limit: 1,
				});
				// A live lease with the run still `queued` is the window between another claim's task
				// CAS and its run-status write. The `from` pin cannot see that one; this can.
				if (holders.length === 0) {
					const settled = await store.updateRunIfStatus(candidate.runId, {
						from: ["queued", "waiting"],
						patch: {
							status: stops ? "cancelled" : "waiting",
							waitReason: stops ? null : "suspended",
							controlRequestedAt: null,
							controlIntent: null,
							controlRequestedBy: null,
							controlReason: null,
						},
					});
					if (settled) {
						await store.appendEvent({
							runId: candidate.runId,
							type: stops ? "run.cancelled" : "run.suspended",
							payload: {
								taskId: candidate.id,
								...(candidateRun.controlIntent
									? { intent: candidateRun.controlIntent }
									: {}),
								...(candidateRun.controlRequestedBy
									? { requestedBy: candidateRun.controlRequestedBy }
									: {}),
							},
						});
					}
				}
			}
			return null;
		}

		const leaseToken = newToken();
		const leaseId = newId();
		const expiresAt = addMs(ts, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
		const lease: LeaseRecord = {
			id: leaseId,
			taskId: candidate.id,
			workerId: input.workerId,
			tokenHash: hashText(leaseToken),
			expiresAt,
			lastHeartbeatAt: ts,
			createdAt: ts,
		};
		await db.create({ model: "lease", data: lease });
		const updated = await db.update({
			model: "runtime_task",
			where: [
				{ field: "id", value: candidate.id },
				{ field: "status", value: "pending", connector: "AND" },
				// A NO-OP for `claimDueTask`, whose candidates were already filtered by `pendingWhere`,
				// and load-bearing for a targeted claim: `failTask` pushes `dueAt` out to schedule a
				// retry backoff, and a claim by primary key would otherwise walk straight past it and
				// re-run failing work with no delay at all.
				{ field: "dueAt", value: ts, operator: "lte", connector: "AND" },
			],
			update: {
				status: "leased",
				leaseId,
				workerId: input.workerId,
				leasedUntil: expiresAt,
				attempt: candidate.attempt + 1,
				updatedAt: ts,
			},
		});
		if (!updated) {
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: leaseId }],
			});
			return null;
		}
		// CONDITIONAL. A claim can arrive after the run it belongs to has already reached a
		// terminal status — a duplicate task, a late deadline arm, a stop that landed between
		// this claim's task CAS and here. Writing `running` unconditionally resurrected it:
		// `completed` became `running` and stayed there, contradicting the run's own event
		// stream, and a cancelled run silently went back to work.
		const started = await store.updateRunIfStatus(updated.runId, {
			from: NON_TERMINAL_RUN_STATUSES,
			patch: { status: "running" },
		});
		if (!started) {
			// The run is finished and this task has nothing to do. Retire it and release the
			// lease rather than handing a worker a slice against a corpse.
			await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: updated.id },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: leaseId, connector: "AND" },
				],
				update: {
					status: "dead",
					lastError:
						"run reached a terminal status before this task was claimed",
					leaseId: null,
					workerId: null,
					leasedUntil: null,
					updatedAt: ts,
				},
			});
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: leaseId }],
			});
			return null;
		}
		return { task: updated, leaseId, leaseToken, expiresAt };
	}

	async function validateLease(
		task: RuntimeTask,
		token: string,
	): Promise<LeaseRecord | null> {
		if (task.leaseId === undefined) return null;
		const lease = await db.findOne({
			model: "lease",
			where: [{ field: "id", value: task.leaseId }],
		});
		if (!lease) return null;
		if (lease.taskId !== task.id) return null;
		if (lease.expiresAt <= now()) return null;
		if (lease.tokenHash !== hashText(token)) return null;
		return lease;
	}

	const store: SqlEngineStore = {
		now,

		transaction(fn) {
			return runTransaction((tx) => fn(createSqlEngineStore(tx, options)));
		},

		async createRun(input = {}) {
			const ts = now();
			return db.create({
				model: "run",
				data: {
					id: input.id ?? newId(),
					status: "queued",
					// Present from birth, so the inbox's compare-and-swap has something to pin. An ABSENT
					// column is not zero: `eq null` does not match `undefined`, so a CAS on `0` would
					// match nothing and spin.
					controlSeq: 0,
					prunedAt: "",
					// Written from birth for the same reason `controlSeq` is: `eq null` cannot express
					// "absent", so a CAS pinned on a default matches nothing and the seeding path exists
					// only for rows created before the column did.
					messageSeq: 0,
					input: asJsonRecord(input.input ?? {}, "run input"),
					principal:
						input.principal === undefined
							? undefined
							: asPrincipal(input.principal),
					// WHERE this run's output belongs. Written HERE and nowhere else, because this
					// function enumerates the columns it writes and drops everything it was not told
					// about — the `team` failure the contracts comment turned into a review rule.
					clawId: input.recording?.clawId,
					threadId: input.recording?.threadId,
					originMessageId: input.recording?.originMessageId,
					// Fixed at birth: the run must be able to answer "which model, and was anyone there"
					// on a slice claimed long after the invocation that decided both is gone.
					model: input.model,
					runMode: input.runMode,
					createdAt: ts,
					updatedAt: ts,
				},
			});
		},

		async getRun(id) {
			return db.findOne({
				model: "run",
				where: [{ field: "id", value: id }],
			});
		},

		async listActiveForClaw({ clawId, principal }) {
			// The SAME list the terminal-write CAS pins on, deliberately — a status this file already
			// treats as "still has work ahead of it" is exactly the one revocation has to reach, and
			// two lists would drift in opposite directions. A new live status has to join
			// `NON_TERMINAL_RUN_STATUSES` to be handled anywhere in this store; that dependency exists
			// already and this does not add a second one.
			return db.findMany({
				model: "run",
				where: [
					{ field: "clawId", value: clawId },
					{ field: "principal", value: principal, connector: "AND" },
					{
						field: "status",
						value: [...NON_TERMINAL_RUN_STATUSES],
						operator: "in",
						connector: "AND",
					},
				],
			});
		},

		async updateRun(id, patch) {
			// The entity layer drops undefined + encodes JSON; the store owns updatedAt (input:false).
			return db.update({
				model: "run",
				where: [{ field: "id", value: id }],
				update: { ...patch, updatedAt: now() },
			});
		},

		async updateRunIfStatus(id, input) {
			// `in` over the allowed statuses, so the whole guard is one predicate and one round trip.
			// The adapter contract is that `update` returns the row or null when nothing matched, which
			// is what makes this a CAS rather than a read-then-write.
			return db.update({
				model: "run",
				where: [
					{ field: "id", value: id },
					{
						field: "status",
						value: [...input.from],
						operator: "in",
						connector: "AND",
					},
				],
				update: { ...input.patch, updatedAt: now() },
			});
		},

		async enqueueTask(input) {
			const ts = now();
			return db.create({
				model: "runtime_task",
				data: {
					id: input.id ?? newId(),
					runId: input.runId,
					kind: input.kind,
					status: "pending",
					payload: asJsonRecord(input.payload ?? {}, "task payload"),
					dueAt: input.dueAt ?? ts,
					attempt: 0,
					errorAttempt: 0,
					// 3, not 1. The single attempt was never a policy about retries — it was the only
					// thing standing between a lease lapse and a `runtime.run` task restarting its run
					// from the prompt. That is fixed; a genuine failure may now be retried.
					maxAttempts: input.maxAttempts ?? 3,
					retryDelayMs: input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
					createdAt: ts,
					updatedAt: ts,
				},
			});
		},

		async getTask(id) {
			return db.findOne({
				model: "runtime_task",
				where: [{ field: "id", value: id }],
			});
		},

		async claimDueTask(input) {
			await store.reapExpiredLeases();
			const ts = now();
			const candidates = await db.findMany({
				model: "runtime_task",
				where: pendingWhere(ts),
				sortBy: { field: "dueAt", direction: "asc" },
				limit: input.limit ?? 10,
			});
			for (const candidate of candidates) {
				const claimed = await attemptClaim(candidate, input, ts);
				if (claimed) return claimed;
			}
			return null;
		},

		async claimTask(taskId, input) {
			// A primary-key read, and that is the point: a scan can be widened or re-sorted by accident
			// into the cross-tenant bug above, a `findOne` by id cannot. `attemptClaim`'s CAS re-checks
			// `status = "pending"` and `dueAt <= now`, so a task that is leased, dead, or still inside a
			// `failTask` backoff yields null here exactly as it would to the drain.
			const candidate = await db.findOne({
				model: "runtime_task",
				where: [{ field: "id", value: taskId }],
			});
			if (!candidate) return null;
			return attemptClaim(candidate, input, now());
		},

		async heartbeatLease(input) {
			const lease = await db.findOne({
				model: "lease",
				where: [{ field: "id", value: input.leaseId }],
			});
			if (!lease) return null;
			if (lease.expiresAt <= now()) return null;
			if (lease.tokenHash !== hashText(input.leaseToken)) return null;
			const ts = now();
			const expiresAt = addMs(ts, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
			const tokenHash = hashText(input.leaseToken);
			const updated = await db.update({
				model: "lease",
				where: [
					{ field: "id", value: input.leaseId },
					{ field: "tokenHash", value: tokenHash, connector: "AND" },
					{ field: "expiresAt", value: ts, operator: "gt", connector: "AND" },
				],
				update: { expiresAt, lastHeartbeatAt: ts },
			});
			if (!updated) return null;
			await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: lease.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: input.leaseId, connector: "AND" },
					{ field: "workerId", value: lease.workerId, connector: "AND" },
				],
				update: { leasedUntil: expiresAt, updatedAt: ts },
			});
			return updated;
		},

		async completeTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			const row = await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: {
					status: "completed",
					...(input.output !== undefined
						? { output: asJsonRecord(input.output, "task output") }
						: {}),
					completedAt: ts,
					updatedAt: ts,
				},
			});
			if (!row) return null;
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: lease.id }],
			});
			return row;
		},

		async failTask(input) {
			const task = await store.getTask(input.taskId);
			if (!task) return null;
			const lease = await validateLease(task, input.leaseToken);
			if (!lease) return null;
			const ts = now();
			// This is a REAL failure, so it is the error counter that moves — and the error counter is
			// what `maxAttempts` bounds. A task that keeps being claimed and losing its lease is a
			// different story with a different limit (MAX_CLAIMS), told by the reaper.
			const errorAttempt = (task.errorAttempt ?? 0) + 1;
			const status: TaskStatus =
				errorAttempt >= task.maxAttempts ? "dead" : "pending";
			const row = await db.update({
				model: "runtime_task",
				where: [
					{ field: "id", value: input.taskId },
					{ field: "status", value: "leased", connector: "AND" },
					{ field: "leaseId", value: lease.id, connector: "AND" },
				],
				update: {
					status,
					errorAttempt,
					lastError: input.reason,
					dueAt:
						status === "pending" ? addMs(ts, task.retryDelayMs) : task.dueAt,
					leaseId: null,
					workerId: null,
					leasedUntil: null,
					updatedAt: ts,
				},
			});
			await db.delete({
				model: "lease",
				where: [{ field: "id", value: lease.id }],
			});
			return row;
		},

		async listActiveForThread(threadId) {
			return db.findMany({
				model: "run",
				where: [
					{ field: "threadId", value: threadId },
					{
						field: "status",
						value: [...NON_TERMINAL_RUN_STATUSES],
						operator: "in",
						connector: "AND",
					},
				],
				// NEWEST FIRST: a router steering a conversation wants the turn in flight now, and with
				// two live runs the later one is the one still gathering context.
				sortBy: { field: "createdAt", direction: "desc" },
			});
		},

		async adoptThreadInbox({ threadId, toRunId }) {
			// WHAT `at_turn_end` HAS ALWAYS PROMISED AND NEVER DELIVERED (hazard C6).
			//
			// Two ways a message ends up here. `at_turn_end` is wake fuel for the NEXT turn by
			// definition — `drainMessages` excludes it, and nothing else ever read it, so every one
			// written since the mode existed has sat `pending` forever. And a `next_step` message typed
			// while a turn was finishing is admitted, acknowledged, and then missed: the control point
			// is at the TOP of a step, so a message arriving after the last one has no step left to be
			// seen at.
			//
			// Both are the same shape — words somebody sent to this conversation that the run they
			// were addressed to will never read — and the answer is the same: the next run on the
			// thread takes them.
			//
			// PULLED at run start, not pushed at terminal transition, because at terminal time the next
			// run does not exist yet and there is nothing to re-admit onto. Pulling also means a
			// message admitted AFTER its run finished is still picked up, which a push would have
			// missed by minutes.
			//
			// ONLY FROM TERMINAL RUNS. A live sibling run's pending messages are its own — stealing
			// them would deliver one person's words to a turn they were not sent to.
			const priorRuns = await db.findMany({
				model: "run",
				where: [
					{ field: "threadId", value: threadId },
					{ field: "id", value: toRunId, operator: "ne", connector: "AND" },
					{
						field: "status",
						value: [...NON_TERMINAL_RUN_STATUSES],
						operator: "not_in",
						connector: "AND",
					},
				],
			});
			if (priorRuns.length === 0) return 0;
			const left = await db.findMany({
				model: "run_message",
				where: [
					{
						field: "toRunId",
						value: priorRuns.map((run) => run.id),
						operator: "in",
					},
					{ field: "status", value: "pending", connector: "AND" },
				],
				sortBy: { field: "seq", direction: "asc" },
			});
			let adopted = 0;
			for (const row of left) {
				// A NEW ROW ON THIS RUN, not a moved one: `toRunId` and `seq` are both `immutable`, and
				// the new run numbers its own inbox. The id is re-derived the way `admitMessage` derives
				// it, so a redelivery of the original message still loses at the database.
				const admittedAs = await store.admitMessage({
					id: messageRowId(toRunId, row.sender, row.id),
					toRunId,
					// `at_turn_end` MEANS "the next turn", and this IS the next turn — so it enters as
					// `next_step`. Adopted unchanged it would be excluded from the drain again by the
					// same rule that excluded it from the run it was sent to, and the message would
					// travel from turn to turn forever without ever being read.
					mode: row.mode === "at_turn_end" ? "next_step" : row.mode,
					body: row.body,
					sender: row.sender,
					...(row.containerKind !== undefined
						? { containerKind: row.containerKind }
						: {}),
					...(row.containerId !== undefined
						? { containerId: row.containerId }
						: {}),
				});
				if (!admittedAs.admitted) continue;
				// The original is retired so a THIRD run does not adopt it again. `dead` rather than
				// `delivered`: this run never showed it to a model, and a status that says otherwise
				// would make `deliveredAtStep` a lie.
				await db.update({
					model: "run_message",
					where: [
						{ field: "id", value: row.id },
						{ field: "status", value: "pending", connector: "AND" },
					],
					update: {
						status: "dead",
						lastError: `adopted by ${toRunId}`,
						updatedAt: now(),
					},
				});
				adopted++;
			}
			return adopted;
		},

		async pruneRuns({ clawId, before, limit }) {
			// TERMINAL AND OLD ENOUGH, in that order of importance. `updatedAt` is when the run last
			// moved, which for a finished run is when it finished — the engine writes it on every
			// transition and nothing touches it afterwards.
			const runs = await db.findMany({
				model: "run",
				where: [
					{ field: "clawId", value: clawId },
					{
						field: "status",
						value: [...terminalRunStatuses],
						operator: "in",
						connector: "AND",
					},
					{
						field: "updatedAt",
						value: before,
						operator: "lt",
						connector: "AND",
					},
					// NOT ALREADY SWEPT. The run row survives a prune, so without this the next call
					// selects the same runs, reports the same count, and "loop until 0" never
					// terminates — which a three-runs-two-at-a-time test caught.
					{ field: "prunedAt", value: "", connector: "AND" },
				],
				// OLDEST FIRST, which is what makes a bounded call composable: a host loops until the
				// count comes back 0, and each pass takes the next-oldest slice rather than re-scanning
				// the same page.
				sortBy: { field: "updatedAt", direction: "asc" },
				limit: limit ?? DEFAULT_PRUNE_LIMIT,
			});
			if (runs.length === 0) {
				return { runs: 0, events: 0, tasks: 0, messages: 0, runIds: [] };
			}
			const runIds = runs.map((run) => run.id);
			// COUNTED BY READING FIRST, because `deleteMany` reports nothing. An operator scheduling
			// this needs to know whether it is keeping up, and "it ran" is not that.
			const countOf = async (model: string, field: string): Promise<number> => {
				const rows = await db.findMany({
					model: model as "run_event",
					where: [{ field: field as "runId", value: runIds, operator: "in" }],
				});
				return rows.length;
			};
			const events = await countOf("run_event", "runId");
			const tasks = await countOf("runtime_task", "runId");
			const messages = await countOf("run_message", "toRunId");
			for (const [model, field] of [
				["run_event", "runId"],
				["runtime_task", "runId"],
				["run_message", "toRunId"],
			] as const) {
				await adapter.deleteMany?.({
					model,
					where: [{ field, value: runIds, operator: "in" }],
				});
			}
			// MARKED AFTER the deletes, so a crash in between leaves a run whose rows are partly gone
			// and which the next pass will finish. The reverse order would mark it done and leave the
			// remainder unreachable.
			for (const runId of runIds) {
				await db.update({
					model: "run",
					where: [{ field: "id", value: runId }],
					update: { prunedAt: now() },
				});
			}
			return { runs: runs.length, events, tasks, messages, runIds };
		},

		async maxMessageSeq(toRunId) {
			const rows = await db.findMany({
				model: "run_message",
				where: [{ field: "toRunId", value: toRunId }],
				sortBy: { field: "seq", direction: "desc" },
				limit: 1,
			});
			return rows[0]?.seq ?? 0;
		},

		async drainMessages({ toRunId, afterSeq, step, runAs }) {
			const rows = await db.findMany({
				model: "run_message",
				where: [
					{ field: "toRunId", value: toRunId },
					// NOT filtered on `pending`. A row is marked delivered BEFORE it reaches the in-memory
					// transcript, so a crash in that window leaves a message that is neither pending nor in
					// any transcript — invisible forever. `seq > afterSeq` where afterSeq is what the
					// transcript actually contains re-delivers exactly those and nothing else; `status`
					// stays as forensics.
					{ field: "seq", value: afterSeq, operator: "gt", connector: "AND" },
					// `at_turn_end` is wake fuel for the NEXT run on this conversation and never enters
					// this one. `interrupt` drains here too until it has teeth of its own — degrading to
					// "arrives at the next step" is honest; silently never arriving is not.
					{
						field: "mode",
						value: ["next_step", "interrupt"],
						operator: "in",
						connector: "AND",
					},
				],
				sortBy: { field: "seq", direction: "asc" },
			});
			const ts = now();
			const drained: { seq: number; body: JsonObject }[] = [];
			for (const row of rows) {
				// PER-SLICE AUTHORITY. A slice executes every tool call under ONE principal, resolved
				// once — so a message from anyone else cannot join it without lending them this run's
				// authority and signing the audit line with the wrong name. The drain STOPS here
				// instead: everything before this message is delivered, this one and everything after
				// it stay pending, and the slice hands over to a continuation that runs as the sender.
				//
				// Stopping rather than skipping is what keeps the run's own FIFO honest. Skipping would
				// reorder one person's messages around another's, and the order they were sent in is
				// the only order anybody can reason about.
				if (runAs !== undefined && row.sender !== runAs) {
					return { delivered: drained, handoverTo: row.sender };
				}
				// Pinned on `pending`: a second reader cannot exist by construction, but a retry of THIS
				// slice can, and marking an already-delivered row again would move its step.
				await db.update({
					model: "run_message",
					where: [{ field: "id", value: row.id }],
					update: { status: "delivered", deliveredAtStep: step, updatedAt: ts },
				});
				drained.push({ seq: row.seq, body: row.body });
			}
			return { delivered: drained };
		},

		async hasPendingInterrupt(runId) {
			const rows = await db.findMany({
				model: "run_message",
				where: [
					{ field: "toRunId", value: runId },
					{ field: "status", value: "pending", connector: "AND" },
					{ field: "mode", value: "interrupt", connector: "AND" },
				],
				limit: 1,
			});
			return rows.length > 0;
		},

		async admitMessage(input) {
			// THE BOUNCE AND THE SEQ ARE THE SAME WRITE. The obvious shape — read the run, check it is
			// not terminal, then insert — loses the race against a terminal transition committing in
			// another process, and both SQL adapters run the driver's default isolation, so nothing
			// prevents that interleave. The admit already has to touch the run row to mint `seq` under
			// `controlSeq`, so that conditional write IS the guard: a null return means the run went
			// terminal, and there is nothing to queue against a corpse.
			//
			// CAS-retry, not `col = col + 1`: the Adapter port takes literal values only, so a
			// read-modify-write would lose bumps whenever two messages are admitted at once.
			for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
				const run = await store.getRun(input.toRunId);
				if (!run) {
					throw stateError("no such run to deliver to", {
						toRunId: input.toRunId,
					});
				}
				// ABSENT IS NOT ZERO, and no predicate can say "absent": `eq null` compares against
				// `undefined` and is false, so a CAS pinned on `0` matches a legacy row not at all and
				// the retry loop spins to exhaustion. `createRun` writes 0 from birth; a row that
				// predates the column is normalized first and re-read, which two concurrent admits can
				// both do harmlessly because writing the same seed twice is the same as writing it once.
				//
				// SEEDED FROM THE ROWS, not from zero. This column was split out of `controlSeq`, and a
				// run that predates the split already has `run_message` rows numbered from that counter
				// — so seeding 0 would mint seq=1 onto an occupied slot, and the catch below treats any
				// conflict as a redelivery. A brand-new message would be acknowledged as already-seen
				// and silently dropped (C3).
				const stored = run.messageSeq;
				if (stored === undefined) {
					await db.update({
						model: "run",
						where: [{ field: "id", value: input.toRunId }],
						update: { messageSeq: await store.maxMessageSeq(input.toRunId) },
					});
					continue;
				}
				const current = stored;
				const seq = current + 1;
				const moved = await db.update({
					model: "run",
					where: [
						{ field: "id", value: input.toRunId },
						{ field: "messageSeq", value: stored, connector: "AND" },
						{
							field: "status",
							value: [...NON_TERMINAL_RUN_STATUSES],
							operator: "in",
							connector: "AND",
						},
					],
					update: { messageSeq: seq, updatedAt: now() },
				});
				if (!moved) {
					// Either the counter moved under us (retry) or the run finished (bounce). Only a
					// re-read can tell the two apart, and only the second is terminal.
					const after = await store.getRun(input.toRunId);
					const stillLive = (
						NON_TERMINAL_RUN_STATUSES as readonly string[]
					).includes(after?.status ?? "");
					if (after && !stillLive) {
						return {
							admitted: false,
							id: input.id,
							seq: 0,
							bounced: after.status,
						};
					}
					continue;
				}
				const ts = now();
				try {
					await db.create({
						model: "run_message",
						data: {
							id: input.id,
							toRunId: input.toRunId,
							mode: input.mode,
							body: input.body,
							...(input.containerKind !== undefined
								? { containerKind: input.containerKind }
								: {}),
							...(input.containerId !== undefined
								? { containerId: input.containerId }
								: {}),
							sender: input.sender,
							seq,
							status: "pending",
							createdAt: ts,
							updatedAt: ts,
						},
					});
				} catch (error) {
					// A REDELIVERY. The row is already there, which is the whole point of deriving the id
					// — rows are retained after delivery precisely so a repeat still looks known.
					if (!isConflict(error)) throw error;
					return { admitted: false, id: input.id, seq };
				}
				return { admitted: true, id: input.id, seq };
			}
			throw stateError("could not mint a message sequence under contention", {
				toRunId: input.toRunId,
			});
		},

		async deadLetterPendingTasks(runId, reason) {
			const ts = now();
			const pending = await db.findMany({
				model: "runtime_task",
				where: [
					{ field: "runId", value: runId },
					{ field: "status", value: "pending", connector: "AND" },
				],
			});
			let count = 0;
			for (const task of pending) {
				// Pinned on `pending`: a task a worker claimed between the read and here belongs to that
				// worker, and its own control point is what stops it.
				const updated = await db.update({
					model: "runtime_task",
					where: [
						{ field: "id", value: task.id },
						{ field: "status", value: "pending", connector: "AND" },
					],
					update: { status: "dead", lastError: reason, updatedAt: ts },
				});
				if (updated) count++;
			}
			return count;
		},

		async reapExpiredLeases() {
			const ts = now();
			const leaseRows = await db.findMany({
				model: "lease",
				where: [{ field: "expiresAt", value: ts, operator: "lte" }],
			});
			let count = 0;
			for (const candidate of leaseRows) {
				// R-M10. The lease used to be CONSUMED first — deleted — and the task transitioned after.
				// A process dying between those two left the task `leased` with a `leaseId` pointing at a
				// row that no longer existed: no lease left to expire, and the claim query only looks at
				// `pending`, so the task was stranded forever. Recovery state destroyed before the
				// successor state was durable, which is the whole shape of the finding.
				//
				// Reversed: the task transition goes first, under a compare-and-set on the lease it
				// names, and the lease row is dropped after. Dying in the middle now leaves a task that
				// is `pending` (claimable again) beside a stale lease row the next sweep collects —
				// recoverable litter instead of a permanent orphan.
				//
				// The CAS is what makes two concurrent reapers safe without consuming first: whichever
				// updates the task sets `leaseId: null`, so the other's `leaseId = <id>` predicate matches
				// nothing and it does no work. Deleting an already-deleted lease is a no-op either way.
				const reap = async (
					tx: typeof db,
				): Promise<false | { status: TaskStatus; runId: string }> => {
					const task = await tx.findOne({
						model: "runtime_task",
						where: [{ field: "id", value: candidate.taskId }],
					});
					if (!task) {
						// The task is gone; the lease is litter. Drop it so the sweep does not re-read it.
						await tx.delete({
							model: "lease",
							where: [{ field: "id", value: candidate.id }],
						});
						return false;
					}
					// A LAPSE, not a failure: the host vanished mid-claim and nothing was learned about
					// the work. So this bounds CLAIMS, and `errorAttempt` is left untouched — otherwise a
					// flapping worker spends a run's whole error budget without the run ever failing.
					const status: TaskStatus =
						task.attempt >= MAX_CLAIMS ? "dead" : "pending";
					const updated = await tx.update({
						model: "runtime_task",
						where: [
							{ field: "id", value: candidate.taskId },
							{ field: "status", value: "leased", connector: "AND" },
							{ field: "leaseId", value: candidate.id, connector: "AND" },
						],
						update: {
							status,
							lastError:
								status === "dead"
									? `abandoned after ${MAX_CLAIMS} claims without completing`
									: "lease expired",
							dueAt:
								status === "pending"
									? addMs(ts, task.retryDelayMs)
									: task.dueAt,
							leaseId: null,
							workerId: null,
							leasedUntil: null,
							updatedAt: ts,
						},
					});
					// Lost to another reaper, or the lease was renewed between the read and here. Either
					// way this one is not ours to retire, and the lease row is left for its real owner.
					if (!updated) return false;
					await tx.delete({
						model: "lease",
						where: [{ field: "id", value: candidate.id }],
					});
					// The RUN write is deliberately NOT done here. `store.updateRun` goes through the
					// outer, non-transactional db, and issuing it from inside `db.transaction(reap)`
					// means an adapter with real isolation can lose or reorder it — which left a run
					// `running` forever after its task had been abandoned. Report the outcome instead
					// and let the caller write it once the transaction has actually committed.
					return { status, runId: task.runId };
				};
				// Atomic where the adapter can be; ordered-and-recoverable where it cannot.
				const reaped = db.transaction
					? await db.transaction(reap)
					: await reap(db);
				if (!reaped) continue;
				count++;
				// Claims exhausted, and only that: a requeue leaves the run alone, because "the host
				// vanished" is not a verdict on the work.
				if (reaped.status === "dead") {
					await store.updateRunIfStatus(reaped.runId, {
						from: ["queued", "running", "waiting"],
						patch: { status: "failed" },
					});
				}
			}
			return count;
		},

		async appendEvent(input) {
			return db.create({
				model: "run_event",
				data: {
					id: newId(),
					runId: input.runId,
					type: input.type,
					payload: asJsonRecord(input.payload ?? {}, "event payload"),
					createdAt: now(),
				},
			});
		},

		async events(runId) {
			return db.findMany({
				model: "run_event",
				where: [{ field: "runId", value: runId }],
				sortBy: { field: "createdAt", direction: "asc" },
			});
		},

		requestHash(body) {
			return hashText(stringifyJson(body, "request body"));
		},

		async getIdempotency(input) {
			// The id IS the hash of the scope tuple (key/method/path/scope/scopeId/principal), so a
			// primary-key lookup is exactly the scoped match — and it sidesteps `WHERE col = NULL` (never
			// true in SQL, and undefined !== null in the memory adapter) for absent organization/principal.
			const record = await db.findOne({
				model: "idempotency_key",
				where: [{ field: "id", value: idempotencyId(input) }],
			});
			if (!record) return null;
			if (record.requestHash !== input.requestHash) {
				throw stateError(
					"idempotency key reused with a different request body",
					{
						key: input.key,
						method: input.method,
						path: input.path,
					},
				);
			}
			return record;
		},

		async saveIdempotency(input) {
			const existing = await store.getIdempotency(input);
			if (existing) return existing;
			try {
				return await db.create({
					model: "idempotency_key",
					data: {
						id: idempotencyId(input),
						key: input.key,
						method: input.method,
						path: input.path,
						scope: input.scope,
						scopeId: input.scopeId,
						principal: input.principal,
						requestHash: input.requestHash,
						responseStatus: input.responseStatus,
						responseBody: asJsonRecord(input.responseBody, "response body"),
						createdAt: now(),
					},
				});
			} catch (err) {
				const raced = await store.getIdempotency(input);
				if (raced) return raced;
				throw err;
			}
		},
	};

	return store;
}
