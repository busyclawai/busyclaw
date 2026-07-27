import type {
	ApprovalStore,
	AuditSink,
	BusyclawPlugin,
	EffectStore,
	InferContext,
	JsonObject,
	JsonValue,
	Redactor,
	RunMode,
	TextDeltaStream,
	ToolDefinitionSet,
	ToolEffectPolicy,
} from "@busyclaw/contracts";
import {
	type Adapter,
	APPROVED_BY_CONTEXT_KEY,
	CLAW_ID_CONTEXT_KEY,
	configurationError,
	jsonValue as jsonValueSchema,
	PRINCIPAL_CONTEXT_KEY,
	RESERVED_CONTEXT_PREFIX,
	RUN_ID_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	redactionContextFrom,
	SCOPE_CONTEXT_KEY,
	SCOPE_ID_CONTEXT_KEY,
	stampRunActions,
	stateError,
	THREAD_ID_CONTEXT_KEY,
	toolDescriptors,
	toolModelName,
	validationError,
} from "@busyclaw/contracts";
import { createGovernance, type Governance } from "@busyclaw/core";
import {
	createApprovalStore,
	createEffectStore,
	createRunCheckpointStore,
} from "@busyclaw/storage-durable";
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
	createToolCatalog,
	type ToolCatalog,
	toolEntriesFromTools,
} from "./catalog";
import {
	type ConfigScopeResolver,
	composeContext,
	type IdentityResolver,
	type MembershipResolver,
} from "./context";
import {
	createRuntimeEvent,
	emitRuntimeEvent,
	eventSinksFrom,
	RUNTIME_RECORDING_OPTION,
	type RuntimeEventFanout,
	type RuntimeEventPayloadInput,
	type RuntimeEventSink,
	type RuntimeModelUsage,
	type RuntimeRecordingContext,
	runtimeRecordingContext,
} from "./events";
import { abortIfNeeded, createRunState, type RunState } from "./run-state";
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

export type RuntimeRunOptions = {
	abortSignal?: RuntimeAbortSignal;
	/** Durable run identity (engine run id) — scopes effect ids and events across attempts/slices. */
	runId?: string;
	/**
	 * Invocation soft deadline (ISO timestamp). Past it, the loop parks a yield checkpoint at the
	 * next end-of-tool-result and returns `yielded` instead of continuing. Requires a
	 * database-backed run checkpoint store.
	 */
	deadlineAt?: string;
	/** How this run was triggered — set by the ENTRY POINT (busyclaw's sendMessage/continueRun stamp
	 *  "interactive"; the engine worker and direct calls leave it unset). Stamped into every gated
	 *  call as the spoof-proof `busyclaw__runMode` fact. Default "autonomous" — fail-closed, so an
	 *  unattended run can't silently satisfy a write policy that a human presence would gate. */
	runMode?: RunMode;
	readonly [RUNTIME_RECORDING_OPTION]?: RuntimeRecordingContext;
	/** The authenticated caller principal — set only via {@link runtimeRunOptionsWithCaller} (symbol
	 *  key, forge-proof). Seeded as `busyclaw__principal` by the trusted context assembly. */
	readonly [RUNTIME_CALLER_OPTION]?: string;
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
	effectLeaseTtlMs?: number;
	database?: Adapter;
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
	text: "string",
	steps: "number",
	checkpointId: "string",
});
export type RuntimeYieldedResult = typeof RuntimeYieldedResult.infer;

export const RuntimeResult = RuntimeCompletedResult.or(
	RuntimeWaitingApprovalResult,
)
	.or(RuntimeDeniedResult)
	.or(RuntimeYieldedResult);
export type RuntimeResult = typeof RuntimeResult.infer;

export type RunContext<Config extends RuntimeConfig> = InferContext<Config>;

export type Runtime<Config extends RuntimeConfig = RuntimeConfig> = {
	generate: (
		prompt: string,
		ctx?: RunContext<Config>,
		options?: RunOptionsFor<Config>,
	) => Promise<RuntimeResult>;
	/** Stream the model's text to the reader while the run happens — deltas are rehydrated
	 *  (reader-facing), the transcript still persists placeholders. Requires a streaming loop vendor. */
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
	readonly effects?: EffectStore;
	/** The tool catalog read-path over this runtime's registered tools:
	 *  traversable tree (list), scoped search, and describe. Visibility only —
	 *  calling a tool still routes through the governance chokepoint. */
	readonly catalog: ToolCatalog;
};

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
	principal: string | undefined,
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
	return {
		get aborted() {
			return first.aborted || second.aborted;
		},
	};
}

type EffectAbortController = {
	signal: { aborted: boolean };
	abort: () => void;
};

function createEffectAbortController(): EffectAbortController {
	const Controller = (
		globalThis as { AbortController?: new () => EffectAbortController }
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
	abortController: EffectAbortController;
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

/** The streamed result of `runtime.stream`: the shared `TextDeltaStream` protocol shape with a
 *  concrete `result` — a promise of the final governed result (resolves when the run completes). */
export type RuntimeStream = TextDeltaStream & {
	readonly result: Promise<RuntimeResult>;
};

/** A minimal push→async-iterate queue backing `RuntimeStream.textStream`. */
function createDeltaQueue(): {
	push: (value: string) => void;
	close: () => void;
	iterable: AsyncIterable<string>;
} {
	const buffer: string[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	return {
		push: (value) => {
			buffer.push(value);
			wake?.();
			wake = undefined;
		},
		close: () => {
			closed = true;
			wake?.();
			wake = undefined;
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				while (true) {
					const next = buffer.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					if (closed) return;
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
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
	const adapter = config.database;
	if (adapter && config.redactor?.durable !== true) {
		throw configurationError(
			"database-backed runtime approvals require a durable redactor",
		);
	}
	const approvalStore = adapter ? createApprovalStore(adapter) : undefined;
	const effectStore =
		config.effectStore ?? (adapter ? createEffectStore(adapter) : undefined);
	const runCheckpointStore = adapter
		? createRunCheckpointStore(adapter, { now })
		: undefined;
	const resolveContext = composeContext({
		identity: config.identity,
		membership: config.membership,
		configScope: config.configScope,
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
		if (result.status === "completed") {
			await emitEvent(context, {
				steps: result.steps,
				text: result.text,
				type: "run.completed",
				usage,
			});
		} else if (result.status === "waiting_approval") {
			await emitEvent(context, {
				approvalIds: result.approvalIds,
				steps: result.steps,
				text: result.text,
				type: "run.waiting_approval",
				usage,
			});
		} else if (result.status === "yielded") {
			await emitEvent(context, {
				checkpointId: result.checkpointId,
				steps: result.steps,
				type: "run.yielded",
				usage,
			});
		}
	};

	// Binds the checkpoint store to a run's identity so the loop can park a yield without knowing
	// where checkpoints live. Undefined when no database is configured — the loop then cannot yield.
	const yieldCheckpointPersister = (state: RunState) =>
		runCheckpointStore
			? async (input: {
					nextStep: number;
					messages: ModelMessage[];
				}): Promise<string> => {
					const metadata: JsonObject = {
						version: "runtime.ai-sdk.yield.v1",
						nextStep: input.nextStep,
						messages: toJsonValue(
							input.messages,
							"runtime yield messages invalid",
						),
						...(state.runId !== undefined ? { runId: state.runId } : {}),
					};
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
	 * An ad-hoc run has no claw, so it stays unstamped — there is no container to name.
	 */
	const stampRedactionContainer = (
		ctx: Record<string, unknown>,
		recording: RuntimeRecordingContext | undefined,
	): Record<string, unknown> => {
		if (recording !== undefined) {
			ctx[SCOPE_CONTEXT_KEY] = "claw";
			ctx[SCOPE_ID_CONTEXT_KEY] = recording.clawId;
		}
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
			const resolved = resolveContext ? await resolveContext(ctx) : ctx;
			stampRunActions(resolved, runActions);
			// The authenticated caller SEEDS the one canonical principal. Done HERE — the trusted step,
			// after `stripReserved` cleared any caller-forged `busyclaw__` keys — so the seed can't be
			// spoofed. The caller IS the run's initiator, so it WINS over the `identity` resolver (which
			// `resolveContext` may have stamped): the resolver is the caller-LESS fallback (cron/engine
			// resume → a system principal). Absent caller AND absent resolver → no stamp → the tool floor
			// fails closed on a modeled action (cedarMapCall denies).
			if (state.callerPrincipal !== undefined) {
				resolved[PRINCIPAL_CONTEXT_KEY] = state.callerPrincipal;
			}
			// The approver of a resumed `needs-approval` (forge-proof: from the persisted, PEP-gated
			// ApprovalRecord's `decidedBy`, set on the resume path — never caller/model). Seeded HERE (the
			// trusted step, post-strip) so the replayed action's audit records WHO approved it.
			if (state.approvedBy !== undefined) {
				resolved[APPROVED_BY_CONTEXT_KEY] = state.approvedBy;
			}
			// Runtime-stamped, spoof-proof facts (the caller's busyclaw__ keys were already stripped).
			resolved[RUN_MODE_CONTEXT_KEY] = state.runMode;
			if (state.recording) {
				resolved[CLAW_ID_CONTEXT_KEY] = state.recording.clawId;
				resolved[THREAD_ID_CONTEXT_KEY] = state.recording.threadId;
			}
			stampRedactionContainer(resolved, state.recording);
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
				// An invoker tool is BRAIN, not edge: it runs untrusted model-authored code, so its args
				// must stay redacted (placeholders reach the guest). A normal tool is the trusted edge and
				// rehydrates. Nested calls the guest makes are re-redacted on the way back (nested runTool
				// below), so the guest only ever holds placeholders. Future: a "trusted/unredacted" sandbox
				// variant opts out here.
				const args = isInvokerTool ? call.args : await rehydrate(call.args);
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
				const abortController = createEffectAbortController();
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
				runTool: async (call, nestedCtx, { rehydrate }) => {
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
						abortSignal: state.abortSignal,
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

		const subInvoke: SubInvoke = async (name, args, ctx) => {
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

	const resolveRunContext = async (
		ctxInput: Record<string, unknown> | undefined,
		recording: RuntimeRecordingContext | undefined,
	): Promise<Record<string, unknown>> => {
		const ctx = stripReserved(ctxInput ?? {});
		const resolved = resolveContext ? await resolveContext(ctx) : ctx;
		return stampRedactionContainer(resolved, recording);
	};

	const assertYieldable = (options: RuntimeRunOptions | undefined): void => {
		if (options?.deadlineAt !== undefined && !runCheckpointStore) {
			throw configurationError(
				"deadline yields require a database-backed run checkpoint store",
			);
		}
	};

	// Shared body for generate + stream. `onDelta` present → drive the streaming vendor, pushing
	// rehydrated (reader-facing) deltas as the model produces them; absent → generate whole.
	const invoke = async (
		prompt: string,
		ctx: Record<string, unknown> | undefined,
		options: RunOptionsFor<Config> | undefined,
		onDelta?: (text: string) => void,
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
		// Every run gets an id, including an ad-hoc `generate` that has no claw and no thread to be
		// named by. Minted LAST — a caller's durable run id wins, then the recording's (so a recorded
		// run keeps one id, not two) — and it is what the gated call is stamped with and what a parked
		// approval records, so the two are joinable for a run that has nothing else to join on.
		state.runId = options?.runId ?? recording?.runId ?? newId("run");
		const emitCtx = { recording, runId: state.runId };
		const resolvedCtx = await resolveRunContext(ctx, recording);
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
		// placeholder → reader-facing text for streamed deltas; identity when there is no redactor.
		// Unused by generate (it never streams), so it's harmless to pass either way.
		const rehydrate = (text: string): Promise<string> => {
			if (config.redactor === undefined) return Promise.resolve(text);
			return config.redactor.rehydrateValue(
				text,
				redactionContextFrom(resolvedCtx),
			);
		};
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
			emitEvent: (payload) => emitEvent(emitCtx, payload),
			redactValue: (value) => redactValue(value, resolvedCtx),
			onDelta,
			rehydrateValue: rehydrate,
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
		const queue = createDeltaQueue();
		const result = invoke(prompt, ctx, options, (text) =>
			queue.push(text),
		).finally(() => queue.close());
		return { textStream: queue.iterable, result };
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
		const resolvedCtx = await resolveRunContext(ctx, effectiveRecording);
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
		const claimed = await approvalStore.claim(id, APPROVAL_LEASE_MS);
		if (!claimed) return null;
		const selected = selectModel(options?.model);

		const state = createRunState();
		state.runInstanceId = `approval:${id}`;
		state.abortSignal = options?.abortSignal;
		state.runMode = options?.runMode ?? "autonomous";
		// WHOSE AUTHORITY the approved action executes under — fixed by the immutable approval record,
		// NOT by whoever calls continueRun. `requester` (default) keeps the action the requester's, the
		// approver merely vouching; `approver` LENDS the approver's authority, which is what makes an
		// escalation — an action the requester may not perform — actually execute. See
		// `approvalAuthority` and docs/plans/approvals-authz.md.
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
		state.callerPrincipal = executingPrincipal;
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
		// Post-resume steps only — the terminal event's usage is honest about this invocation.
		const { usage: runUsage, ...result } = await loop.generate({
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
			abortSignal: options?.abortSignal,
			deadlineAt: options?.deadlineAt,
			persistYieldCheckpoint: yieldCheckpointPersister(resumeState),
			emitEvent: (payload) => emitEvent(emitCtx, payload),
			redactValue: (value) => redactValue(value, resolvedCtx),
		});
		const valid = RuntimeResult(result);
		if (valid instanceof ark.errors) {
			throw validationError(
				"runtime.continueRun result invalid",
				valid.summary,
			);
		}
		await emitRunOutcome(emitCtx, valid, runUsage);
		// Close the lease and record what this approval produced. Every later resume is served this
		// answer instead of executing again. A `null` here means the lease lapsed mid-run and a
		// recovery took over — that runner owns the terminal result now, so this one does not
		// overwrite it, and the caller still gets the result it computed.
		await approvalStore.complete(id, claimed.leaseId, valid);
		return valid;
	};

	const resumeRun = async (
		checkpointId: string,
		ctx?: Record<string, unknown>,
		options?: RunOptionsFor<Config>,
	): Promise<RuntimeResult | null> => {
		abortIfNeeded(options?.abortSignal);
		if (!runCheckpointStore) return null;
		// consume-once: under concurrent continuations exactly one caller proceeds.
		const record = await runCheckpointStore.consume(checkpointId);
		if (!record) return null;
		const checkpoint = parseRuntimeYieldMetadata(record.metadata);
		const recording =
			options?.[RUNTIME_RECORDING_OPTION] ?? checkpoint.recording;
		const runId = options?.runId ?? checkpoint.runId;
		const emitCtx = { recording, runId };
		const resolvedCtx = await resolveRunContext(ctx, recording);
		const { runTools, projection } = await resolveRunTools(resolvedCtx);
		const selected = selectModel(options?.model);

		const state = createRunState();
		state.runInstanceId = `checkpoint:${checkpointId}`;
		state.abortSignal = options?.abortSignal;
		state.runMode = options?.runMode ?? "autonomous";
		state.callerPrincipal = options?.[RUNTIME_CALLER_OPTION];
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
			ctx,
			resolvedCtx,
			core: createRunCore(state, approvalStore, runTools),
			state,
			maxSteps,
			now,
			abortSignal: options?.abortSignal,
			deadlineAt: options?.deadlineAt,
			persistYieldCheckpoint: yieldCheckpointPersister(state),
			emitEvent: (payload) => emitEvent(emitCtx, payload),
			redactValue: (value) => redactValue(value, resolvedCtx),
		});
		const valid = RuntimeResult(result);
		if (valid instanceof ark.errors) {
			throw validationError("runtime.resumeRun result invalid", valid.summary);
		}
		await emitRunOutcome(emitCtx, valid, runUsage);
		return valid;
	};

	return {
		audit: config.audit,
		approvals: approvalStore,
		catalog,
		continueRun,
		effects: effectStore,
		generate,
		resumeRun,
		stream,
	};
}
