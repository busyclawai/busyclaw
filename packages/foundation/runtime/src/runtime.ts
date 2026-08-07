import type {
	ApprovalStore,
	AuditSink,
	BusyclawPlugin,
	CapabilityContext,
	EffectStore,
	InferContext,
	JsonObject,
	JsonValue,
	Principal,
	Redactor,
	RunCheckpointStore,
	RunMode,
	TextDeltaStream,
	ToolDefinitionSet,
	ToolEffectPolicy,
} from "@busyclaw/contracts";
import {
	APPROVED_BY_CONTEXT_KEY,
	asPrincipal,
	BusyclawError,
	CLAW_ID_CONTEXT_KEY,
	configurationError,
	jsonValue as jsonValueSchema,
	PII_CONTAINER_ID_CONTEXT_KEY,
	PII_CONTAINER_KIND_CONTEXT_KEY,
	RESERVED_CONTEXT_PREFIX,
	RUN_ID_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	redactionContextFrom,
	stampRunActions,
	stateError,
	THREAD_ID_CONTEXT_KEY,
	toolDescriptors,
	toolModelName,
	UNSCOPED,
	validationError,
} from "@busyclaw/contracts";
import { createGovernance, type Governance } from "@busyclaw/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ModelMessage, wrapLanguageModel } from "ai";
import { type as ark } from "arktype";
import {
	aiSdkLoop,
	governanceToolResult,
	type ModelLoopVendor,
	toolResultMessage,
} from "./ai-sdk-loop";
import {
	type RunAuthority,
	resolveRunAuthority,
	sameConfigScope,
	stampAuthority,
} from "./authority";
import {
	createToolCatalog,
	type ToolCatalog,
	toolEntriesFromTools,
} from "./catalog";
import {
	type ConfigScopeResolver,
	composeContext,
	type IdentityResolver,
	type MembershipResolver,
	type SubjectResolver,
} from "./context";
import {
	createRuntimeEvent,
	emitRuntimeEvent,
	eventSinksFrom,
	RUNTIME_CLAW_OPTION,
	RUNTIME_RECORDING_OPTION,
	type RuntimeEventFanout,
	type RuntimeEventPayloadInput,
	type RuntimeEventSink,
	type RuntimeModelUsage,
	type RuntimeRecordingContext,
	runtimeRecordingContext,
} from "./events";
import {
	ABORTED_DETAIL,
	abortIfNeeded,
	createRunState,
	type RunState,
} from "./run-state";
import {
	NESTED_APPROVAL_UNSUPPORTED,
	NESTED_EFFECT_UNSUPPORTED,
	NESTED_INVOKER_TOOL,
	type SubInvoke,
} from "./subinvoke";
import {
	DISCOVERY_TOOL_PATHS,
	discoveryTools,
	type ModelToolProjection,
	modelToolProjection,
	registerToolGates,
	SEARCH_TOOL_PATH,
	type ToolAccessProbe,
	toolExecutor,
} from "./tools";

export type RuntimeModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/** One entry in a routing pool: a model directly, or a descriptor carrying tags, a default flag, and
 *  an opt-out of PII redaction (for a local/trusted model that may receive raw values). */
export type ModelPoolEntry =
	| RuntimeModel
	| {
			readonly model: RuntimeModel;
			readonly tags?: readonly string[];
			readonly default?: boolean;
			/**
			 * When true, runs that select this model SKIP PII redaction entirely — the model receives
			 * raw values, and (the flip side) nothing is tokenized, so durable state for those runs is
			 * unredacted and therefore NOT per-subject erasable. Intended for a local/on-prem model
			 * where third-party egress is not a concern. A no-op when the runtime has no redactor.
			 */
			readonly noPiiRedaction?: boolean;
	  };

/** A named pool of models for task-based routing — keys are the selectable names. */
export type ModelPool = Record<string, ModelPoolEntry>;

/**
 * The model names selectable at run() for a given config: the pool's literal keys, or `never` for a
 * single-`model` config (so `run({ model })` isn't offered at all — you can't over-specify). The
 * `<const Config>` capture at createRuntime/createClaw is what makes these keys literal.
 */
export type ModelName<Config> = Config extends { models: infer Pool }
	? Extract<keyof Pool, string>
	: never;

type IsUnion<T, U = T> = [T] extends [never]
	? false
	: T extends U
		? [U] extends [T]
			? false
			: true
		: false;

type HasDefaultModel<Config> = Config extends { models: infer Pool }
	? true extends {
			[K in keyof Pool]: Pool[K] extends { default: true } ? true : false;
		}[keyof Pool]
		? true
		: false
	: false;

/**
 * The `model` shape for a config's run inputs: absent (`never`) for a single-`model` config;
 * REQUIRED when the pool has ≥2 entries and no `default` (the caller must ask); optional when a
 * `default` exists or the pool has one entry. Applied at the user-facing api boundary — the internal
 * {@link RunOptionsFor} keeps `model` optional so generic plumbing stays assignable.
 */
export type ModelSelection<Config> = [ModelName<Config>] extends [never]
	? { model?: never }
	: HasDefaultModel<Config> extends true
		? { model?: ModelName<Config> }
		: IsUnion<ModelName<Config>> extends true
			? { model: ModelName<Config> }
			: { model?: ModelName<Config> };

/** True when a run MUST name a `model`: the pool has ≥2 entries and no `default`. Lets the api make
 *  `options`/`model` a required input in exactly that case. */
export type RequiresExplicitModel<Config> = [ModelName<Config>] extends [never]
	? false
	: HasDefaultModel<Config> extends true
		? false
		: IsUnion<ModelName<Config>>;

export type RuntimeAbortSignal = { readonly aborted: boolean };

/**
 * The authenticated caller's principal, threaded server-side into a run so the trusted context
 * assembly can SEED it as `busyclaw__principal`. A `unique symbol` key (like {@link
 * RUNTIME_RECORDING_OPTION}) so it is forge-proof: a JSON/wire `options` object can never carry it —
 * only trusted host code that imports the symbol (the api handlers, via {@link
 * runtimeRunOptionsWithCaller}) sets it. NEVER a plain field a caller could smuggle through the
 * `generate`/`stream` options pass-through.
 */
export const RUNTIME_CALLER_OPTION: unique symbol = Symbol(
	"busyclaw.runtime.caller",
);

/**
 * How the runtime asks whether somebody wants this run stopped. One function, because the loop has
 * no business knowing where intents are stored or what else they could say — it learns only the park
 * reason, and the engine owns everything behind that.
 */
/** What one look outward found. `seq` is the run's control watermark as of this read — the loop
 *  hands it back next time so the port can skip the message query entirely when nothing moved. */
/** One drained message: what the model sees, and where it sits in the run's order. The `seq` is
 *  what the transcript watermark advances to once the message is actually pushed. */
export type RunInboxDelivery = { seq: number; message: ModelMessage };

/**
 * WHY a slice stops when the engine says so. `handover` is not a park in the user-visible sense —
 * nobody asked for the run to stop — it is the run changing WHOSE authority it executes under,
 * which can only happen at a slice boundary because authority is resolved once per slice. It leaves
 * a continuation behind, exactly like a deadline yield, and differs only in who the continuation
 * runs as. The loop is told nothing about principals; the engine remembers who.
 */
export type RunStopReason = RunParkReason | "handover";

export type RunControlVerdict = {
	seq: number;
	park?: RunStopReason;
	/** Already-tokenized message bodies, in the run's own order. */
	deliver?: RunInboxDelivery[];
};

/** What the ENGINE answers. Deliberately not `ModelMessage`: the engine stores bodies and knows
 *  nothing about how a model is addressed, and teaching it would drag the AI SDK into a package
 *  whose whole job is rows. The runtime shapes them on the way through. */
export type RunControlPort = {
	poll: (
		runId: string,
		seenSeq: number,
		deliveredThrough: number,
	) => Promise<{
		seq: number;
		park?: RunStopReason;
		deliver?: readonly { seq: number; body: Record<string, unknown> }[];
	}>;
	/** Register a way to cancel the model call about to happen. Re-registered every step, because an
	 *  AbortController fires once and the step after an interrupt must be interruptible too. */
	armInterrupt?: (runId: string, fire: () => void) => void;
};

export type RuntimeRunOptions = {
	abortSignal?: RuntimeAbortSignal;
	/** Durable run identity (engine run id) — scopes effect ids and events across attempts/slices. */
	runId?: string;
	/**
	 * Invocation soft deadline (ISO timestamp). Past it, the loop parks a yield checkpoint at the
	 * next end-of-tool-result and returns `yielded` instead of continuing. Requires a
	 * database-backed run checkpoint store.
	 *
	 * A FUNCTION means "ask me again each step", which is how a departing reader ends a slice: the
	 * caller returns its invocation budget while somebody is reading and `now()` once nobody is. A
	 * captured scalar cannot express that, because departure happens while the loop is inside a model
	 * call. Server-side only, like the rest of these — a caller-chosen deadline is a caller-chosen
	 * yield, so the api's serialized option schema omits it either way.
	 */
	deadlineAt?: string | (() => string | undefined);
	/** How this run was triggered — set by the ENTRY POINT (busyclaw's sendMessage/continueRun stamp
	 *  "interactive"; the engine worker and direct calls leave it unset). Stamped into every gated
	 *  call as the spoof-proof `busyclaw__runMode` fact. Default "autonomous" — fail-closed, so an
	 *  unattended run can't silently satisfy a write policy that a human presence would gate. */
	runMode?: RunMode;
	/**
	 * The durable control seam, polled once per step. Bound by the ENGINE for every slice including a
	 * resumed one — never by whichever ingress started the run, because the intent outlives the
	 * process that received it. Server-side only: deliberately absent from the api's serialized
	 * option schema, exactly like `deadlineAt` and `runId`.
	 */
	control?: RunControlPort;
	/**
	 * Reports the boundary this slice actually resolved, so the engine can record it on the run row.
	 *
	 * Server-side only, and deliberately a CALLBACK rather than a field on `RuntimeResult`: it fires
	 * whether or not the slice reaches a terminal result, and widening a four-variant union validated
	 * at three boundaries for one consumer would be the worse trade.
	 */
	onAuthorityResolved?: (boundary: { scope: string; scopeId: string }) => void;
	readonly [RUNTIME_RECORDING_OPTION]?: RuntimeRecordingContext;
	/** The claw an UNRECORDED run belongs to — see {@link runtimeRunOptionsWithClaw}. */
	readonly [RUNTIME_CLAW_OPTION]?: string;
	/** The authenticated caller principal — set only via {@link runtimeRunOptionsWithCaller} (symbol
	 *  key, forge-proof). Seeded as `busyclaw__principal` by the trusted context assembly. */
	readonly [RUNTIME_CALLER_OPTION]?: Principal;
};

/**
 * run() options for a given config: the base options plus `model` — the name of a pool entry to run
 * this turn, narrowed to THIS config's literal pool keys (`never` for a single-`model` config, so
 * the option can't be passed at all). `model` lives ONLY here, not on the base, so a plain
 * `RuntimeRunOptions` (the internal plumbing passes these around) stays assignable.
 */
export type RunOptionsFor<Config> = RuntimeRunOptions & {
	model?: ModelName<Config>;
};

export type RuntimeEnvironment = {
	now?: () => string;
	newId?: (prefix: string) => string;
};

export function defaultRuntimeNewId(prefix: string): string {
	return `${prefix}_${bytesToHex(randomBytes(16))}`;
}

export type RuntimeConfig = {
	/** The single model — the shorthand most runtimes use. Mutually exclusive with `models`; exactly
	 *  one of the two must be present (enforced at construction, and at compile time by createClaw). */
	model?: RuntimeModel;
	/** A named pool of models for task-based routing, selected per run via `run(…, { model })`. One
	 *  entry is the default (`default: true`, or the sole entry). Mutually exclusive with `model`. */
	models?: ModelPool;
	/** The model-loop vendor — how the LLM is driven. Default: the AI SDK's `generateText` loop.
	 *  Swap for a different SDK or a streaming-capable vendor. */
	loop?: ModelLoopVendor;
	/** The host's tools as canonical DESCRIPTORS (`tool()` / `govern()`) — governance is a field the
	 *  compiler checks, not a passenger inside the AI-SDK type. The record key is each tool's PATH
	 *  (its canonical id); the model-facing `ToolSet`, keyed by the flattened wire name, is derived. */
	tools?: ToolDefinitionSet;
	/** Resolve extra tools for THIS run (a boundary's registered tools) from the resolved turn
	 *  context, merged over the static `tools` ONCE per run. Code tools win collisions — a
	 *  host tool is never shadowed by a registered upload; a colliding registered tool is skipped,
	 *  never silently substituted. Registrations are rare and decisions hot, so the merge is per-run,
	 *  not per tool call. */
	resolveTools?: (
		ctx: Record<string, unknown>,
	) => ToolDefinitionSet | Promise<ToolDefinitionSet>;
	system?: string;
	redactor?: Redactor;
	configScope?: ConfigScopeResolver;
	identity?: IdentityResolver;
	membership?: MembershipResolver;
	/** Whose personal data this turn is about — the erasure key every mapping minted during it links
	 *  to. Without one, ordinary redaction mints mappings linked to NOBODY and `forgetSubject` answers
	 *  successfully having found nothing. See {@link SubjectResolver}. */
	subject?: SubjectResolver;
	audit?: AuditSink;
	/**
	 * Whose authority an APPROVED action executes under when the run resumes — the escalation semantic.
	 * It is read from the IMMUTABLE {@link ApprovalRecord}, never from whoever calls `continueRun`
	 * (that was an unenforced convention: any caller could pick the executing identity).
	 *
	 * - `"requester"` (default) — ATTEST: the action stays the requester's and the approver only
	 *   vouches for it. Fail-safe, because approving never lends authority: a requester who lacks
	 *   permission is still denied by every gate the approval did not satisfy.
	 * - `"approver"` — ASSUME: the approver LENDS their authority (four-eyes escalation), so an action
	 *   the requester may NOT perform executes because the approver may. This is the setting for
	 *   "request something above your permissions and have someone entitled sign it off".
	 *
	 * Either way the audit records BOTH parties — `principal` (who it ran as) and `decidedBy` (who
	 * approved) — so a lent authority is never silent. Approval still bypasses only the ONE gate that
	 * demanded it, so this can never manufacture access the executing principal lacks elsewhere.
	 */
	approvalAuthority?: "requester" | "approver";
	effectStore?: EffectStore;
	/** The durable approval store. SUPPLIED, never defaulted — absent means nothing can park on an
	 *  approval. Same shape as {@link RuntimeConfig.effectStore}. */
	approvalStore?: ApprovalStore;
	/** The durable checkpoint store. SUPPLIED, never defaulted — absent means the loop cannot yield,
	 *  which `assertYieldable` refuses loudly rather than silently running past a deadline.
	 *
	 *  Its clock must be the SAME one this runtime uses (`environment.now`), or a checkpoint's
	 *  timestamps drift from the run that wrote them. The assembly builds both from one value. */
	checkpoints?: RunCheckpointStore;
	/** How long a resume's execution lease lasts, in ms. Default 15 minutes — see
	 *  {@link APPROVAL_LEASE_MS} for why that is deliberately generous. The keepalive renews it at a
	 *  third of this, so lowering it makes both the beat and the recovery window shorter together. */
	approvalLeaseMs?: number;
	effectLeaseTtlMs?: number;
	environment?: RuntimeEnvironment;
	/** Observer sinks (telemetry): awaited in order per event, but isolated — a throwing observer
	 *  is swallowed and reported via `warn`, never failing the run. */
	events?: RuntimeEventSink | readonly RuntimeEventSink[];
	/** The load-bearing recording sink (at most one, assembly-internal): awaited FIRST for every
	 *  event, and its failures PROPAGATE — a run that cannot persist its transcript
	 *  (tool_call/tool_result/message rows) must fail. */
	recording?: RuntimeEventSink;
	/** The single operator-notice door — observer-sink failures, tool-name collisions, and (via the
	 *  assembly) redaction/secrets boot warnings all route here; NOT a logger (no levels, no
	 *  structure, no transport). Default `console.warn`. */
	warn?: (message: string) => void;
	plugins?: readonly BusyclawPlugin[];
	maxSteps?: number;
	/**
	 * Named capabilities a `capability`-stamped tool receives, built fresh for each call.
	 *
	 * ONE GENERIC SEAM rather than a third bespoke one. `subInvoke` and `probeAccess` are each wired
	 * in by name at the same injection site; a fourth tenant would be a fourth conditional, and the
	 * thing after that a fifth. A tool declares which capability it wants
	 * (`govern(tool, { capability: "agent" })`), the host registers a factory under that name, and
	 * the runtime hands over exactly what was asked for and nothing else.
	 *
	 * The factory runs PER CALL, not at assembly, which is what dissolves the construction-order
	 * problem for anything that needs the fully-built claw: the capability can close over a slot its
	 * own plugin fills later.
	 */
	capabilities?: Record<string, (ctx: CapabilityContext) => unknown>;
};

/**
 * How long a resume holds an approval before a recovery may re-take it.
 *
 * Generous on purpose: the lease has to outlast the SLOWEST legitimate resume, because the failure it
 * guards is a runner that died, and the failure it would CAUSE if set too short is a second execution
 * of a tool that was merely slow. Erring long costs a delayed recovery; erring short costs a duplicate
 * side effect.
 */
const APPROVAL_LEASE_MS = 15 * 60 * 1000;

const ApprovalIds = ark("string").array();

export const RuntimeCompletedResult = ark({
	status: "'completed'",
	text: "string",
	steps: "number",
});
export type RuntimeCompletedResult = typeof RuntimeCompletedResult.infer;

export const RuntimeWaitingApprovalResult = ark({
	status: "'waiting_approval'",
	text: "string",
	steps: "number",
	"approvalIds?": ApprovalIds.or("undefined"),
});
export type RuntimeWaitingApprovalResult =
	typeof RuntimeWaitingApprovalResult.infer;

export const RuntimeDeniedResult = ark({
	status: "'denied'",
	text: "string",
	steps: "number",
	approvalId: "string",
	"decidedBy?": "string | undefined",
	"reason?": "string | undefined",
	"reasonCode?": "string | undefined",
});
export type RuntimeDeniedResult = typeof RuntimeDeniedResult.infer;

export const RuntimeYieldedResult = ark({
	status: "'yielded'",
	/**
	 * WHAT THE ASSISTANT SAID IN THIS SLICE, and it is the whole reason this field is not `''`.
	 *
	 * A turn that yields mid-answer used to report nothing, so the transcript ended in mid-air and a
	 * reader watching the stream saw text arrive and then a `finish` that meant "gone", not "done".
	 * The words were produced, paid for, and shown — dropping them at the slice boundary loses the
	 * only record that they happened.
	 */
	text: "string",
	steps: "number",
	checkpointId: "string",
});
export type RuntimeYieldedResult = typeof RuntimeYieldedResult.infer;

/**
 * The run stopped because an external actor asked it to, at the first control point it reached.
 *
 * A DISTINCT variant rather than a reused `yielded`, because the discriminator this union exists for
 * is *what the worker must do next*: a yield self-enqueues its continuation, a park enqueues nothing
 * and writes `waiting`. Reusing `yielded` and having the worker consult the latch would also make
 * the checkpoint envelope say "yield" when the truth is "suspended" — a lie inside an `immutable`
 * column that every later reader inherits.
 */
/** Why a run stopped when somebody else asked it to. `stopped` is terminal; `suspended` is not. */
export const RunParkReason = ark("'suspended' | 'stopped'");
export type RunParkReason = typeof RunParkReason.infer;

export const RuntimeParkedResult = ark({
	status: "'parked'",
	/** Same as the yield's, for the same reason — see `RuntimeYieldedResult.text`. This was the
	 *  literal `''`, which made "the assistant said nothing" and "we threw away what it said"
	 *  indistinguishable at the type level. */
	text: "string",
	steps: "number",
	checkpointId: "string",
	reason: RunParkReason,
});
export type RuntimeParkedResult = typeof RuntimeParkedResult.infer;

/**
 * The run stopped to WAIT ON SOMETHING OUTSIDE ITSELF, and only that thing can wake it.
 *
 * The fifth way a run can stop, and the first whose waker is not part of this system. An approval
 * waits on a person, a yield waits on the clock, a park waits on an operator — each has a door that
 * already knows how to resume it. This one waits on a `waitId` some other subsystem holds, and it
 * enqueues NOTHING: no continuation task, no due row, nothing a drain could pick up. A run in this
 * state costs a row and no scheduler attention until somebody says the wait is over.
 *
 * That is the whole point and also the whole danger. A waiter nobody wakes is a run that never ends,
 * so whoever creates the wait owns a deadline for it — this type deliberately does not carry one,
 * because a deadline the RUNTIME enforced would be a second timer beside the one the waiting
 * subsystem already needs.
 *
 * `waitId` is opaque here. The runtime never interprets it; it is the token the waker presents.
 */
export const RuntimeAwaitingResult = ark({
	status: "'awaiting'",
	/** What the model had said before it stopped — same reason as the yield's and the park's. */
	text: "string",
	steps: "number",
	/** The transcript to resume from, exactly as a yield leaves one. */
	checkpointId: "string",
	/** The token whoever is being waited on will present to wake this run. Opaque to the runtime. */
	waitId: "string",
});
export type RuntimeAwaitingResult = typeof RuntimeAwaitingResult.infer;

export const RuntimeResult = RuntimeCompletedResult.or(
	RuntimeWaitingApprovalResult,
)
	.or(RuntimeDeniedResult)
	.or(RuntimeYieldedResult)
	.or(RuntimeParkedResult)
	.or(RuntimeAwaitingResult);
export type RuntimeResult = typeof RuntimeResult.infer;

export type RunContext<Config extends RuntimeConfig> = InferContext<Config>;

export type Runtime<Config extends RuntimeConfig = RuntimeConfig> = {
	generate: (
		prompt: string,
		ctx?: RunContext<Config>,
		options?: RunOptionsFor<Config>,
	) => Promise<RuntimeResult>;
	/** Stream the model's text to the reader while the run happens. Deltas carry what the TRANSCRIPT
	 *  carries — redacted, placeholders intact (R-M04); originals come from one audited `listMessages`
	 *  read of the finished value. Requires a streaming loop vendor. */
	stream: (
		prompt: string,
		ctx?: RunContext<Config>,
		options?: RunOptionsFor<Config>,
	) => RuntimeStream;
	continueRun: (
		id: string,
		ctx?: RunContext<Config>,
		options?: RunOptionsFor<Config>,
	) => Promise<RuntimeResult | null>;
	/** Resume a yielded run from its checkpoint (consume-once). Null when absent/consumed. */
	resumeRun: (
		checkpointId: string,
		ctx?: RunContext<Config>,
		options?: RunOptionsFor<Config>,
	) => Promise<RuntimeResult | null>;
	readonly audit?: AuditSink;
	readonly approvals?: ApprovalStore;
	/** The durable checkpoint store, exposed for the SAME reason `approvals` is: a door that wants to
	 *  advance a parked run has to be able to read the record's own `runId` rather than trust the one
	 *  the caller supplied. Undefined without a database — nothing can park, so nothing can resume. */
	readonly checkpoints?: RunCheckpointStore;
	readonly effects?: EffectStore;
	/** The tool catalog read-path over this runtime's registered tools:
	 *  traversable tree (list), scoped search, and describe. Visibility only —
	 *  calling a tool still routes through the governance chokepoint. */
	readonly catalog: ToolCatalog;
};

/**
 * Name the claw an UNRECORDED run belongs to.
 *
 * A symbol, like the recording and the caller, and forge-proof for the same reason: a JSON or wire
 * `options` object cannot carry one. What it names is the run's authz parent and the fact a policy
 * reads, so a caller who could set it would be choosing which claw's rules apply to them.
 */
export function runtimeRunOptionsWithClaw(
	options: RuntimeRunOptions | undefined,
	clawId: string,
): RuntimeRunOptions {
	return { ...(options ?? {}), [RUNTIME_CLAW_OPTION]: clawId };
}

export function runtimeRunOptionsWithRecording(
	options: RuntimeRunOptions | undefined,
	recording: RuntimeRecordingContext,
): RuntimeRunOptions {
	return { ...(options ?? {}), [RUNTIME_RECORDING_OPTION]: recording };
}

/**
 * Attach the authenticated caller principal to a run's options via the forge-proof {@link
 * RUNTIME_CALLER_OPTION} symbol — the ONE way the entry point (an api handler, a trusted host call)
 * threads "who initiated this run" into the runtime so the trusted assembly seeds `busyclaw__principal`.
 * ALWAYS overrides any inbound value (so a caller-supplied `options` can never smuggle a principal
 * through the `generate`/`stream` pass-through); `undefined` clears it, leaving the run caller-less
 * (the `identity` resolver / a system principal then covers it).
 */
export function runtimeRunOptionsWithCaller(
	options: RuntimeRunOptions | undefined,
	principal: Principal | undefined,
): RuntimeRunOptions {
	return { ...(options ?? {}), [RUNTIME_CALLER_OPTION]: principal };
}

function stripReserved(ctx: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(ctx)) {
		if (!key.startsWith(RESERVED_CONTEXT_PREFIX)) out[key] = value;
	}
	return out;
}

function hashEffectInput(value: unknown): string {
	return bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
}

function errorPayload(err: unknown): Record<string, unknown> {
	return err instanceof Error
		? { name: err.name, message: err.message }
		: { message: String(err) };
}

async function redactedErrorPayload(input: {
	err: unknown;
	redactor?: Redactor;
	ctx: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const payload = errorPayload(input.err);
	return input.redactor
		? input.redactor.redactValue(payload, redactionContextFrom(input.ctx))
		: payload;
}

function toJsonValue(value: unknown, label: string): JsonValue {
	let parsed: unknown;
	try {
		const json = JSON.stringify(value);
		if (typeof json !== "string") {
			throw validationError(label, "must be JSON-serializable");
		}
		parsed = JSON.parse(json) as unknown;
	} catch (err) {
		if (err instanceof Error && err.name === "BusyclawError") throw err;
		throw validationError(
			label,
			err instanceof Error ? err.message : String(err),
		);
	}
	const valid = jsonValueSchema(parsed);
	if (valid instanceof ark.errors) {
		throw validationError(label, valid.summary);
	}
	return valid;
}

function effectOutputMode(
	policy: ToolEffectPolicy | undefined,
): "none" | "redacted" | "full" {
	return (
		policy?.output ?? (policy?.idempotency === "none" ? "none" : "redacted")
	);
}

function combinedAbortSignal(
	first: RuntimeAbortSignal | undefined,
	second: RuntimeAbortSignal | undefined,
): RuntimeAbortSignal | undefined {
	if (!first) return second;
	if (!second) return first;
	// Two PLATFORM signals combine into a platform signal, so the pair keeps reaching the model
	// vendor's `fetch` — aborting cancels the request rather than only tripping the loop's next
	// cooperative check. A hand-rolled `{ aborted }` on either side (the shim below, a caller's own)
	// cannot be combined that way, so those fall back to polling both.
	if (
		typeof AbortSignal !== "undefined" &&
		typeof AbortSignal.any === "function" &&
		first instanceof AbortSignal &&
		second instanceof AbortSignal
	) {
		return AbortSignal.any([first, second]);
	}
	return {
		get aborted() {
			return first.aborted || second.aborted;
		},
	};
}

/**
 * A runtime-owned abort source, combined into the caller's own signal. Two of them exist: a lost
 * effect lease (the heartbeat found the row gone) and a departed stream reader. Prefers the platform
 * `AbortController` when there is one — a real `AbortSignal` satisfies {@link RuntimeAbortSignal}
 * structurally AND reaches the model vendor's `fetch`, so aborting there cancels the HTTP request
 * rather than only tripping the loop's next cooperative check.
 */
type RuntimeAbortController = {
	signal: { aborted: boolean };
	abort: () => void;
};

function createRuntimeAbortController(): RuntimeAbortController {
	const Controller = (
		globalThis as { AbortController?: new () => RuntimeAbortController }
	).AbortController;
	if (Controller) return new Controller();
	const signal = { aborted: false };
	return {
		signal,
		abort: () => {
			signal.aborted = true;
		},
	};
}

function startEffectHeartbeat(input: {
	store: EffectStore;
	effectId: string;
	leaseToken: string;
	leaseTtlMs?: number;
	now: () => string;
	abortController: RuntimeAbortController;
}): () => void {
	const ttl = input.leaseTtlMs ?? 60_000;
	const intervalMs = Math.max(250, Math.floor(ttl / 2));
	const timers = globalThis as typeof globalThis & {
		setInterval: (fn: () => void, ms: number) => { unref?: () => void };
		clearInterval: (timer: unknown) => void;
	};
	let stopped = false;
	const timer = timers.setInterval(() => {
		void input.store
			.heartbeat({
				id: input.effectId,
				leaseToken: input.leaseToken,
				leaseTtlMs: input.leaseTtlMs,
				now: input.now(),
			})
			.then((record) => {
				if (!record && !stopped) input.abortController.abort();
			})
			.catch(() => {
				if (!stopped) input.abortController.abort();
			});
	}, intervalMs) as { unref?: () => void };
	timer.unref?.();
	return () => {
		if (stopped) return;
		stopped = true;
		timers.clearInterval(timer);
	};
}

/**
 * Keep a resume's approval lease alive while it works, and stop it the moment the lease is gone.
 *
 * A resume took ONE fixed lease and never said "still here", so a slow tool or model tail outlived it
 * and a second runner took over work that was never stuck. `complete` can only detect that afterwards
 * — by then both runners have executed. This is the half that prevents it. R-H08.
 *
 * Mirrors {@link startEffectHeartbeat}, including why a failed beat aborts: an infrastructure error is
 * not proof the lease is HELD, and continuing on that assumption is the same duplicate execution by a
 * different route.
 */
function startApprovalHeartbeat(input: {
	store: ApprovalStore;
	approvalId: string;
	leaseId: string;
	leaseMs: number;
	abortController: RuntimeAbortController;
	onLost: () => void;
}): () => void {
	const intervalMs = Math.max(250, Math.floor(input.leaseMs / 3));
	const timers = globalThis as typeof globalThis & {
		setInterval: (fn: () => void, ms: number) => { unref?: () => void };
		clearInterval: (timer: unknown) => void;
	};
	let stopped = false;
	const lost = () => {
		if (stopped) return;
		input.onLost();
		input.abortController.abort();
	};
	const timer = timers.setInterval(() => {
		void input.store
			.heartbeat(input.approvalId, input.leaseId, input.leaseMs)
			.then((record) => {
				if (!record) lost();
			})
			.catch(lost);
	}, intervalMs) as { unref?: () => void };
	timer.unref?.();
	return () => {
		if (stopped) return;
		stopped = true;
		timers.clearInterval(timer);
	};
}

const runtimeModelMessage = ark({ role: "string", content: "unknown" }).narrow(
	(value): value is ModelMessage => value.role.length > 0,
);

// The shared resume state every wait kind persists: the REDACTED transcript view, the run's own id,
// and the recording identity to restore. Approval metadata adds the parked tool call; yield metadata
// adds the next step. See docs/plans/yield-continuation-plan.md (wait taxonomy).
//
// `runId` is the CORRELATION key, and it is here rather than only inside `recording` because an
// ad-hoc `generate` has no recording at all — no claw, no thread — and would otherwise park a row a
// host could tie to nothing. Every run carries one (the runtime mints it when the caller and the
// recording both have none), and it is the same id the gated call is stamped with, so an escalation
// and the approval it belongs to name each other. For a RECORDED run it is `recording.runId`.
const runtimeResumeStateShape = {
	messages: runtimeModelMessage.array(),
	"runId?": "string | undefined",
	"recording?": runtimeRecordingContext.or("undefined"),
} as const;

export const runtimeApprovalMetadata = ark({
	version: "'runtime.ai-sdk.v1'",
	waitId: "string",
	step: "number",
	toolCallId: "string",
	/** The CANONICAL path of the parked call — the same id the ApprovalRecord's own `toolName`
	 *  column carries, so a resume dispatches and decides on exactly what was parked. The wire
	 *  name the provider used is normally NOT stored: it is derived back with `toolModelName` at the
	 *  one place the resume touches the wire (rebuilding the tool-result message). */
	toolName: "string",
	/** The wire name, stored ONLY when it is not the flattened projection of `toolName` — i.e. when
	 *  the call arrived through the `execute` meta-tool, which offers no name to re-derive. Read at
	 *  that same single site and nowhere else: a result is correlated by the pair the call arrived
	 *  as (some providers match by name, not only by call id). Never decided or dispatched on, so a
	 *  wrong value can only mis-address a result message — never reach a different tool. */
	"toolWireName?": "string | undefined",
	/**
	 * The content version of the tool as it stood WHEN THE HUMAN WAS ASKED — the hash of its name,
	 * description, input schema, governance and binding.
	 *
	 * A registered source can be re-registered while an approval sits pending. The address survives, so
	 * the resume dispatches happily onto whatever `petstore.addPet` means now: a different path, a
	 * different schema, different governance. What the human read and what would run are then two
	 * different operations, and nothing said so. Compared at resume; a mismatch refuses.
	 *
	 * Absent for a code tool, which is a host closure with no version to take. Its drift is a redeploy,
	 * not a data change, and there is nothing here that could detect it honestly.
	 */
	"toolVersion?": "string | undefined",
	toolInput: "unknown",
	...runtimeResumeStateShape,
});
export type RuntimeApprovalMetadata = typeof runtimeApprovalMetadata.infer;

export const runtimeYieldMetadata = ark({
	version: "'runtime.ai-sdk.yield.v1'",
	nextStep: "number",
	/**
	 * The highest inbox `seq` the snapshotted transcript actually CONTAINS.
	 *
	 * The redelivery fence, and it has to live here rather than on the message row because only the
	 * snapshot knows what the model will see. A row is marked `delivered` before it is pushed into
	 * the in-memory transcript, so a crash in that window leaves a message nothing will ever show
	 * anyone: not pending, and not in any transcript. Resuming from what the checkpoint contains
	 * re-delivers exactly those and nothing else.
	 */
	"deliveredThrough?": "number | undefined",
	/**
	 * The boundary the yielding run was executing in — compared at resume, refused on mismatch.
	 *
	 * A parked APPROVAL has immutable `scope`/`scopeId` columns on its record to compare against; a
	 * yield checkpoint had nothing, so a continuation could resolve any tenant it liked from the
	 * caller's `ctx` and finish the run there, against that tenant's registered tools and secrets.
	 * This is the yield's copy of that anchor. Absent for a run that resolved no config scope at all
	 * (single-tenant), where there is nothing to disagree about. R-H03.
	 */
	authority: ark({ scope: "string", scopeId: "string" }),
	...runtimeResumeStateShape,
});
export type RuntimeYieldMetadata = typeof runtimeYieldMetadata.infer;

export function parseRuntimeYieldMetadata(
	metadata: unknown,
): RuntimeYieldMetadata {
	const valid = runtimeYieldMetadata(metadata);
	if (valid instanceof ark.errors) {
		throw validationError("runtime yield metadata invalid", valid.summary);
	}
	return valid;
}

export function parseRuntimeApprovalMetadata(
	metadata: unknown,
): RuntimeApprovalMetadata {
	const valid = runtimeApprovalMetadata(metadata);
	if (valid instanceof ark.errors) {
		throw validationError("runtime approval metadata invalid", valid.summary);
	}
	return valid;
}

export function recordingFromRuntimeApprovalMetadata(
	metadata: unknown,
): RuntimeRecordingContext | undefined {
	const valid = parseRuntimeApprovalMetadata(metadata);
	return valid.recording;
}

/** A model chosen for a run, plus whether it opted out of PII redaction. */
export type SelectedModel = {
	readonly model: RuntimeModel;
	readonly rawPii: boolean;
};

type ResolvedModelEntry = SelectedModel & {
	readonly name: string;
	readonly isDefault: boolean;
};

/** Split a pool entry into its model + default/raw flags. A bare language model carries
 *  `specificationVersion` (the AI SDK's version discriminator); the descriptor form does not. */
function poolEntryModel(entry: ModelPoolEntry): {
	model: RuntimeModel;
	isDefault: boolean;
	rawPii: boolean;
} {
	if ("specificationVersion" in entry) {
		return { model: entry, isDefault: false, rawPii: false };
	}
	return {
		model: entry.model,
		isDefault: entry.default === true,
		rawPii: entry.noPiiRedaction === true,
	};
}

/**
 * Resolve the config's model policy into a per-run selector, validating ONCE at construction:
 * `model` and `models` are mutually exclusive and exactly one is required; a pool needs a single
 * default (marked `default: true`, or the sole entry). The returned selector maps a run's chosen
 * name to its model, or the default when unpinned — fail-closed on an unknown name.
 */
function createModelSelector(
	config: RuntimeConfig,
): (name: string | undefined) => SelectedModel {
	const pool = config.models;
	const single = config.model;
	if (pool !== undefined) {
		if (single !== undefined) {
			throw configurationError(
				"`model` and `models` are mutually exclusive — use the single-model shorthand or the pool, not both",
			);
		}
		const entries: ResolvedModelEntry[] = Object.entries(pool).map(
			([name, entry]) => {
				const { model, isDefault, rawPii } = poolEntryModel(entry);
				return { name, model, isDefault, rawPii };
			},
		);
		if (entries.length === 0) {
			throw configurationError(
				"`models` pool is empty — provide at least one model",
			);
		}
		const flagged = entries.filter((entry) => entry.isDefault);
		if (flagged.length > 1) {
			throw configurationError(
				"more than one model marked `default: true` — mark exactly one",
				{ models: flagged.map((entry) => entry.name) },
			);
		}
		// A pool with no default is VALID — it just means selection is mandatory (the caller must
		// "ask"). Enforced at compile time for the api surfaces; here it's the run-time backstop.
		const defaultEntry =
			flagged[0] ?? (entries.length === 1 ? entries[0] : undefined);
		const byName = new Map<string, SelectedModel>(
			entries.map((entry) => [
				entry.name,
				{ model: entry.model, rawPii: entry.rawPii },
			]),
		);
		return (name) => {
			if (name === undefined) {
				if (defaultEntry === undefined) {
					throw configurationError(
						"no model selected and the `models` pool has no default — pass `{ model }` or mark one entry `default: true`",
						{ models: entries.map((entry) => entry.name) },
					);
				}
				return { model: defaultEntry.model, rawPii: defaultEntry.rawPii };
			}
			const selected = byName.get(name);
			if (selected === undefined) {
				throw configurationError(`unknown model "${name}"`, {
					available: [...byName.keys()],
				});
			}
			return selected;
		};
	}
	if (single !== undefined) {
		const resolved: SelectedModel = { model: single, rawPii: false };
		return (name) => {
			if (name !== undefined) {
				throw configurationError(
					`model "${name}" was selected but no \`models\` pool is configured`,
				);
			}
			return resolved;
		};
	}
	throw configurationError(
		"no model configured — provide `model` or a non-empty `models` pool",
	);
}

/**
 * The streamed result of `runtime.stream`: the shared `TextDeltaStream` protocol shape with a
 * concrete `result` — a promise of the final governed result (resolves when the run completes).
 *
 * **Start reading, or cancel.** The channel behind `textStream` is bounded, so a stream that is
 * never read at all fills up and the run parks — `result` does not settle and the provider
 * connection stays open, the same contract a `fetch` body has. Abandoning one is not free.
 *
 * Abandoning it once you HAVE started reading is well defined, and depends on where the answer
 * goes. A **recorded** run (a claw and thread to write to) detaches and runs to completion, so the
 * transcript is waiting when the reader returns — closing a tab does not throw away the answer. An
 * **ad-hoc** run has nowhere to put it, so it aborts and `result` rejects.
 */
/** `Omit` on `result`, not a plain intersection: `TextDeltaStream.result` is `Promise<unknown>`, and
 *  intersecting the two leaves the property `Promise<unknown> & Promise<RuntimeResult>` — which
 *  `.then` reads back as `unknown`, so every consumer has to cast to see the type this declares. */
export type RuntimeStream = Omit<TextDeltaStream, "result"> & {
	readonly result: Promise<RuntimeResult>;
};

/**
 * How many undelivered deltas the channel holds before the producer has to wait. Not a knob: the
 * number only has to be large enough that a reader keeping up never feels it, and small enough that
 * a reader who is NOT keeping up cannot turn a long generation into unbounded heap.
 */
const STREAM_DELTA_BUFFER = 512;

/**
 * The bounded push→async-iterate channel backing `RuntimeStream.textStream`.
 *
 * Two properties an unbounded array does not have:
 *
 * **Backpressure.** At capacity `push` returns a promise instead of returning, and the vendor's own
 * `for await` over the model stream awaits it — so a slow reader stops the read from the provider
 * rather than accumulating in memory. Deltas arrive as fast as a network can deliver them and a
 * reader can be arbitrarily slower (a browser over a bad link, a disk-backed sink); the gap between
 * the two rates is the leak, and this is where it is closed.
 *
 * **Departure.** A consumer that breaks out of its `for await`, or a transport that cancels the
 * `ReadableStream` wrapping it, runs the generator's `finally` — which is the only signal that
 * nobody is reading any more. `onCancel` fires there, and only there: a stream that simply ran to
 * completion has not been abandoned and must not be treated as if it had.
 *
 * What that DEPARTURE means is not the channel's call — see `stream()`, which detaches a recorded
 * run and aborts an ad-hoc one. Either way the channel stops holding deltas from that moment: a
 * `push` after departure discards, so a detached run's output costs nothing to ignore.
 */
export function createDeltaChannel(options: { onCancel: () => void }): {
	push: (value: string) => void | Promise<void>;
	close: () => void;
	iterable: AsyncIterable<string>;
} {
	const buffer: string[] = [];
	let wakeConsumer: (() => void) | undefined;
	let wakeProducer: (() => void) | undefined;
	let closed = false;
	let cancelled = false;

	const releaseProducer = () => {
		wakeProducer?.();
		wakeProducer = undefined;
	};

	return {
		push: (value) => {
			// Nobody is reading. Keeping the delta would only grow a buffer with no exit.
			if (cancelled) return;
			buffer.push(value);
			wakeConsumer?.();
			wakeConsumer = undefined;
			if (buffer.length < STREAM_DELTA_BUFFER) return;
			return new Promise<void>((resolve) => {
				wakeProducer = resolve;
			});
		},
		close: () => {
			closed = true;
			wakeConsumer?.();
			wakeConsumer = undefined;
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				let drained = false;
				try {
					while (true) {
						const next = buffer.shift();
						if (next !== undefined) {
							if (buffer.length < STREAM_DELTA_BUFFER) releaseProducer();
							yield next;
							continue;
						}
						if (closed) {
							drained = true;
							return;
						}
						await new Promise<void>((resolve) => {
							wakeConsumer = resolve;
						});
					}
				} finally {
					cancelled = true;
					buffer.length = 0;
					// A producer parked on capacity would otherwise wait forever for a reader that has
					// already gone. Let it run on to its own abort check.
					releaseProducer();
					if (!drained) options.onCancel();
				}
			},
		},
	};
}

export function createRuntime<const Config extends RuntimeConfig>(
	config: Config,
): Runtime<Config> {
	const selectModel = createModelSelector(config);
	const loop = config.loop ?? aiSdkLoop;
	const now = config.environment?.now ?? (() => new Date().toISOString());
	const newId = config.environment?.newId ?? defaultRuntimeNewId;
	const maxSteps = config.maxSteps ?? 8;
	const declaredTools = config.tools ?? {};
	const warn = config.warn ?? ((message: string) => console.warn(message));
	const eventFanout: RuntimeEventFanout = {
		recording: config.recording,
		observers: eventSinksFrom(config.events),
		warn,
	};
	// THE THREE DURABLE STORES ARE SUPPLIED, NEVER CONSTRUCTED HERE. The runtime used to take a
	// `database` Adapter and build all three itself, which made this package depend on a storage
	// IMPLEMENTATION (@busyclaw/storage-durable) rather than on the ports in contracts — the only
	// package below busyclaw that did. It also meant "which checkpoint store did this run use" was
	// answered by reading three `??` fallbacks and knowing whether an adapter happened to be present.
	// The assembly wires them now (packages/busyclaw/src/index.ts), which is where every real caller
	// already was: `createRuntime` has exactly one production call site.
	const approvalStore = config.approvalStore;
	const effectStore = config.effectStore;
	const runCheckpointStore = config.checkpoints;
	// The guard follows the STORES, not an adapter. Same invariant, stated against the thing it is
	// actually about: anything that persists redacted content across a process — a parked approval's
	// arguments, a checkpoint's transcript — can only be rehydrated later if the mapping outlived the
	// process too. It now also fires for a host that brings its own stores, which the adapter-keyed
	// version could not see.
	if (
		(approvalStore !== undefined || runCheckpointStore !== undefined) &&
		config.redactor?.durable !== true
	) {
		throw configurationError(
			"database-backed runtime approvals require a durable redactor",
		);
	}
	const resolveContext = composeContext({
		identity: config.identity,
		membership: config.membership,
		configScope: config.configScope,
		subject: config.subject,
	});
	// The run's tool set, plus the discovery meta-tools when anything in it is `discoverable`. They
	// are ordinary descriptors from here on — dispatched, gate-registered and catalogued through the
	// same paths as any tool — which is why `search` runs and `execute` is reachable at all. A set
	// with nothing discoverable gets itself back untouched: no meta-tools, no new wire names.
	const withDiscovery = (tools: ToolDefinitionSet): ToolDefinitionSet => {
		const meta = discoveryTools(tools);
		for (const path of Object.keys(meta)) {
			// Loud, because what reaches here declaring a reserved path is CODE. A per-run
			// registration is data, and is turned away by the merge below instead.
			if (path in tools) {
				throw configurationError(
					`tool "${path}" is in busyclaw's reserved namespace`,
					{ path },
				);
			}
		}
		return Object.keys(meta).length === 0 ? tools : { ...tools, ...meta };
	};
	const staticTools = withDiscovery(declaredTools);
	const staticProjection = modelToolProjection(staticTools);

	/**
	 * The option names the runtime's own calling convention already owns.
	 *
	 * A capability is injected under its own name, so a capability called `messages` would replace the
	 * transcript the AI SDK passes and a capability called `subInvoke` would hand a non-invoker tool
	 * something that looks exactly like arbitrary governed invocation. Refused at ASSEMBLY, where it
	 * is a developer holding a stack trace, rather than at call time inside somebody's model turn.
	 */
	const RESERVED_CAPABILITY_NAMES = new Set([
		"toolCallId",
		"messages",
		"abortSignal",
		"effectId",
		"subInvoke",
		"probeAccess",
	]);
	const capabilities = config.capabilities ?? {};
	for (const name of Object.keys(capabilities)) {
		if (RESERVED_CAPABILITY_NAMES.has(name)) {
			throw configurationError(
				`capability "${name}" collides with the runtime's own tool-call option`,
				{ capability: name },
			);
		}
	}
	// The catalog is the HOST's read-path over the tools it declared — the meta-tools are the
	// runtime's own plumbing and would only be noise in it.
	const catalog = createToolCatalog(toolEntriesFromTools(declaredTools));

	// Merge a run's resolved tools over the static code tools: code tools WIN collisions (a host
	// tool is never shadowed by a registered upload), and a colliding registered tool is skipped
	// loudly, never silently replaced. Two ways to collide, both checked — the PATH (one canonical
	// id, two tools: policy would cover whichever won) and the model-facing NAME two distinct paths
	// can still project onto (`a.b` and a flat `a__b`), which would silently drop one from the
	// toolset while leaving the other reachable under it. The static assembly fails loud on both;
	// a per-run registration is data a host does not control, so here it is skip-and-warn. Names come
	// off the declared set, not the offered one: a discoverable tool is out of the context window but
	// its wire name is still indexed, so colliding with it is the same loss.
	const mergeRunTools = (resolved: ToolDefinitionSet): ToolDefinitionSet => {
		const merged: ToolDefinitionSet = { ...declaredTools };
		const modelNames = new Set(Object.keys(declaredTools).map(toolModelName));
		for (const [path, tool] of Object.entries(resolved)) {
			if (path in declaredTools) {
				warn(
					`busyclaw: registered tool "${path}" skipped — a code tool already owns that path`,
				);
				continue;
			}
			if (DISCOVERY_TOOL_PATHS.includes(path)) {
				warn(
					`busyclaw: registered tool "${path}" skipped — busyclaw's own namespace is reserved`,
				);
				continue;
			}
			const modelName = toolModelName(path);
			if (modelNames.has(modelName)) {
				warn(
					`busyclaw: registered tool "${path}" skipped — another tool is already offered as "${modelName}"`,
				);
				continue;
			}
			modelNames.add(modelName);
			merged[path] = tool;
		}
		return merged;
	};
	// Resolve the run's tool set + its provider edge ONCE per run — and ONLY once. Discovery
	// deliberately does NOT re-resolve the toolset per step: what the model is offered at step 1 is
	// what it is offered at step 8, and a discoverable tool is reached through `execute` rather than
	// by joining the offered set mid-run. That keeps this a tool-layer change instead of a run-loop
	// one. With no resolver the precomputed static projection is reused (zero cost); dispatch
	// (`runTools[call.name]`), the ingress translation, and the offered toolset all come off the SAME
	// merged set.
	const resolveRunTools = async (
		resolvedCtx: Record<string, unknown>,
	): Promise<{
		runTools: ToolDefinitionSet;
		projection: ModelToolProjection;
	}> => {
		if (!config.resolveTools) {
			return { runTools: staticTools, projection: staticProjection };
		}
		const runTools = withDiscovery(
			mergeRunTools(await config.resolveTools(resolvedCtx)),
		);
		return { runTools, projection: modelToolProjection(runTools) };
	};
	const emitEvent = (
		context: { recording?: RuntimeRecordingContext; runId?: string },
		payload: RuntimeEventPayloadInput,
	) =>
		emitRuntimeEvent(
			eventFanout,
			createRuntimeEvent({
				createdAt: now(),
				id: newId("evt"),
				payload,
				recording: context.recording,
				runId: context.runId,
			}),
		);

	// One outcome-event emitter for every loop entry point (run, approval resume, checkpoint resume).
	// `usage` is the loop's aggregate over the model calls of THIS invocation only; undefined
	// simply flows through — the event schemas accept an unreported aggregate.
	const emitRunOutcome = async (
		context: { recording?: RuntimeRecordingContext; runId?: string },
		result: RuntimeResult,
		usage: RuntimeModelUsage | undefined,
	): Promise<void> => {
		// EXHAUSTIVE, by a switch whose default is `never`. This was an if-chain, and an if-chain that
		// silently drops an unhandled variant is how `denied` came to emit no terminal event at all —
		// a run reaching a terminal state with nothing on the operational stream to say so. A new
		// variant must now fail to compile here rather than fail to be observed in production.
		switch (result.status) {
			case "completed":
				await emitEvent(context, {
					steps: result.steps,
					text: result.text,
					type: "run.completed",
					usage,
				});
				return;
			case "waiting_approval":
				await emitEvent(context, {
					approvalIds: result.approvalIds,
					steps: result.steps,
					text: result.text,
					type: "run.waiting_approval",
					usage,
				});
				return;
			case "yielded":
				await emitEvent(context, {
					checkpointId: result.checkpointId,
					steps: result.steps,
					text: result.text,
					type: "run.yielded",
					usage,
				});
				return;
			case "parked":
				await emitEvent(context, {
					checkpointId: result.checkpointId,
					reason: result.reason,
					steps: result.steps,
					text: result.text,
					type: "run.parked",
					usage,
				});
				return;
			case "awaiting":
				await emitEvent(context, {
					checkpointId: result.checkpointId,
					steps: result.steps,
					text: result.text,
					type: "run.awaiting",
					usage,
					waitId: result.waitId,
				});
				return;
			case "denied":
				// Deliberately silent HERE. `denied` is the one outcome that never comes out of the loop
				// — it is minted by the approval-decision path, which emits its own `run.denied` with the
				// decision fields at the point it makes them. Emitting again would double-report one
				// terminal event. Named rather than defaulted, so the silence is a decision on the record.
				return;
			default: {
				const unreachable: never = result;
				throw stateError("unhandled runtime result", {
					status: (unreachable as { status?: unknown }).status,
				});
			}
		}
	};

	// A stored message body as the model sees it. It arrives ALREADY tokenized — the door redacted it
	// into the receiving run's container — so this shapes it and never touches its content.
	const asInboxMessage = (body: Record<string, unknown>): ModelMessage => ({
		role: "user",
		content: typeof body.text === "string" ? body.text : JSON.stringify(body),
	});

	const armInterruptFor =
		(control: RunControlPort, runId: string) =>
		(fire: () => void): void =>
			control.armInterrupt?.(runId, fire);

	// Binds the control port to a run's identity, so the loop asks "should I stop?" without ever
	// holding a run id it could ask about somebody ELSE's run.
	const controlPointFor =
		(control: RunControlPort, runId: string) =>
		async (
			seenSeq: number,
			deliveredThrough: number,
		): Promise<RunControlVerdict> => {
			const verdict = await control.poll(runId, seenSeq, deliveredThrough);
			return {
				seq: verdict.seq,
				...(verdict.park ? { park: verdict.park } : {}),
				...(verdict.deliver?.length
					? {
							deliver: verdict.deliver.map((entry) => ({
								seq: entry.seq,
								message: asInboxMessage(entry.body),
							})),
						}
					: {}),
			};
		};

	// Binds the checkpoint store to a run's identity so the loop can park a yield without knowing
	// where checkpoints live. Undefined when no database is configured — the loop then cannot yield.
	const yieldCheckpointPersister = (state: RunState) =>
		runCheckpointStore
			? async (input: {
					nextStep: number;
					messages: ModelMessage[];
					deliveredThrough?: number;
				}): Promise<string> => {
					const metadata: JsonObject = {
						version: "runtime.ai-sdk.yield.v1",
						nextStep: input.nextStep,
						...(input.deliveredThrough !== undefined
							? { deliveredThrough: input.deliveredThrough }
							: {}),
						messages: toJsonValue(
							input.messages,
							"runtime yield messages invalid",
						),
						...(state.runId !== undefined ? { runId: state.runId } : {}),
					};
					// The tenancy anchor a resume compares against. Always written: a run that resolved no
					// tenant carries UNSCOPED, so "which boundary did this yield from" has an answer even
					// for a single-tenant deployment — and a resume that answers differently is still a
					// mismatch worth refusing.
					const anchor = state.authority?.configScope ?? UNSCOPED;
					metadata.authority = { scope: anchor.scope, scopeId: anchor.scopeId };
					if (state.recording !== undefined) {
						metadata.recording = toJsonValue(
							state.recording,
							"runtime yield recording invalid",
						);
					}
					// Validate at the write boundary — a malformed envelope must not become a poison
					// checkpoint that fails only when the continuation task tries to load it.
					parseRuntimeYieldMetadata(metadata);
					const record = await runCheckpointStore.create({
						createdAt: now(),
						metadata,
						...(state.runId !== undefined ? { runId: state.runId } : {}),
					});
					return record.id;
				}
			: undefined;

	// The one redaction seam runtime hands the loop: ingress (prompt, tool outputs) + events. The
	// `redactor` is per-run — a model that opted out of redaction (noPiiRedaction) runs with `undefined`.
	const redactValue = async <T>(
		value: T,
		ctx: Record<string, unknown>,
		redactor: Redactor | undefined = config.redactor,
	): Promise<T> =>
		redactor ? redactor.redactValue(value, redactionContextFrom(ctx)) : value;

	/**
	 * Stamp the redaction CONTAINER onto a run's context — the SAME `(scope, scopeId)` pair the api
	 * writes for a claw's rows (`{scope:"claw", scopeId:clawId}`), so a placeholder minted mid-run and
	 * one minted by the api live in ONE namespace.
	 *
	 * Applied to EVERY context a run redacts through, from one place on purpose. The prompt is redacted
	 * against the run context while the tool edge reads against the governance context, so stamping
	 * only one of them splits the container in half: the mint lands in a namespace the read never looks
	 * in, and the value silently comes back as a raw placeholder instead of rehydrating. Nothing throws
	 * on that — which is exactly why it belongs behind a single call.
	 *
	 * Unstamped, the redactor ran container-LESS: a placeholder minted in claw A rehydrated at claw B's
	 * tool edge, and `forgetSubject` (which erases per container) could not reach run-minted rows at all.
	 *
	 * An ad-hoc run has no claw — but it is not therefore containerless, and treating it that way put
	 * EVERY such run in one shared namespace. A placeholder minted by one contextless run rehydrated in
	 * another, so holding a token from someone else's run was enough to have a tool hand you the value
	 * behind it. The run is the container when nothing larger is: `(run, runId)`, minted per run, so the
	 * absent case is many namespaces of one rather than one namespace of many.
	 */
	/**
	 * WHICH CONTAINER a run's placeholders live in — the decision itself, typed, in one place.
	 *
	 * Split out of the context stamp when a second caller appeared (`translate`, crossing two of
	 * these). The stamp writes into an untyped context bag, so the alternative was reading the answer
	 * back out with `typeof` guards — which silently drops a container it cannot recognise and leaves
	 * the caller rehydrating in the UNCONTAINED bucket, where every lookup misses and the value is
	 * returned as the raw `{{pii:…}}` string with nothing thrown.
	 *
	 * A recorded run is contained by its CLAW: the transcript outlives the run, and a placeholder in
	 * message 3 has to rehydrate in message 40. An ad-hoc run has no such life — nothing survives it —
	 * so its own id is the honest boundary, and erasure reaches it the same way it reaches a claw.
	 *
	 * `undefined` is a real answer, not a failure. A container has to be the SAME one on the way back
	 * in — a placeholder minted before an approval park must rehydrate after it — so a resume whose
	 * checkpoint carries no run id stays uncontained ON PURPOSE: that run was minted before run
	 * containers existed, and inventing one now would put the read in a namespace the mint never used.
	 */
	const runContainer = (
		recording: RuntimeRecordingContext | undefined,
		runId: string | undefined,
	): { containerKind: string; containerId: string } | undefined => {
		if (recording !== undefined) {
			return { containerKind: "claw", containerId: recording.clawId };
		}
		if (runId !== undefined) {
			return { containerKind: "run", containerId: runId };
		}
		return undefined;
	};

	const stampRedactionContainer = (
		ctx: Record<string, unknown>,
		recording: RuntimeRecordingContext | undefined,
		runId: string | undefined,
	): Record<string, unknown> => {
		const container = runContainer(recording, runId);
		if (container === undefined) return ctx;
		ctx[PII_CONTAINER_KIND_CONTEXT_KEY] = container.containerKind;
		ctx[PII_CONTAINER_ID_CONTEXT_KEY] = container.containerId;
		return ctx;
	};

	const createRunCore = (
		state: RunState,
		approvalStoreOverride = approvalStore,
		runTools: ToolDefinitionSet = staticTools,
		redactor: Redactor | undefined = config.redactor,
	) => {
		// The tools THIS RUN added beyond the static set. The governance floor compiles its action model
		// once, from the static tools, so a per-run registration is an action no policy can name — and
		// the sealed default refuses it. That was invisible while unmodeled calls skipped the gate; with
		// every call decided, a boundary's registered tools would simply never run. Computed once per
		// run core, stamped per call onto the context the gate actually receives (core rebuilds it, so
		// stamping the caller's copy upstream would reach nothing).
		const runActions = toolDescriptors(runTools).filter(
			(descriptor) => staticTools[descriptor.path] === undefined,
		);
		const resolveGovernanceContext = async (
			ctx: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			// STAMPS the run's authority; never re-derives it. Core hands over a freshly stripped context
			// at each of its boundary doors, and this used to re-run the host's identity/membership/
			// configScope resolvers on every one of them — so a resolver reading a mutable store answered
			// per door, and the tool closure (resolved once, earlier, without the caller) had already
			// captured a different answer than any of them. One derivation now, at the entry point, before
			// tools; this writes it back on. R-H03.
			//
			// The seed rule it replaces is unchanged in effect: the authenticated caller IS the run's
			// principal and wins over the `identity` resolver, which is the caller-LESS fallback
			// (cron/engine resume → a system principal). Absent caller AND absent resolver → no stamp →
			// the tool floor fails closed on a modeled action (cedarMapCall denies).
			// The fallback is not a hypothetical: it is what a run whose authority was never resolved HAS —
			// no boundary. UNSCOPED is the value for exactly that, and it finds nothing, so a gate reached
			// before the entry point settled the authority fails closed rather than inheriting a tenant.
			const resolved = stampAuthority(
				ctx,
				state.authority ?? { configScope: UNSCOPED },
			);
			stampRunActions(resolved, runActions);
			// The approver of a resumed `needs-approval` (forge-proof: from the persisted, PEP-gated
			// ApprovalRecord's `decidedBy`, set on the resume path — never caller/model). Seeded HERE (the
			// trusted step, post-strip) so the replayed action's audit records WHO approved it.
			if (state.approvedBy !== undefined) {
				resolved[APPROVED_BY_CONTEXT_KEY] = state.approvedBy;
			}
			// Runtime-stamped, spoof-proof facts (the caller's busyclaw__ keys were already stripped).
			resolved[RUN_MODE_CONTEXT_KEY] = state.runMode;
			// THE CLAW IS STAMPED WHETHER OR NOT THE RUN IS RECORDED, and that `else` is the point. A
			// subagent belongs to a claw but writes no transcript, so under `if (state.recording)` alone
			// it reached Cedar with `clawId` ABSENT — and an absent attribute base-errors, which SKIPS
			// the policy rather than failing it. An unguarded `forbid` written against `clawId` therefore
			// fails OPEN, on exactly the runs nobody is watching. This tree has been bitten by that
			// twice, so the fact is made TRUE rather than made nullable.
			//
			// `threadId` stays conditional: an unrecorded run genuinely has no thread, and inventing one
			// would be a fact that is false rather than merely absent.
			if (state.recording) {
				resolved[CLAW_ID_CONTEXT_KEY] = state.recording.clawId;
				resolved[THREAD_ID_CONTEXT_KEY] = state.recording.threadId;
			} else if (state.clawId !== undefined) {
				resolved[CLAW_ID_CONTEXT_KEY] = state.clawId;
			}
			stampRedactionContainer(resolved, state.recording, state.runId);
			// The run's own id — the recording's when the run is recorded, else the one this invocation
			// minted. clawId/threadId stay conditional on a recording (an ad-hoc run genuinely has
			// neither), but a run id it always has, so an after-gate always has something to correlate
			// on and the parked approval records the same value.
			const runId = state.recording?.runId ?? state.runId;
			if (runId !== undefined) resolved[RUN_ID_CONTEXT_KEY] = runId;
			return resolved;
		};
		const core = createGovernance({
			redactor,
			audit: config.audit,
			approvalStore: approvalStoreOverride,
			// The SAME operator-notice door the event fan-out and the tool-name collisions use — so a
			// plugin's after-gate reports where the host is already looking, instead of console.warn.
			warn,
			approvalMetadata: () => {
				const metadata: JsonObject = {
					version: "runtime.ai-sdk.v1",
					waitId: state.currentApprovalWaitId ?? "",
					step: state.currentStep,
					toolCallId: state.currentToolCallId,
					toolName: state.currentToolPath,
					toolInput: toJsonValue(
						state.currentToolInput,
						"runtime approval tool input invalid",
					),
					messages: toJsonValue(
						state.currentMessages,
						"runtime approval messages invalid",
					),
				};
				// The version of the tool the human is being asked about. Only data-backed tools have
				// one; a code tool is a closure and reports none.
				const parkedVersion = runTools[state.currentToolPath]?.contentVersion;
				if (parkedVersion !== undefined) {
					metadata.toolVersion = parkedVersion;
				}
				// Only when the wire name is NOT the path's own projection — a call routed through the
				// `execute` meta-tool. Carrying it always would put a second id in the checkpoint for
				// every approval; carrying it never would answer a routed call under a name the
				// provider was never offered.
				if (
					state.currentToolWireName !== undefined &&
					state.currentToolWireName !== toolModelName(state.currentToolPath)
				) {
					metadata.toolWireName = state.currentToolWireName;
				}
				if (state.recording !== undefined) {
					metadata.recording = toJsonValue(
						state.recording,
						"runtime approval recording invalid",
					);
				}
				// The join key, on every parked row — the same id the gated call was stamped with, and
				// the same one the escalation carries. A recorded run also has it inside `recording`;
				// an ad-hoc one has only this, which is the whole point of writing it at the top level.
				if (state.runId !== undefined) metadata.runId = state.runId;
				// Validate at the write boundary — a malformed checkpoint must not park an
				// unresumable approval and surface only when a human grants it.
				parseRuntimeApprovalMetadata(metadata);
				return metadata;
			},
			resolveContext: resolveGovernanceContext,
			plugins: config.plugins,
			callModel: async () => {
				if (!state.currentModelRunner) {
					throw stateError("runtime model boundary missing model runner");
				}
				return state.currentModelRunner();
			},
			runTool: async (call, _ctx, { rehydrate }) => {
				abortIfNeeded(state.abortSignal);
				const tool = runTools[call.name];
				const executeTool = tool && toolExecutor(tool);
				if (!executeTool) {
					throw stateError(`busyclaw: no executable tool "${call.name}"`, {
						toolName: call.name,
					});
				}
				// Governance is a descriptor FIELD — nothing to read back, nothing to re-validate.
				const stamp = tool.governance;
				const isInvokerTool = stamp.invoker === true;
				// `search` DISCLOSES what the floor would say about each hit, so the model learns
				// "this needs approval, escalate to X" before it spends a turn discovering it. That is a
				// DECISION, which needs the turn context — and the turn context does not cross the
				// tool-execute boundary. So the runtime hands the capability across instead of the
				// context, exactly the seam `subInvoke` uses, and only to busyclaw's own meta-tool: a
				// host tool can never claim that reserved path (`withDiscovery` throws, the per-run
				// merge skips), so this is least authority, not a well-known option name.
				//
				// Before-gates only — no tool runs, no after-gate fires, so a search audits nothing,
				// parks nothing and changes nothing. `_ctx` is core's OWN resolved context; handing it
				// back through the front door means it is stripped and re-stamped by the same trusted
				// assembly rather than trusted as it stands. That costs one extra identity/membership
				// resolution per search and keeps the rule that nobody hands core a pre-trusted context.
				//
				// Annotated (not inferred) and unconditional: `core` is being defined by this very
				// factory call, so a closure whose return type TypeScript has to infer from `core` is
				// circular — `ToolAccessProbe` breaks the cycle, and a union with `undefined` would put
				// it back.
				const isDiscoverySearch = call.name === SEARCH_TOOL_PATH;
				const probeAccess: ToolAccessProbe = (paths) =>
					core.checkToolCalls(
						paths.map((name) => ({ name, args: {} })),
						_ctx,
					);
				// THE GENERIC CAPABILITY SEAM. `subInvoke` and `probeAccess` above are each wired in by
				// name; a third tenant would be a third conditional and the one after that a fourth. A
				// tool names the capability it wants, the host registers a factory under that name, and
				// exactly that one thing is handed over — a tool that asked for nothing gets nothing, and
				// a tool that asked for "agent" cannot reach "sandbox" by knowing its option name.
				//
				// BUILT PER CALL, not at assembly. That is what dissolves the construction-order problem
				// for a capability needing the fully-built claw: the factory can close over a slot its own
				// plugin fills later, and nothing here has to exist yet when the runtime is created.
				const capabilityName = stamp.capability;
				const capability =
					capabilityName === undefined
						? undefined
						: capabilities[capabilityName]?.({
								runId: state.runId,
								// The FROZEN resolved authority, not the raw caller: a capability reconstructs a
								// caller from this rather than accepting one, which is what stops a spawned
								// child being pointed at somebody else's identity (D7).
								principal: state.authority?.principal,
								step: state.currentStep,
								// The park REQUEST — a latch the loop reads at the top of the next step, never a
								// park performed here. Bound to this run's state, so a capability can only ever
								// stop the run it was built for; it holds no reference by which to name another.
								requestAwait: (waitId: string) => {
									state.awaitingWaitId = waitId;
								},
							});
				// A tool asking for a capability nobody registered is a MISCONFIGURATION, not a tool that
				// runs with one fewer argument. Silently omitting it means the tool discovers the absence
				// at the moment it tries to use it, inside a model turn, as a TypeError attributed to the
				// model's arguments.
				if (capabilityName !== undefined && capability === undefined) {
					throw configurationError(
						`tool "${call.name}" needs the "${capabilityName}" capability, which this claw does not provide`,
						{ toolName: call.name, capability: capabilityName },
					);
				}
				// An invoker tool is BRAIN, not edge: it runs untrusted model-authored code, so its args
				// must stay redacted (placeholders reach the guest). A normal tool is the trusted edge and
				// rehydrates. Nested calls the guest makes are re-redacted on the way back (nested runTool
				// below), so the guest only ever holds placeholders. Future: a "trusted/unredacted" sandbox
				// variant opts out here.
				//
				// A CAPABILITY TOOL KEEPS THEM REDACTED TOO, for a different reason than the invoker's:
				// the capability owns every container crossing (`translate`), and a tool holding
				// rehydrated values could put one into another container without going through it —
				// where it would arrive as a placeholder the destination cannot resolve, silently.
				const args =
					isInvokerTool || capabilityName !== undefined
						? call.args
						: await rehydrate(call.args);
				const execute = (abortSignal?: unknown) =>
					// The runtime's calling convention: the AI-SDK call options plus `subInvoke`, which
					// busyclaw adds for invoker-stamped capability tools only (least authority). The
					// descriptor's executable is deliberately untyped in its parameters, so the
					// extension passes through without the casts the closed AI-SDK type used to force.
					executeTool(args, {
						toolCallId: state.currentToolCallId,
						messages: state.currentMessages,
						abortSignal,
						// The ledger's id for THIS effect, handed to the tool so a provider that speaks
						// idempotency keys can be given one that is stable across every retry of the same
						// attempt. Read at CALL time, not closure-build time: the id is minted a few lines
						// below, on the store path only. Absent when there is no ledger, which is honest —
						// a key whose stability nothing tracks would be decoration.
						...(state.currentEffectId !== undefined
							? { effectId: state.currentEffectId }
							: {}),
						...(isInvokerTool ? { subInvoke } : {}),
						...(isDiscoverySearch ? { probeAccess } : {}),
						// Under its OWN name, so a tool's signature says what it needs. The reserved-name
						// check at assembly is what keeps this from clobbering `messages` or `subInvoke`.
						...(capabilityName !== undefined
							? { [capabilityName]: capability }
							: {}),
					});
				const effectPolicy = stamp.effect;
				const outputMode = effectOutputMode(effectPolicy);
				if (!effectStore) {
					// `idempotency: "required"` is the tool saying it CANNOT safely run twice. With no
					// ledger there is nothing that could tell a retry from a first attempt, so running it
					// anyway silently converts the strongest declaration a tool can make into no
					// protection at all — and the paths that retry (crash recovery, approval resume,
					// lease recovery) are exactly the ones that then double-charge or double-send.
					if (effectPolicy?.idempotency === "required") {
						throw configurationError(
							`tool "${call.name}" requires idempotency but this claw has no effect store`,
							{
								toolName: call.name,
								reason:
									"pass a database to createClaw so effects can be claimed, or relax the tool's effect policy to 'optional' if a duplicate is genuinely acceptable",
							},
						);
					}
					return execute(state.abortSignal);
				}
				if (outputMode === "redacted" && !redactor) {
					throw configurationError(
						"redacted effect output requires a redactor",
						{ toolName: call.name },
					);
				}
				state.currentEffectId ??= `run:${state.runId ?? state.recording?.runId ?? state.runInstanceId ?? newId("run")}:tool:${state.currentToolCallId || call.name}`;
				const inputHash = hashEffectInput({
					toolName: call.name,
					args: call.args,
				});
				const claim = await effectStore.claim({
					id: state.currentEffectId,
					toolName: call.name,
					inputHash,
					// Whose work this is, from the run's OWN state — the same authority every gate on this
					// turn was decided against, never anything the tool or the model reached. Without it
					// `getEffect` had nothing to resolve and answered any authenticated caller (R-H01).
					anchors: {
						...(state.authority?.configScope ?? UNSCOPED),
						...(state.recording?.clawId !== undefined
							? { clawId: state.recording.clawId }
							: {}),
						...(state.authority?.principal !== undefined
							? { principal: asPrincipal(state.authority.principal) }
							: {}),
					},
					compensation: effectPolicy?.compensation,
					now: now(),
					leaseTtlMs: config.effectLeaseTtlMs,
					reclaimExpired: effectPolicy?.idempotency !== "none",
				});
				if (claim.record.inputHash !== inputHash) {
					throw stateError("effect id reused with different input", {
						effectId: state.currentEffectId,
					});
				}
				if (claim.status === "completed") {
					if (claim.record.output === undefined) {
						throw stateError("completed effect output is unavailable", {
							effectId: state.currentEffectId,
							outputMode,
						});
					}
					return claim.record.output;
				}
				if (claim.status === "in_progress") {
					throw stateError("effect is already in progress", {
						effectId: state.currentEffectId,
						leaseExpiresAt: claim.leaseExpiresAt,
					});
				}
				if (claim.status === "uncertain") {
					throw stateError(
						"effect outcome is unknown and cannot be retried without idempotency",
						{
							effectId: state.currentEffectId,
							leaseExpiresAt: claim.leaseExpiresAt,
						},
					);
				}
				if (claim.status === "unavailable") {
					throw stateError("effect is not claimable", {
						effectId: state.currentEffectId,
						status: claim.record.status,
					});
				}
				const abortController = createRuntimeAbortController();
				const stopHeartbeat = startEffectHeartbeat({
					store: effectStore,
					effectId: state.currentEffectId,
					leaseToken: claim.leaseToken,
					leaseTtlMs: config.effectLeaseTtlMs,
					now,
					abortController,
				});
				const abortSignal = combinedAbortSignal(
					state.abortSignal,
					abortController.signal,
				);
				try {
					const output = await execute(abortSignal);
					abortIfNeeded(state.abortSignal);
					if (abortController.signal.aborted) {
						throw stateError("effect lease lost before completion", {
							effectId: state.currentEffectId,
						});
					}
					const persistedOutput =
						outputMode === "none"
							? undefined
							: toJsonValue(
									outputMode === "redacted" && redactor
										? await redactor.redactValue(
												output,
												redactionContextFrom(_ctx),
											)
										: output,
									"effect output invalid",
								);
					await effectStore.complete({
						id: state.currentEffectId,
						leaseToken: claim.leaseToken,
						...(persistedOutput !== undefined
							? { output: persistedOutput }
							: {}),
						now: now(),
					});
					return output;
				} catch (err) {
					try {
						await effectStore.fail({
							id: state.currentEffectId,
							leaseToken: claim.leaseToken,
							error: await redactedErrorPayload({
								err,
								redactor,
								ctx: _ctx,
							}),
							now: now(),
						});
					} catch {
						// Preserve the tool/lease error; fail() can also lose the lease.
					}
					throw err;
				} finally {
					stopHeartbeat();
				}
			},
		});
		registerToolGates(core, runTools);

		// Nested calls (an invoker tool's `subInvoke`) share redaction, audit, plugins, and
		// identity resolution with the parent core, but structurally lack its two ambient-state
		// paths: NO approvalStore (nothing can park mid-execution) and a runTool that never
		// touches the effect store or mutates per-step RunState. It reads only `abortSignal`
		// (read-only), so it is safe under Promise.all and never inherits the parent's effect id.
		// Both cores share the one AuditSink → a single interleaved hash chain. Built lazily so a
		// run that never calls an invoker tool pays nothing.
		let nested: Governance | undefined;
		const getNestedCore = (): Governance => {
			if (nested) return nested;
			const built = createGovernance({
				redactor,
				audit: config.audit,
				plugins: config.plugins,
				resolveContext: resolveGovernanceContext,
				runTool: async (call, nestedCtx, { rehydrate, signal }) => {
					abortIfNeeded(state.abortSignal);
					const tool = runTools[call.name];
					const executeTool = tool && toolExecutor(tool);
					if (!executeTool) {
						throw stateError(`busyclaw: no executable tool "${call.name}"`, {
							toolName: call.name,
						});
					}
					const args = await rehydrate(call.args);
					const output = await executeTool(args, {
						toolCallId: newId("nested"),
						messages: [],
						// The run's lifetime AND the caller's, whichever ends first. Combined, never
						// replaced: a nested caller may narrow how long its own call lives and must not
						// be able to outlive the run. Without the caller's half, a sandbox execution
						// ending left the host request it started running to completion — the guest saw
						// a timeout and the socket did not, so a guest could retire promises faster than
						// the host retired connections.
						abortSignal: combinedAbortSignal(state.abortSignal, signal),
						// v7 requires the toolsContext channel field; busyclaw injects capabilities
						// through its own seam, so nested leaf calls run context-less.
						context: undefined,
					});
					// The caller is untrusted BRAIN (an invoker tool's sandboxed code / a future
					// subagent), so the real leaf-tool output must be re-redacted before it crosses back.
					// Keyed on the resolved nested context so re-redaction stays within the run's subject
					// scope. No-op without a redactor.
					return redactor
						? redactor.redactValue(output, redactionContextFrom(nestedCtx))
						: output;
				},
				now,
			});
			// runTools, NOT the static `tools`: the nested core executes from runTools (above), so a
			// per-run registered tool's gate must register here too — otherwise a gated registered
			// tool reached via subInvoke would run ungated on the nested core.
			registerToolGates(built, runTools);
			nested = built;
			return nested;
		};

		const subInvoke: SubInvoke = async (name, args, ctx, options) => {
			// Recursion guard: an invoker-stamped tool cannot be reached from a nested call.
			// Nested tools never receive a `subInvoke`, so letting one through would only fail
			// deeper with a worse error — fail closed at the door. runTools (not the static `tools`)
			// so a per-run registered invoker tool is guarded too.
			const target = runTools[name];
			if (target?.governance.invoker === true) {
				return {
					status: "denied",
					demands: [],
					gateId: "runtime:nested-invoke",
					reason: `tool "${name}" is a capability tool and cannot be invoked from nested execution`,
					reasonCode: NESTED_INVOKER_TOOL,
				};
			}
			// A nested call is unledgered by construction: the nested core has no effect store, and a
			// deterministic child effect id cannot be derived honestly — the guest is model-authored
			// code, so the same parent replayed may not make the same nested calls in the same order.
			// A tool declaring it CANNOT run twice is therefore refused at the door rather than run
			// outside the ledger, where a parent retry would silently repeat it. `optional`/`none` say
			// a duplicate is survivable, and they pass.
			if (target?.governance.effect?.idempotency === "required") {
				return {
					status: "denied",
					demands: [],
					gateId: "runtime:nested-effect",
					reason: `tool "${name}" requires idempotency and cannot be called from nested execution`,
					reasonCode: NESTED_EFFECT_UNSUPPORTED,
				};
			}
			// handleToolCall re-validates args at ingress (arktype jsonObject); the cast only
			// satisfies the port's JsonObject param for a value we keep as untrusted input.
			const result = await getNestedCore().handleToolCall(
				{ name, args: args as JsonObject },
				ctx,
				options?.signal ? { signal: options.signal } : undefined,
			);
			// A nested needs-approval fails closed AS A VALUE — there is no durable way to park a
			// live nested execution. Convert to a denied result with a stable reason code, keeping the
			// model-audience annotations: "you cannot do this here, do X instead" is exactly what the
			// author wrote them for, and this is the one door where a park is READ rather than parked.
			if (result.status === "needs-approval") {
				return {
					status: "denied",
					demands: [],
					gateId: result.gateId,
					reason: `tool "${name}" requires approval and cannot be called from nested execution`,
					reasonCode: NESTED_APPROVAL_UNSUPPORTED,
					...(result.modelAnnotations
						? { modelAnnotations: result.modelAnnotations }
						: {}),
				};
			}
			// The third model-facing door, and the least obvious one: this value round-trips into the
			// SANDBOX as JSON, and the code reading it was written by the model. So the HOST's
			// annotation bag is dropped here for the same reason the transcript never carries it —
			// `@escalate("betterauth:org_123")` is an id for an after-gate (which has already run, on
			// the nested core), not something a guest script may read back out.
			if (result.status === "denied" && result.annotations) {
				const { annotations: _hostOnly, ...forGuest } = result;
				return forGuest;
			}
			return result;
		};

		return core;
	};

	/**
	 * The run's ONE derivation of authority, plus the context every later door is stamped from.
	 *
	 * `callerPrincipal` must be settled before this is called — it is seeded into the context BEFORE the
	 * host's resolvers run, so membership, subject and configScope all resolve for the principal the run is
	 * actually authorized as. That ordering is the fix; stamping the caller afterwards (what this used
	 * to do, one layer down) left every resolver below it answering about someone else.
	 */
	const resolveRunAuthorityAndContext = async (
		ctxInput: Record<string, unknown> | undefined,
		callerPrincipal: Principal | undefined,
		recording: RuntimeRecordingContext | undefined,
		runId: string | undefined,
		onAuthorityResolved?: (boundary: {
			scope: string;
			scopeId: string;
		}) => void,
	): Promise<{ authority: RunAuthority; ctx: Record<string, unknown> }> => {
		const { authority, ctx } = await resolveRunAuthority({
			ctx: stripReserved(ctxInput ?? {}),
			callerPrincipal,
			resolveContext,
		});
		// Reported from INSIDE the resolver, not from its call sites. There are three of them —
		// generate/stream, the approval resume, the checkpoint resume — and a RESUMED slice never
		// passes through the first. Binding this at the call sites would therefore write the anchor
		// on a run's first slice and silently stop writing it on exactly the slices this control
		// plane exists to make possible, and a fourth entry point would forget it entirely.
		if (onAuthorityResolved && authority.configScope) {
			onAuthorityResolved({
				scope: authority.configScope.scope,
				scopeId: authority.configScope.scopeId,
			});
		}
		return {
			authority,
			ctx: stampRedactionContainer(ctx, recording, runId),
		};
	};

	const assertYieldable = (options: RuntimeRunOptions | undefined): void => {
		if (options?.deadlineAt !== undefined && !runCheckpointStore) {
			throw configurationError(
				"deadline yields require a database-backed run checkpoint store",
			);
		}
	};

	// Shared body for generate + stream. `onDelta` present → drive the streaming vendor, pushing
	// REDACTED deltas as the model produces them (the stream carries what the transcript carries);
	// absent → generate whole.
	const invoke = async (
		prompt: string,
		ctx: Record<string, unknown> | undefined,
		options: RunOptionsFor<Config> | undefined,
		onDelta?: (text: string) => void | Promise<void>,
	): Promise<RuntimeResult> => {
		const state = createRunState();
		state.runInstanceId = newId("runstate");
		state.abortSignal = options?.abortSignal;
		state.runMode = options?.runMode ?? "autonomous";
		state.callerPrincipal = options?.[RUNTIME_CALLER_OPTION];
		abortIfNeeded(options?.abortSignal);
		assertYieldable(options);
		const recording = options?.[RUNTIME_RECORDING_OPTION];
		state.recording = recording;
		// A RECORDED run's claw comes from its recording; an unrecorded one may still belong to a claw
		// and say so through this. Recording wins, so the two can never disagree about one fact.
		state.clawId = recording?.clawId ?? options?.[RUNTIME_CLAW_OPTION];
		// Every run gets an id, including an ad-hoc `generate` that has no claw and no thread to be
		// named by. Minted LAST — a caller's durable run id wins, then the recording's (so a recorded
		// run keeps one id, not two) — and it is what the gated call is stamped with and what a parked
		// approval records, so the two are joinable for a run that has nothing else to join on.
		state.runId = options?.runId ?? recording?.runId ?? newId("run");
		const emitCtx = { recording, runId: state.runId };
		// BEFORE tools: the tool resolver closure-captures the principal and scope it is handed, and the
		// floor must decide about the same ones.
		const { authority, ctx: resolvedCtx } = await resolveRunAuthorityAndContext(
			ctx,
			state.callerPrincipal,
			recording,
			state.runId,
			options?.onAuthorityResolved,
		);
		state.authority = authority;
		const { runTools, projection } = await resolveRunTools(resolvedCtx);
		const selected = selectModel(options?.model);
		if (onDelta !== undefined) {
			if (!loop.stream) {
				throw configurationError(
					"the configured model-loop vendor does not support streaming",
				);
			}
			// Streaming a rawPii model would emit raw deltas that can't yet be re-redacted for durable
			// state — refuse rather than silently persist raw.
			if (selected.rawPii) {
				throw configurationError(
					"streaming is not supported for a noPiiRedaction model yet",
				);
			}
		}
		const core = createRunCore(state, approvalStore, runTools);
		// Ingress redaction ALWAYS runs — durable state (transcript, mappings, subjects) stays
		// tokenized even for a noPiiRedaction model. Raw only happens at the model boundary (rawPii
		// below): the loop rehydrates the prompt for that model and re-redacts its output.
		const redactedPrompt = String(await redactValue(prompt, resolvedCtx));
		await emitEvent(emitCtx, {
			prompt: redactedPrompt,
			type: "run.started",
		});
		// R-M04. A `rehydrate` was built here and handed to the loop, which turned every streamed
		// placeholder back into its real value on the way to the reader. That contradicted the api
		// layer's own stated rule — "re-identifying deltas as they fly past would put raw PII on the
		// wire under a flag meant for one audited read" — and it meant the transcript and the stream
		// disagreed about what the run had said, with the stream being the leaky one.
		//
		// Streamed deltas are now redacted like everything else the run persists (see
		// `createStreamGuard`), so there is nothing to hand over. A caller who wants the original
		// reads it back through `listMessages`: one audited read of a finished value.
		const driver =
			onDelta !== undefined && loop.stream ? loop.stream : loop.generate;
		// `usage` rides the loop result only as far as the terminal event — never the public result.
		const { usage: runUsage, ...result } = await driver({
			model: selected.model,
			rawPii: selected.rawPii,
			tools: projection.tools,
			resolveToolCall: projection.resolveCall,
			knownToolPath: projection.hasPath,
			system: config.system,
			prompt: redactedPrompt,
			ctx,
			resolvedCtx,
			core,
			state,
			maxSteps,
			now,
			abortSignal: options?.abortSignal,
			deadlineAt: options?.deadlineAt,
			persistYieldCheckpoint: yieldCheckpointPersister(state),
			...(options?.control && state.runId
				? {
						controlPoint: controlPointFor(options.control, state.runId),
						...(options.control.armInterrupt
							? { armInterrupt: armInterruptFor(options.control, state.runId) }
							: {}),
					}
				: {}),
			emitEvent: (payload) => emitEvent(emitCtx, payload),
			redactValue: (value) => redactValue(value, resolvedCtx),
			onDelta,
		});
		const valid = RuntimeResult(result);
		if (valid instanceof ark.errors) {
			throw validationError("runtime.generate result invalid", valid.summary);
		}
		await emitRunOutcome(emitCtx, valid, runUsage);
		return valid;
	};

	const generate = (
		prompt: string,
		ctx?: Record<string, unknown>,
		options?: RunOptionsFor<Config>,
	): Promise<RuntimeResult> => invoke(prompt, ctx, options);

	const stream = (
		prompt: string,
		ctx?: Record<string, unknown>,
		options?: RunOptionsFor<Config>,
	): RuntimeStream => {
		// A reader that walks away — the tab closes, the transport cancels, the consumer `break`s —
		// is not the same event as the work becoming worthless, and the difference is whether the
		// answer has anywhere to land.
		//
		// DETACH when the run is recorded. The transcript sink is writing to the claw's thread, so
		// finishing the run puts the answer where the reader will look for it when they come back —
		// which is the behaviour anyone who has closed a chat tab expects. The deltas are dropped as
		// they arrive (the channel discards once cancelled, so nothing accumulates) and `result`
		// settles normally. Losing a completed answer to save the tail of one generation is a bad
		// trade: the tokens are already mostly spent, and the answer is the entire point.
		//
		// ABORT when it is not. An ad-hoc run with no claw and no thread has nowhere to put what it
		// produces, so with no reader there is nothing left to serve — every further token, tool call
		// and side effect is spent on output that cannot be read now or later.
		const readerGone = createRuntimeAbortController();
		const persisted =
			config.recording !== undefined &&
			options?.[RUNTIME_RECORDING_OPTION] !== undefined;
		const channel = createDeltaChannel({
			onCancel: () => {
				if (!persisted) readerGone.abort();
			},
		});
		const runOptions = {
			...options,
			abortSignal: combinedAbortSignal(options?.abortSignal, readerGone.signal),
		} as RunOptionsFor<Config>;
		const result = invoke(prompt, ctx, runOptions, (text) =>
			channel.push(text),
		).finally(() => channel.close());
		// Abandoning an UNRECORDED stream rejects `result` with that abort — truthfully. A consumer
		// that awaits it still sees the rejection; this only keeps the one who walked away from
		// tripping an unhandled-rejection warning for a cancellation they asked for.
		result.catch(() => {});
		return { textStream: channel.iterable, result };
	};

	const continueRun = async (
		id: string,
		ctx?: Record<string, unknown>,
		options?: RunOptionsFor<Config>,
	): Promise<RuntimeResult | null> => {
		abortIfNeeded(options?.abortSignal);
		assertYieldable(options);
		const recording = options?.[RUNTIME_RECORDING_OPTION];
		if (!approvalStore) return null;
		const record = await approvalStore.get(id);
		if (!record) return null;

		const checkpoint = parseRuntimeApprovalMetadata(record.metadata);
		const effectiveRecording = recording ?? checkpoint.recording;
		// The resumed action belongs to the run that parked it, so its id is RESTORED from the
		// checkpoint rather than minted — the same rule resumeRun already follows for a yield. Nothing
		// is invented when an older checkpoint carries none: a fresh id here would name a second run.
		const effectiveRunId = options?.runId ?? checkpoint.runId;
		const emitCtx = { recording: effectiveRecording, runId: effectiveRunId };
		if (record.status === "denied") {
			const text = record.reason ?? "approval denied";
			await emitEvent(emitCtx, {
				decidedBy: record.decidedBy,
				reason: text,
				reasonCode: record.reasonCode,
				step: checkpoint.step,
				toolCallId: checkpoint.toolCallId,
				toolName: checkpoint.toolName,
				type: "tool.denied",
			});
			const result = {
				approvalId: id,
				decidedBy: record.decidedBy,
				reason: text,
				reasonCode: record.reasonCode,
				status: "denied",
				demands: [],
				steps: checkpoint.step + 1,
				text,
			};
			const valid = RuntimeDeniedResult(result);
			if (valid instanceof ark.errors) {
				throw validationError(
					"runtime.continueRun denied result invalid",
					valid.summary,
				);
			}
			await emitEvent(emitCtx, {
				approvalId: valid.approvalId,
				decidedBy: valid.decidedBy,
				reasonCode: valid.reasonCode,
				steps: valid.steps,
				text: valid.text,
				type: "run.denied",
			});
			return valid;
		}
		// A FINISHED approval is answered from what it produced, never re-run. This is the replay hole:
		// resume used to accept an already-taken record and re-enter the model loop, minting new
		// tool-call ids and new effects every time anyone asked.
		if (record.status === "completed") {
			if (record.result === undefined) return null;
			const stored = RuntimeResult(record.result);
			if (stored instanceof ark.errors) {
				throw validationError("stored approval result invalid", stored.summary);
			}
			return stored;
		}
		if (record.status !== "approved" && record.status !== "executing")
			return null;
		// WHOSE AUTHORITY the approved action executes under — fixed by the immutable approval record,
		// NOT by whoever calls continueRun. `requester` (default) keeps the action the requester's, the
		// approver merely vouching; `approver` LENDS the approver's authority, which is what makes an
		// escalation — an action the requester may not perform — actually execute. See
		// `approvalAuthority` and docs/plans/approvals-authz.md.
		//
		// Settled HERE, before the authority is resolved and the tools are picked. It used to be read
		// forty lines further down, after both — so the resume selected its tools and credentials for
		// whoever called `continueRun`, then ran the approved call as somebody else.
		const executingPrincipal =
			config.approvalAuthority === "approver"
				? record.decidedBy
				: record.principal;
		if (
			config.approvalAuthority === "approver" &&
			executingPrincipal === undefined
		) {
			// A granted approval always stamps `decidedBy` (the api stamps it from the authenticated
			// approver) — so this is an invariant violation, not a caller error. Fail LOUD: silently
			// running with no principal would look like a fail-closed deny for the wrong reason.
			throw stateError("approval resume cannot assume an absent approver", {
				approvalId: id,
			});
		}
		const { authority, ctx: resolvedCtx } = await resolveRunAuthorityAndContext(
			ctx,
			executingPrincipal,
			effectiveRecording,
			effectiveRunId,
			options?.onAuthorityResolved,
		);
		// TENANCY DRIFT. `scope`/`scopeId` are immutable columns on the record — the boundary the parked
		// run was executing in. A resume resolves a FRESH context from the caller's `ctx`, and nothing
		// compared the two: continuing under a different one selects another tenant's registered tools
		// and resolves another tenant's credentials for a call a human approved somewhere else. Not a
		// recoverable difference, so refuse rather than pick a side. R-H03.
		if (!sameConfigScope(authority.configScope, record)) {
			throw stateError(
				"the approved action belongs to a different boundary than this resume resolved",
				{
					approvalId: id,
					// The PAIR, not a rendering of it — the reader wants the two boundaries side by side,
					// and both are always values.
					approvedIn: { scope: record.scope, scopeId: record.scopeId },
					resumedIn: authority.configScope,
				},
			);
		}
		const { runTools, projection } = await resolveRunTools(resolvedCtx);
		// DRIFT. The tool is resolved fresh, as it must be — but a registered source can be
		// re-registered while an approval sits pending, and the address survives what it points at.
		// Resuming then runs an operation the human never read: same name, different path, schema or
		// governance. Refuse rather than dispatch onto it; a fresh approval is the honest recovery.
		const currentVersion = runTools[checkpoint.toolName]?.contentVersion;
		if (
			checkpoint.toolVersion !== undefined &&
			currentVersion !== checkpoint.toolVersion
		) {
			throw stateError(
				"the approved tool changed since it was approved — re-approve against the current definition",
				{
					approvalId: id,
					toolName: checkpoint.toolName,
					approvedVersion: checkpoint.toolVersion,
					currentVersion:
						currentVersion ?? "(the tool is no longer registered)",
				},
			);
		}
		// TAKE the lease — AFTER the checks that can refuse. Taking first would leave a drifted or
		// otherwise unrunnable approval sitting `executing` until the lease lapsed, so nobody could
		// re-decide it for fifteen minutes and every recovery would re-take it only to refuse again.
		// Null means it cannot be taken: not granted, expired, or being run right now by someone whose
		// lease has not lapsed. Recovery of an abandoned execution is the `executing` case above plus a
		// lapsed lease, and the store decides that, not the caller.
		const approvalLeaseMs = config.approvalLeaseMs ?? APPROVAL_LEASE_MS;
		const claimed = await approvalStore.claim(id, approvalLeaseMs);
		if (!claimed) return null;
		// The keepalive covers everything this runner does while holding the lease — the approved tool
		// is REPLAYED below, before the model loop, and that replay is exactly the slow part a fixed
		// lease could not outlive.
		//
		// Its abort reaches the LOOP, not `state.abortSignal`, and the difference is the whole design.
		// `state.abortSignal` is checked after a tool returns, immediately before the effect is
		// recorded — so routing the lease through it made a lost lease throw away the ledger entry for
		// a side effect that had ALREADY happened, and marked it `failed`. The next runner would then
		// find a failed effect for work that succeeded. Fencing the CONTINUATION is right; fencing the
		// record of work already done is a duplicate side effect wearing a safety check.
		//
		// `combinedAbortSignal` keeps both halves platform signals where it can, so the composed one
		// still reaches the model vendor's fetch instead of only tripping a cooperative check.
		let leaseLost = false;
		const leaseAbort = createRuntimeAbortController();
		const callerSignal = options?.abortSignal;
		const loopSignal = combinedAbortSignal(callerSignal, leaseAbort.signal);
		const supersededError = () =>
			stateError("approval execution lost its lease mid-run", {
				approvalId: id,
				reason:
					"another runner reclaimed it; retry once that runner has recorded its result",
			});
		const stopHeartbeat = startApprovalHeartbeat({
			store: approvalStore,
			approvalId: id,
			leaseId: claimed.leaseId,
			leaseMs: approvalLeaseMs,
			abortController: leaseAbort,
			onLost: () => {
				leaseLost = true;
			},
		});
		try {
			const selected = selectModel(options?.model);

			const state = createRunState();
			state.runInstanceId = `approval:${id}`;
			state.abortSignal = callerSignal;
			state.runMode = options?.runMode ?? "autonomous";
			state.callerPrincipal = executingPrincipal;
			state.authority = authority;
			// The approver (the granted approval's `decidedBy`) rides into the replayed action's audit.
			state.approvedBy = record.decidedBy;
			state.recording = effectiveRecording;
			state.runId = effectiveRunId;
			state.currentToolCallId = checkpoint.toolCallId;
			state.currentToolPath = checkpoint.toolName;
			state.currentToolInput = checkpoint.toolInput;
			const checkpointMessages = checkpoint.messages;
			state.currentMessages = checkpointMessages;
			state.currentStep = checkpoint.step;
			state.currentApprovalWaitId = checkpoint.waitId;
			state.currentEffectId = `approval:${id}:tool:${checkpoint.toolCallId}`;

			// No shim. The old one substituted a consume that always succeeded, so an already-taken
			// approval could be re-run without limit — the single-use guarantee the store implemented was
			// deliberately handed a way around itself. The lease is taken above, once, by the layer that
			// can also finish it.
			const core = createRunCore(state, approvalStore, runTools);
			const toolStartedAt = Date.now();
			const toolResult = await core.continueRun(claimed.record, ctx);
			const toolDurationMs = Date.now() - toolStartedAt;
			if (!toolResult) return null;
			if (toolResult.status === "needs-approval") {
				throw stateError("approval resume required another approval", {
					approvalId: id,
					gateId: toolResult.gateId,
				});
			}

			// Ingress: the approved tool's output is redacted ONCE — the tool.completed event and the
			// resumed transcript share the same placeholder text.
			const output =
				toolResult.status === "ok"
					? await redactValue(toolResult.output, resolvedCtx)
					: governanceToolResult(toolResult);
			if (toolResult.status === "ok") {
				await emitEvent(emitCtx, {
					durationMs: toolDurationMs,
					...(state.currentEffectId !== undefined
						? { effectId: state.currentEffectId }
						: {}),
					...(output !== undefined ? { output } : {}),
					step: checkpoint.step,
					toolCallId: checkpoint.toolCallId,
					toolName: checkpoint.toolName,
					type: "tool.completed",
				});
			} else {
				await emitEvent(emitCtx, {
					reason: toolResult.reason,
					reasonCode: toolResult.reasonCode,
					step: checkpoint.step,
					toolCallId: checkpoint.toolCallId,
					toolName: checkpoint.toolName,
					type: "tool.denied",
				});
			}
			// The one place the resume touches the WIRE: the checkpoint stores the canonical path, and the
			// provider needs the result back under the name it emitted. `toolModelName` is total and
			// deterministic, so re-deriving reproduces exactly the name the offered toolset carries — no
			// second id to keep in sync, and nothing to drift if a tool is re-addressed (a re-addressed
			// tool fails CLOSED at dispatch above instead, which is the outcome we want). A call routed
			// through the `execute` meta-tool is the one case with nothing to re-derive — the provider
			// emitted the META-tool's name, and the target was never offered — so the checkpoint carries
			// that name for this line alone.
			const messages = [
				...checkpointMessages,
				toolResultMessage(
					checkpoint.toolCallId,
					checkpoint.toolWireName ?? toolModelName(checkpoint.toolName),
					output,
				),
			];

			const resumeState = createRunState();
			resumeState.runInstanceId = `${state.runInstanceId}:resume`;
			resumeState.abortSignal = options?.abortSignal;
			resumeState.runMode = options?.runMode ?? "autonomous";
			// The run CONTINUES under the same authority the approved action ran with — carried explicitly,
			// or every tool call after a resume would be principal-less and fail closed at the tool floor.
			resumeState.callerPrincipal = executingPrincipal;
			resumeState.approvedBy = record.decidedBy;
			resumeState.recording = effectiveRecording;
			resumeState.runId = effectiveRunId;
			resumeState.abortSignal = callerSignal;
			// Post-resume steps only — the terminal event's usage is honest about this invocation.
			const loopResult = await loop.generate({
				model: selected.model,
				rawPii: selected.rawPii,
				tools: projection.tools,
				resolveToolCall: projection.resolveCall,
				knownToolPath: projection.hasPath,
				system: config.system,
				messages,
				startStep: checkpoint.step + 1,
				ctx,
				resolvedCtx,
				core: createRunCore(resumeState, approvalStore, runTools),
				state: resumeState,
				maxSteps,
				now,
				abortSignal: loopSignal,
				deadlineAt: options?.deadlineAt,
				persistYieldCheckpoint: yieldCheckpointPersister(resumeState),
				...(options?.control && resumeState.runId
					? {
							controlPoint: controlPointFor(options.control, resumeState.runId),
						}
					: {}),
				emitEvent: (payload) => emitEvent(emitCtx, payload),
				redactValue: (value) => redactValue(value, resolvedCtx),
			});
			const { usage: runUsage, ...result } = loopResult;
			if (leaseLost) {
				// Stopped because the lease went, not because the work finished. Nothing this runner
				// computed counts, and `complete` below would refuse it anyway.
				throw supersededError();
			}
			const valid = RuntimeResult(result);
			if (valid instanceof ark.errors) {
				throw validationError(
					"runtime.continueRun result invalid",
					valid.summary,
				);
			}
			// Close the lease FIRST, then announce. A `null` means the lease lapsed mid-run and a recovery
			// took over: this runner is STALE, and stale is not success. It used to emit a terminal event
			// and hand the caller its own result anyway, so one approval had two answers — the winner's,
			// persisted and served to every later resume, and this one's, which went to whoever happened to
			// hold this call, with no way to tell them apart. R-H08.
			const completed = await approvalStore.complete(
				id,
				claimed.leaseId,
				valid,
			);
			if (completed === null) {
				// The recovery owns the terminal answer. Serve THAT — it is what every later resume gets,
				// and the caller asked what happened to this approval, not what this process computed.
				const winner = await approvalStore.get(id);
				const stored = winner?.result;
				if (stored === undefined) {
					// Superseded, and the winner has not landed an answer yet. There is nothing honest to
					// return: this run's result is void and the real one does not exist. Fail loud rather
					// than invent either.
					throw stateError("approval execution was superseded mid-run", {
						approvalId: id,
						reason:
							"another runner reclaimed the lease; retry once it has recorded its result",
					});
				}
				const parsed = RuntimeResult(stored);
				if (parsed instanceof ark.errors) {
					throw validationError(
						"stored approval result invalid",
						parsed.summary,
					);
				}
				return parsed;
			}
			await emitRunOutcome(emitCtx, valid, runUsage);
			return valid;
		} catch (error) {
			// The abort surfaces as a generic "runtime aborted" from whichever boundary saw it first.
			// Naming the real reason here is the difference between an operator reading "something
			// stopped" and reading "another runner owns this now, retry after it lands".
			//
			// ONLY an abort is relabelled. Keying on `leaseLost` alone swallowed whatever else went
			// wrong during a run that happened to lose its lease — a gate returning an invalid decision
			// came back as "lost its lease", which sends the reader to the wrong problem entirely.
			const aborted =
				error instanceof BusyclawError &&
				error.details?.[ABORTED_DETAIL] === true;
			if (leaseLost && aborted) throw supersededError();
			throw error;
		} finally {
			// Always. A leaked beat would keep renewing the lease of a runner that has gone, which is
			// the exact failure the lease exists to end.
			stopHeartbeat();
		}
	};

	const resumeRun = async (
		checkpointId: string,
		ctx?: Record<string, unknown>,
		options?: RunOptionsFor<Config>,
	): Promise<RuntimeResult | null> => {
		abortIfNeeded(options?.abortSignal);
		if (!runCheckpointStore) return null;
		// CLAIM, not consume. Under concurrent continuations exactly one caller proceeds — but the row
		// is only retired once this slice has actually returned, below. Consuming up front meant a
		// process that died mid-resume left the checkpoint permanently untakeable, so every retry threw
		// and the run was marked `failed` with its transcript intact and unreachable.
		const claim = await runCheckpointStore.claim(checkpointId);
		if (!claim) return null;
		const record = claim.record;
		const checkpoint = parseRuntimeYieldMetadata(record.metadata);
		const recording =
			options?.[RUNTIME_RECORDING_OPTION] ?? checkpoint.recording;
		const runId = options?.runId ?? checkpoint.runId;
		const emitCtx = { recording, runId };
		const callerPrincipal = options?.[RUNTIME_CALLER_OPTION];
		const { authority, ctx: resolvedCtx } = await resolveRunAuthorityAndContext(
			ctx,
			callerPrincipal,
			recording,
			runId,
			options?.onAuthorityResolved,
		);
		// The same tenancy check the approval resume makes, against the boundary the yielding run
		// recorded on its checkpoint. A yield is a run continuing after a deadline, not a new run —
		// resuming it into a different tenant would finish it against another tenant's tools and
		// secrets. R-H03.
		if (!sameConfigScope(authority.configScope, checkpoint.authority)) {
			throw stateError(
				"the yielded run belongs to a different boundary than this resume resolved",
				{
					checkpointId,
					yieldedIn: checkpoint.authority,
					resumedIn: authority.configScope,
				},
			);
		}
		const { runTools, projection } = await resolveRunTools(resolvedCtx);
		const selected = selectModel(options?.model);

		const state = createRunState();
		state.runInstanceId = `checkpoint:${checkpointId}`;
		state.abortSignal = options?.abortSignal;
		state.runMode = options?.runMode ?? "autonomous";
		state.callerPrincipal = callerPrincipal;
		state.authority = authority;
		state.recording = recording;
		state.runId = runId;

		// Post-resume steps only — the terminal event's usage is honest about this invocation.
		const { usage: runUsage, ...result } = await loop.generate({
			model: selected.model,
			rawPii: selected.rawPii,
			tools: projection.tools,
			resolveToolCall: projection.resolveCall,
			knownToolPath: projection.hasPath,
			system: config.system,
			messages: checkpoint.messages,
			startStep: checkpoint.nextStep,
			// The transcript watermark travels with the transcript. Without it the resumed slice has no
			// way to tell a message that IS in these messages from one that was marked delivered and
			// then lost to a crash before it was ever pushed.
			...(checkpoint.deliveredThrough !== undefined
				? { deliveredThrough: checkpoint.deliveredThrough }
				: {}),
			ctx,
			resolvedCtx,
			core: createRunCore(state, approvalStore, runTools),
			state,
			maxSteps,
			now,
			abortSignal: options?.abortSignal,
			deadlineAt: options?.deadlineAt,
			persistYieldCheckpoint: yieldCheckpointPersister(state),
			...(options?.control && state.runId
				? { controlPoint: controlPointFor(options.control, state.runId) }
				: {}),
			emitEvent: (payload) => emitEvent(emitCtx, payload),
			redactValue: (value) => redactValue(value, resolvedCtx),
		});
		const valid = RuntimeResult(result);
		if (valid instanceof ark.errors) {
			throw validationError("runtime.resumeRun result invalid", valid.summary);
		}
		// The slice returned, so this checkpoint is spent — whatever the outcome. A `yielded` result
		// has already persisted its OWN successor checkpoint; retiring this one is what stops the pair
		// from both being resumable. A THROW deliberately skips this: the row stays `claimed`, its
		// lease lapses, and the retry re-claims it rather than finding a dead end.
		await runCheckpointStore.complete(checkpointId, claim.leaseId);
		await emitRunOutcome(emitCtx, valid, runUsage);
		return valid;
	};

	return {
		audit: config.audit,
		approvals: approvalStore,
		...(runCheckpointStore ? { checkpoints: runCheckpointStore } : {}),
		catalog,
		continueRun,
		effects: effectStore,
		generate,
		resumeRun,
		stream,
	};
}
