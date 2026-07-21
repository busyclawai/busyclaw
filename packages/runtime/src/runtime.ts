import type {
	ApprovalStore,
	AuditSink,
	EffectStore,
	EuroclawPlugin,
	InferContext,
	JsonObject,
	JsonValue,
	Redactor,
	RunMode,
	ToolEffectPolicy,
} from "@euroclaw/contracts";
import {
	type Adapter,
	CLAW_ID_CONTEXT_KEY,
	configurationError,
	jsonValue as jsonValueSchema,
	RESERVED_CONTEXT_PREFIX,
	RUN_ID_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	redactionContextFrom,
	stateError,
	THREAD_ID_CONTEXT_KEY,
	validationError,
} from "@euroclaw/contracts";
import { createGovernance, type Governance } from "@euroclaw/core";
import {
	createApprovalStore,
	createEffectStore,
	createRunCheckpointStore,
} from "@euroclaw/storage-durable";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ModelMessage, ToolSet, wrapLanguageModel } from "ai";
import { type as ark } from "arktype";
import { runAiSdkLoop, toolResultMessage } from "./ai-sdk-loop";
import {
	createToolCatalog,
	type ToolCatalog,
	toolEntriesFromToolSet,
} from "./catalog";
import {
	composeContext,
	type IdentityResolver,
	type MembershipResolver,
	type OrganizationResolver,
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
	NESTED_INVOKER_TOOL,
	type SubInvoke,
} from "./subinvoke";
import { modelFacingTools, registerToolGates, toolGovernance } from "./tools";

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
	/** How this run was triggered — set by the ENTRY POINT (euroclaw's sendMessage/continueRun stamp
	 *  "interactive"; the engine worker and direct calls leave it unset). Stamped into every gated
	 *  call as the spoof-proof `euroclaw__runMode` fact. Default "autonomous" — fail-closed, so an
	 *  unattended run can't silently satisfy a write policy that a human presence would gate. */
	runMode?: RunMode;
	readonly [RUNTIME_RECORDING_OPTION]?: RuntimeRecordingContext;
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
	tools?: ToolSet;
	/** Resolve extra tools for THIS run (an organization's registered tools) from the resolved turn
	 *  context, merged over the static `tools` ONCE per run. Code tools win name collisions — a
	 *  host tool is never shadowed by a registered upload; a colliding registered tool is skipped,
	 *  never silently substituted. Registrations are rare and decisions hot, so the merge is per-run,
	 *  not per tool call. */
	resolveTools?: (ctx: Record<string, unknown>) => ToolSet | Promise<ToolSet>;
	system?: string;
	redactor?: Redactor;
	organization?: OrganizationResolver;
	identity?: IdentityResolver;
	membership?: MembershipResolver;
	audit?: AuditSink;
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
	plugins?: readonly EuroclawPlugin[];
	maxSteps?: number;
};

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
	run: (
		prompt: string,
		ctx?: RunContext<Config>,
		options?: RunOptionsFor<Config>,
	) => Promise<RuntimeResult>;
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
		if (err instanceof Error && err.name === "EuroclawError") throw err;
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

// The shared resume state every wait kind persists: the REDACTED transcript view plus the
// recording identity to restore. Approval metadata adds the parked tool call; yield metadata adds
// the next step. See docs/plans/yield-continuation-plan.md (wait taxonomy).
const runtimeResumeStateShape = {
	messages: runtimeModelMessage.array(),
	"recording?": runtimeRecordingContext.or("undefined"),
} as const;

export const runtimeApprovalMetadata = ark({
	version: "'runtime.ai-sdk.v1'",
	waitId: "string",
	step: "number",
	toolCallId: "string",
	toolName: "string",
	toolInput: "unknown",
	...runtimeResumeStateShape,
});
export type RuntimeApprovalMetadata = typeof runtimeApprovalMetadata.infer;

export const runtimeYieldMetadata = ark({
	version: "'runtime.ai-sdk.yield.v1'",
	nextStep: "number",
	"runId?": "string | undefined",
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

export function createRuntime<const Config extends RuntimeConfig>(
	config: Config,
): Runtime<Config> {
	const selectModel = createModelSelector(config);
	const now = config.environment?.now ?? (() => new Date().toISOString());
	const newId = config.environment?.newId ?? defaultRuntimeNewId;
	const maxSteps = config.maxSteps ?? 8;
	const tools = config.tools ?? {};
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
		organization: config.organization,
	});
	const modelTools = modelFacingTools(tools);
	const catalog = createToolCatalog(toolEntriesFromToolSet(tools));

	// Merge a run's resolved tools over the static code tools: code tools WIN name collisions (a host
	// tool is never shadowed by a registered upload), and a colliding registered tool is skipped
	// loudly, never silently replaced.
	const mergeRunTools = (resolved: ToolSet): ToolSet => {
		const merged: ToolSet = { ...tools };
		for (const [name, tool] of Object.entries(resolved)) {
			if (name in tools) {
				warn(
					`euroclaw: registered tool "${name}" skipped — a code tool already owns that name`,
				);
				continue;
			}
			merged[name] = tool;
		}
		return merged;
	};
	// Resolve the run's tool set + model-facing view ONCE per run. With no resolver the precomputed
	// static sets are reused (zero cost); both dispatch (`runTools[name]`) and the model-facing view
	// see the SAME merged set.
	const resolveRunTools = async (
		resolvedCtx: Record<string, unknown>,
	): Promise<{ runTools: ToolSet; runModelTools: ToolSet }> => {
		if (!config.resolveTools) {
			return { runTools: tools, runModelTools: modelTools };
		}
		const runTools = mergeRunTools(await config.resolveTools(resolvedCtx));
		return { runTools, runModelTools: modelFacingTools(runTools) };
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

	const createRunCore = (
		state: RunState,
		approvalStoreOverride = approvalStore,
		runTools: ToolSet = tools,
		redactor: Redactor | undefined = config.redactor,
	) => {
		const resolveGovernanceContext = async (
			ctx: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			const resolved = resolveContext ? await resolveContext(ctx) : ctx;
			// Runtime-stamped, spoof-proof facts (the caller's euroclaw__ keys were already stripped).
			resolved[RUN_MODE_CONTEXT_KEY] = state.runMode;
			if (state.recording) {
				resolved[CLAW_ID_CONTEXT_KEY] = state.recording.clawId;
				resolved[THREAD_ID_CONTEXT_KEY] = state.recording.threadId;
				if (state.recording.runId !== undefined) {
					resolved[RUN_ID_CONTEXT_KEY] = state.recording.runId;
				}
			}
			return resolved;
		};
		const core = createGovernance({
			redactor,
			audit: config.audit,
			approvalStore: approvalStoreOverride,
			approvalMetadata: () => {
				const metadata: JsonObject = {
					version: "runtime.ai-sdk.v1",
					waitId: state.currentApprovalWaitId ?? "",
					step: state.currentStep,
					toolCallId: state.currentToolCallId,
					toolName: state.currentToolName,
					toolInput: toJsonValue(
						state.currentToolInput,
						"runtime approval tool input invalid",
					),
					messages: toJsonValue(
						state.currentMessages,
						"runtime approval messages invalid",
					),
				};
				if (state.recording !== undefined) {
					metadata.recording = toJsonValue(
						state.recording,
						"runtime approval recording invalid",
					);
				}
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
				if (!tool || typeof tool.execute !== "function") {
					throw stateError(`euroclaw: no executable tool "${call.name}"`, {
						toolName: call.name,
					});
				}
				const executeTool = tool.execute;
				// The stamp is read ONCE per call; invoker + effect both come from the validated view.
				const stamp = toolGovernance(tool, call.name);
				const isInvokerTool = stamp?.invoker === true;
				// An invoker tool is BRAIN, not edge: it runs untrusted model-authored code, so its args
				// must stay redacted (placeholders reach the guest). A normal tool is the trusted edge and
				// rehydrates. Nested calls the guest makes are re-redacted on the way back (nested runTool
				// below), so the guest only ever holds placeholders. Future: a "trusted/unredacted" sandbox
				// variant opts out here.
				const args = isInvokerTool ? call.args : await rehydrate(call.args);
				const execute = (abortSignal?: unknown) =>
					// Blessed seam cast: the AI-SDK ToolCallOptions type is closed; euroclaw extends it
					// with `subInvoke` for invoker-stamped capability tools only (least authority).
					executeTool(args, {
						toolCallId: state.currentToolCallId,
						messages: state.currentMessages,
						abortSignal: abortSignal as never,
						...(isInvokerTool ? { subInvoke } : {}),
					} as never);
				const effectPolicy = stamp?.effect;
				const outputMode = effectOutputMode(effectPolicy);
				if (!effectStore) return execute(state.abortSignal);
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
					if (!tool || typeof tool.execute !== "function") {
						throw stateError(`euroclaw: no executable tool "${call.name}"`, {
							toolName: call.name,
						});
					}
					const args = await rehydrate(call.args);
					const output = await tool.execute(args, {
						toolCallId: newId("nested"),
						messages: [],
						abortSignal: state.abortSignal as never,
						// v7 requires the toolsContext channel field; euroclaw injects capabilities
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
			if (target && toolGovernance(target, name)?.invoker === true) {
				return {
					status: "denied",
					gateId: "runtime:nested-invoke",
					reason: `tool "${name}" is a capability tool and cannot be invoked from nested execution`,
					reasonCode: NESTED_INVOKER_TOOL,
				};
			}
			// handleToolCall re-validates args at ingress (arktype jsonObject); the cast only
			// satisfies the port's JsonObject param for a value we keep as untrusted input.
			const result = await getNestedCore().handleToolCall(
				{ name, args: args as JsonObject },
				ctx,
			);
			// A nested needs-approval fails closed AS A VALUE — there is no durable way to park a
			// live nested execution. Convert to a denied result with a stable reason code.
			if (result.status === "needs-approval") {
				return {
					status: "denied",
					gateId: result.gateId,
					reason: `tool "${name}" requires approval and cannot be called from nested execution`,
					reasonCode: NESTED_APPROVAL_UNSUPPORTED,
				};
			}
			return result;
		};

		return core;
	};

	const resolveRunContext = async (
		ctxInput: Record<string, unknown> | undefined,
	): Promise<Record<string, unknown>> => {
		const ctx = stripReserved(ctxInput ?? {});
		return resolveContext ? await resolveContext(ctx) : ctx;
	};

	const assertYieldable = (options: RuntimeRunOptions | undefined): void => {
		if (options?.deadlineAt !== undefined && !runCheckpointStore) {
			throw configurationError(
				"deadline yields require a database-backed run checkpoint store",
			);
		}
	};

	const run = async (
		prompt: string,
		ctx?: Record<string, unknown>,
		options?: RunOptionsFor<Config>,
	): Promise<RuntimeResult> => {
		const state = createRunState();
		state.runInstanceId = newId("runstate");
		state.abortSignal = options?.abortSignal;
		state.runMode = options?.runMode ?? "autonomous";
		abortIfNeeded(options?.abortSignal);
		assertYieldable(options);
		const recording = options?.[RUNTIME_RECORDING_OPTION];
		state.recording = recording;
		state.runId = options?.runId;
		const emitCtx = { recording, runId: options?.runId };
		const resolvedCtx = await resolveRunContext(ctx);
		const { runTools, runModelTools } = await resolveRunTools(resolvedCtx);
		const selected = selectModel(options?.model);
		const core = createRunCore(state, approvalStore, runTools);
		// Ingress redaction ALWAYS runs — durable state (transcript, mappings, subjects) stays
		// tokenized even for a noPiiRedaction model. Raw only happens at the model boundary (rawPii
		// below): the loop rehydrates the prompt for that model and re-redacts its output.
		const redactedPrompt = String(await redactValue(prompt, resolvedCtx));
		await emitEvent(emitCtx, {
			prompt: redactedPrompt,
			type: "run.started",
		});
		// `usage` rides the loop result only as far as the terminal event — never the public result.
		const { usage: runUsage, ...result } = await runAiSdkLoop({
			model: selected.model,
			rawPii: selected.rawPii,
			tools: runModelTools,
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
		});
		const valid = RuntimeResult(result);
		if (valid instanceof ark.errors) {
			throw validationError("runtime.run result invalid", valid.summary);
		}
		await emitRunOutcome(emitCtx, valid, runUsage);
		return valid;
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
		const emitCtx = { recording: effectiveRecording, runId: options?.runId };
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
		if (record.status !== "approved" && record.status !== "consumed")
			return null;
		const resolvedCtx = await resolveRunContext(ctx);
		const { runTools, runModelTools } = await resolveRunTools(resolvedCtx);
		const selected = selectModel(options?.model);

		const state = createRunState();
		state.runInstanceId = `approval:${id}`;
		state.abortSignal = options?.abortSignal;
		state.runMode = options?.runMode ?? "autonomous";
		state.recording = effectiveRecording;
		state.runId = options?.runId;
		state.currentToolCallId = checkpoint.toolCallId;
		state.currentToolName = checkpoint.toolName;
		state.currentToolInput = checkpoint.toolInput;
		const checkpointMessages = checkpoint.messages;
		state.currentMessages = checkpointMessages;
		state.currentStep = checkpoint.step;
		state.currentApprovalWaitId = checkpoint.waitId;
		state.currentEffectId = `approval:${id}:tool:${checkpoint.toolCallId}`;

		const core = createRunCore(
			state,
			record.status === "consumed"
				? {
						...approvalStore,
						consume: async (approvalId) => (approvalId === id ? record : null),
					}
				: approvalStore,
			runTools,
		);
		const toolStartedAt = Date.now();
		const toolResult = await core.continueRun(id, ctx);
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
				: {
						__governance: toolResult.status,
						reason: toolResult.reason,
						reasonCode: toolResult.reasonCode,
					};
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
		const messages = [
			...checkpointMessages,
			toolResultMessage(checkpoint.toolCallId, checkpoint.toolName, output),
		];

		const resumeState = createRunState();
		resumeState.runInstanceId = `${state.runInstanceId}:resume`;
		resumeState.abortSignal = options?.abortSignal;
		resumeState.runMode = options?.runMode ?? "autonomous";
		resumeState.recording = effectiveRecording;
		resumeState.runId = options?.runId;
		// Post-resume steps only — the terminal event's usage is honest about this invocation.
		const { usage: runUsage, ...result } = await runAiSdkLoop({
			model: selected.model,
			rawPii: selected.rawPii,
			tools: runModelTools,
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
		const resolvedCtx = await resolveRunContext(ctx);
		const { runTools, runModelTools } = await resolveRunTools(resolvedCtx);
		const selected = selectModel(options?.model);

		const state = createRunState();
		state.runInstanceId = `checkpoint:${checkpointId}`;
		state.abortSignal = options?.abortSignal;
		state.runMode = options?.runMode ?? "autonomous";
		state.recording = recording;
		state.runId = runId;

		// Post-resume steps only — the terminal event's usage is honest about this invocation.
		const { usage: runUsage, ...result } = await runAiSdkLoop({
			model: selected.model,
			rawPii: selected.rawPii,
			tools: runModelTools,
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
		resumeRun,
		run,
	};
}
