// The data contracts are arktype schemas: each one validates at a trust boundary
// AND infers its static type (single source of truth). The ports — behaviour, not
// data — stay function/object types. See docs/architecture/12-conventions.md.

import { type } from "arktype";
import type { JsonObject } from "../common";
import { jsonObject as jsonObjectSchema } from "../common";
import type { ToolDescriptor } from "../tools/descriptor";

// ── Data contracts (validate + infer) ───────────────────────────────────────

/** A tool the agent wants to call. Validated at ingress — the LLM is untrusted. */
export const toolCall = type({
	name: "string",
	args: jsonObjectSchema,
});
export type ToolCall = typeof toolCall.infer;

/** One normalized model message. Provider-specific prompt objects are normalized by adapters. */
export const modelMessage = type({
	role: "string",
	content: "string",
});
export type ModelMessage = typeof modelMessage.infer;

/** A model (LLM) request. The messages are redacted at the edge, like tool args. */
export const modelCall = type({
	"provider?": "string | undefined",
	"model?": "string | undefined",
	"parameters?": jsonObjectSchema.or("undefined"),
	"estimatedInputTokens?": "number | undefined",
	"estimatedOutputTokens?": "number | undefined",
	messages: modelMessage.array(),
});
export type ModelCall = typeof modelCall.infer;

export type ToolBoundaryCall = {
	boundary: "tool";
	name: string;
	payload: JsonObject;
	toolCall: ToolCall;
};

export type ModelBoundaryCall = {
	boundary: "model";
	name: "model";
	payload: JsonObject;
	modelCall: ModelCall;
};

/** What after-gates observe. Before-gates are still tool-only today. */
export type BoundaryCall = ToolBoundaryCall | ModelBoundaryCall;

/**
 * What a gate's handler returns. Validated — plugin gates are third-party code. On a deny/
 * needs-approval the gate may attach a `reasonCode` — a stable key into the plugin's
 * `$REASON_CODES`; governance fills the human `reason` from the catalog when the gate gives a
 * reason code but no reason. `reason` is optional here; governance guarantees it on the way out.
 */
/**
 * The DECLARED policy annotations that decided this call — `key → value`, read off the determining
 * policies (`@escalate("team:accessibility")` → `{ escalate: "team:accessibility" }`). The keys are
 * OPAQUE to governance: a plugin declares which it consumes ({@link PolicyAnnotationKind}) and owns
 * what the value means, exactly as `shareable` kinds are opaque labels with plugin-owned loaders. An
 * after-gate is where a plugin acts on them (route an escalation, feed its own queue) — governance
 * only carries the fact.
 *
 * One shape, TWO bags, split by the declaration's `audience` and never merged again: `annotations`
 * is the HOST's (the default) and `modelAnnotations` is the AGENT's. The split is made once, where
 * the declarations are known — the policy engine — so a host-audience value is not "filtered out" at
 * each model-facing door but structurally absent from the field those doors read.
 */
export const policyAnnotations = type({ "[string]": "string" });
export type PolicyAnnotations = typeof policyAnnotations.infer;

/**
 * The ceiling on ONE model-audience annotation value, in characters (~128 tokens). It is prose
 * addressed to an agent — a sentence or three of what to do instead, not a document — and unlike the
 * host bag it lands in a context window and a transcript, so it is bounded at the source: an engine REJECTS
 * an over-long value when it indexes the policy set, which is assembly time, not decision time. Same
 * class of failure as unparseable policy text, caught at the same moment.
 */
export const MODEL_ANNOTATION_MAX_LENGTH = 512;

export const gateDecision = type({ decision: "'permit'" })
	.or({
		decision: "'deny'",
		"reason?": "string",
		"reasonCode?": "string",
		"annotations?": policyAnnotations,
		"modelAnnotations?": policyAnnotations,
	})
	.or({
		decision: "'needs-approval'",
		"reason?": "string",
		"reasonCode?": "string",
		"annotations?": policyAnnotations,
		"modelAnnotations?": policyAnnotations,
	});
export type GateDecision = typeof gateDecision.infer;

/**
 * ONE gate's demand for human sign-off — which gate, and why.
 *
 * A call can attract several at once, and that is the ordinary case rather than an exotic one: the
 * policy engine's confirmation probe and a tool's own `govern({ gate })` are both before-gates, so any
 * governed write with its own confirmation in an autonomous run produces two. The pipeline used to
 * return on the FIRST objection, so a human was shown one demand, approved it, and the resume walked
 * into the next one with nowhere to put it.
 *
 * `(gateId, reasonCode)` is also the identity a resume matches on: an approval answers the demands it
 * was shown, and a demand that appears later is a new question, not a satisfied one.
 */
export const gateDemand = type({
	gateId: "string",
	reason: "string",
	"reasonCode?": "string",
});
export type GateDemand = typeof gateDemand.infer;

/** The outcome of handling one tool call — the SDK/wire contract. `reason` is always present on the
 * way out; `reasonCode` is the stable machine-readable key (when the deciding gate supplied one).
 *
 * `demands` carries EVERY gate that wanted approval, in gate order. On a `needs-approval` it is what
 * the human is asked to grant — all of it, at once, because approving one demand without being told a
 * second exists is a worse decision. On a `denied` it is what the call would ALSO have needed had it
 * not been denied outright: an operator learns everything that was wrong in one pass instead of
 * peeling gates off one at a time. `gateId`/`reason` on a denial stay the DENYING gate's. */
export const handleResult = type({ status: "'ok'", output: "unknown" })
	.or({
		status: "'denied'",
		gateId: "string",
		reason: "string",
		"reasonCode?": "string",
		demands: gateDemand.array(),
		"annotations?": policyAnnotations,
		"modelAnnotations?": policyAnnotations,
	})
	.or({
		status: "'needs-approval'",
		gateId: "string",
		reason: "string",
		"reasonCode?": "string",
		demands: gateDemand.array(),
		"annotations?": policyAnnotations,
		"modelAnnotations?": policyAnnotations,
	});
export type HandleResult = typeof handleResult.infer;

/** What an after-gate observes: the final result, or an error if the call threw. */
export type Outcome = HandleResult | { status: "error"; reason: string };

// ── Ports (function/object types — no runtime shape to validate) ─────────────

/** Per-turn context bag. Plugins read/write here; identity & reserved keys are folded in by plugins. */
export type TurnContext = Record<string, unknown>;

// The reserved context-key namespace prefix. Governance OWNS it: keys under `busyclaw__` are stripped
// from caller input and written only by trusted resolution. The engine enforces the strip; the prefix
// is a contract so plugins (skills' reserved tool names) and the runtime can recognise it.
export const RESERVED_CONTEXT_PREFIX = "busyclaw__";

// The well-known reserved context keys (the `busyclaw__` namespace). Governance OWNS the namespace and
// records the `principal`; the claw's identity/membership wiring populates these. Plugins read them.
export const PRINCIPAL_CONTEXT_KEY = "busyclaw__principal";
export const TEAM_CONTEXT_KEY = "busyclaw__team";
export const ROLE_CONTEXT_KEY = "busyclaw__role";
export const CLAW_ID_CONTEXT_KEY = "busyclaw__clawId";
export const THREAD_ID_CONTEXT_KEY = "busyclaw__threadId";
export const RUN_ID_CONTEXT_KEY = "busyclaw__runId";
export const SUBJECT_CONTEXT_KEY = "busyclaw__subjectId";
// The run's CONFIG SCOPE — the opaque `(scope, scopeId)` boundary its durable config belongs to (registered
// tools, policy slices, the facts overlay). Was a single `busyclaw__organizationId`, which made core
// assert that a boundary is an organization; an organization is a PLUGIN, so the pair is opaque here and
// some plugin gives the label meaning. DISTINCT from the redaction container below: this is "whose
// configuration governs this run", that is "which container may rehydrate this placeholder".
export const CONFIG_SCOPE_CONTEXT_KEY = "busyclaw__configScope";
export const CONFIG_SCOPE_ID_CONTEXT_KEY = "busyclaw__configScopeId";
// The redaction CONTAINMENT ref — a polymorphic (scope, scopeId) pointing at the container a
// redaction happened in (`claw:<clawId>` today, `memory:<kbId>` / `task:<taskId>` later). A PII
// placeholder rehydrates only within the same container. `scopeId` is a unique entity id, so the
// container implies its boundary — redaction stays scope-blind (no boundary key anywhere in pii).
export const SCOPE_CONTEXT_KEY = "busyclaw__scope";
export const SCOPE_ID_CONTEXT_KEY = "busyclaw__scopeId";
// How the run started — stamped by the runtime from mechanical fact (sendMessage/api.generate =
// interactive; engine/scheduled runs = autonomous), never claimed by a caller. Policies read it
// to attenuate borrowed authority: an autonomous run has no human present to confirm.
export const RUN_MODE_CONTEXT_KEY = "busyclaw__runMode";
// The approver of an action executed after a granted `needs-approval` — seeded by the runtime on resume
// from the ApprovalRecord's `decidedBy` (forge-proof, post-strip, only the trusted step sets it; never
// caller-claimed). The audit records it as `decidedBy` so the compliance chain shows who approved.
export const APPROVED_BY_CONTEXT_KEY = "busyclaw__approvedBy";

/**
 * The tools THIS RUN resolved beyond the static set — per-run registrations a boundary supplied
 * through `resolveTools`. Read by the governance floor so a registered tool is a decidable action
 * rather than one the model has never heard of.
 *
 * A SYMBOL, not a `busyclaw__` string key, and the difference is the point. The string keys are
 * stripped from caller input and re-stamped by trusted code, which works because they are strings a
 * body could otherwise carry. A symbol cannot survive JSON at all, so there is no forgery to strip:
 * only code holding this exact symbol can write it. `Symbol.for` so duplicated contract copies in one
 * dependency graph still read each other's.
 *
 * It carries DESCRIPTORS, not a built model — the floor owns how a descriptor becomes an action, and
 * the runtime should not have to know.
 */
export const RUN_ACTIONS_CONTEXT_KEY: unique symbol = Symbol.for(
	"busyclaw.runActions",
);

/** Attach this run's extra tool descriptors to a resolved context (trusted, post-strip). */
export function stampRunActions(
	ctx: Record<string, unknown>,
	descriptors: readonly ToolDescriptor[],
): void {
	if (descriptors.length === 0) return;
	(ctx as { [RUN_ACTIONS_CONTEXT_KEY]?: readonly ToolDescriptor[] })[
		RUN_ACTIONS_CONTEXT_KEY
	] = descriptors;
}

/** Read them back; empty when the run added nothing to the static set. */
export function runActionsOf(ctx: unknown): readonly ToolDescriptor[] {
	if (ctx === null || typeof ctx !== "object") return [];
	const found = (ctx as { [RUN_ACTIONS_CONTEXT_KEY]?: unknown })[
		RUN_ACTIONS_CONTEXT_KEY
	];
	return Array.isArray(found) ? (found as ToolDescriptor[]) : [];
}

/** The value vocabulary for `RUN_MODE_CONTEXT_KEY`. */
export type RunMode = "interactive" | "autonomous";

/** The policy-facing stamped identity facts, unprefixed — what engines put into request context. */
export type StampedFacts = {
	role?: string;
	team?: string;
	clawId?: string;
	configScope?: string;
	configScopeId?: string;
	runMode?: RunMode;
};

/**
 * Read the runtime-stamped identity facts from a resolution context, TYPED: validates the
 * reserved keys (a host stamping garbage is a config bug — fail LOUD, never silently unstamped)
 * and renames them to their policy-facing names. The one reader every policy engine shares —
 * call sites never Reflect/typeof-probe the reserved namespace. Undeclared keys (the caller's
 * own context, other reserved stamps) are ignored, not validated here.
 */
export const stampedFacts = type({
	// Literal keys — these ARE the *_CONTEXT_KEY constants above (arktype defs need literals;
	// tests/stamped-facts.test.ts builds its context from the constants to guard drift).
	"busyclaw__role?": "string",
	"busyclaw__team?": "string",
	"busyclaw__clawId?": "string",
	"busyclaw__configScope?": "string",
	"busyclaw__configScopeId?": "string",
	"busyclaw__runMode?": "'interactive' | 'autonomous'",
}).pipe(
	(stamps): StampedFacts => ({
		...(stamps.busyclaw__role !== undefined
			? { role: stamps.busyclaw__role }
			: {}),
		...(stamps.busyclaw__team !== undefined
			? { team: stamps.busyclaw__team }
			: {}),
		...(stamps.busyclaw__clawId !== undefined
			? { clawId: stamps.busyclaw__clawId }
			: {}),
		...(stamps.busyclaw__configScope !== undefined
			? { configScope: stamps.busyclaw__configScope }
			: {}),
		...(stamps.busyclaw__configScopeId !== undefined
			? { configScopeId: stamps.busyclaw__configScopeId }
			: {}),
		...(stamps.busyclaw__runMode !== undefined
			? { runMode: stamps.busyclaw__runMode }
			: {}),
	}),
);

/**
 * A trusted hook to enrich the (already reserved-key-stripped) context before gates run — the seam
 * where the claw stamps the resolved principal/team/role. Governance stays NEUTRAL: it runs this once per call
 * with the right ordering (after strip, before gates); it does not know what identity or membership
 * *are*. That resolution is claw-level wiring composed into this one hook.
 */
export type ContextResolver = (
	ctx: TurnContext,
) => TurnContext | Promise<TurnContext>;

/**
 * One check in the pipeline. The governance ships NONE — you register them.
 * The handler sees the REDACTED call (placeholders, not raw PII).
 */
export type Gate<Ctx extends TurnContext = TurnContext> = {
	id: string;
	matcher: (call: ToolCall, ctx: Ctx) => boolean;
	handler: (call: ToolCall, ctx: Ctx) => GateDecision | Promise<GateDecision>;
	/** A sealed gate cannot be removed, replaced, or disabled once registered. */
	sealed?: boolean;
};

/** A boundary-level decision gate. Current use: model/tool; future use: memory/channel/etc. */
export type BoundaryGate<Ctx extends TurnContext = TurnContext> = {
	id: string;
	matcher: (call: BoundaryCall, ctx: Ctx) => boolean;
	handler: (
		call: BoundaryCall,
		ctx: Ctx,
	) => GateDecision | Promise<GateDecision>;
	sealed?: boolean;
};

/**
 * An after-gate observes a finished call (the canonical one is audit). It runs in a
 * finally — even when a before-gate denied or the tool threw — so a sealed after-gate
 * is a guaranteed record. It observes; it does not decide.
 *
 * `warn` is the HOST's one operator-notice door (`RuntimeConfig.warn`), handed in rather than read
 * off the plugin's own options: an after-gate is the one gate class that must SWALLOW its failures
 * (throwing here runs inside governance's `finally` and would mask the call's real outcome), and a
 * swallowed failure an operator never sees is the failure mode this argument exists to prevent.
 * Always supplied — governance resolves it (default `console.warn`) before it runs a single gate —
 * so a handler never `?.`-chains it. Before-gates get no such door: they decide, they don't swallow.
 */
export type AfterGate<Ctx extends TurnContext = TurnContext> = {
	id: string;
	matcher: (call: BoundaryCall, ctx: Ctx) => boolean;
	handler: (
		call: BoundaryCall,
		ctx: Ctx,
		outcome: Outcome,
		warn: (message: string) => void,
	) => void | Promise<void>;
	sealed?: boolean;
};

/** Handed to the tool runner so it can rehydrate PII *inside* its own boundary. */
export type ToolBoundary = {
	rehydrate: <T>(value: T) => Promise<T>;
	/**
	 * The CALLER's lifetime for this one call, when the caller has one narrower than the run's.
	 *
	 * A nested call is the case that needs it. A sandbox execution ends — deadline, error, clean
	 * return — and the host work it started should end with it, but the run it belongs to is still
	 * going, so the run's own signal says nothing. Without a channel for the caller's signal the
	 * guest's promise rejects while the socket it was waiting on runs to completion: the guest sees a
	 * timeout, the host does not, and a guest can retire promises faster than the host retires
	 * connections.
	 *
	 * COMBINED with the run's signal by the runner, never substituted for it — this narrows a
	 * lifetime and must not be able to widen one. Absent for an ordinary top-level call, where the
	 * run's signal already is the caller's.
	 */
	signal?: AbortLifetime;
};

/**
 * A lifetime that ends — `AbortSignal`'s shape, named structurally.
 *
 * Contracts builds without the DOM lib, which is where TypeScript keeps `AbortSignal`, and that is a
 * deliberate line: this package is the protocol every tier shares, including ones with no browser
 * globals at all. `SandboxFetch` mirrors `fetch` for the same reason. A real `AbortSignal` satisfies
 * this, so callers pass one and nothing casts.
 */
export type AbortLifetime = {
	readonly aborted: boolean;
	addEventListener: (type: "abort", listener: () => void) => void;
};

/** Executes a permitted tool. Receives the REDACTED call; rehydrate only what you need. */
export type ToolRunner = (
	call: ToolCall,
	ctx: TurnContext,
	boundary: ToolBoundary,
) => unknown | Promise<unknown>;

/** Invokes the model. Receives the REDACTED call; returns the opaque model result. */
export type ModelRunner = (
	call: ModelCall,
	ctx: TurnContext,
) => unknown | Promise<unknown>;
