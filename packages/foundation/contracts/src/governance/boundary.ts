// The data contracts are arktype schemas: each one validates at a trust boundary
// AND infers its static type (single source of truth). The ports — behaviour, not
// data — stay function/object types. See docs/architecture/12-conventions.md.

import { type } from "arktype";
import type { JsonObject } from "../common";
import { jsonObject as jsonObjectSchema } from "../common";

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
export const gateDecision = type({ decision: "'permit'" })
	.or({ decision: "'deny'", "reason?": "string", "reasonCode?": "string" })
	.or({
		decision: "'needs-approval'",
		"reason?": "string",
		"reasonCode?": "string",
	});
export type GateDecision = typeof gateDecision.infer;

/** The outcome of handling one tool call — the SDK/wire contract. `reason` is always present on the
 * way out; `reasonCode` is the stable machine-readable key (when the deciding gate supplied one). */
export const handleResult = type({ status: "'ok'", output: "unknown" })
	.or({
		status: "'denied'",
		gateId: "string",
		reason: "string",
		"reasonCode?": "string",
	})
	.or({
		status: "'needs-approval'",
		gateId: "string",
		reason: "string",
		"reasonCode?": "string",
	});
export type HandleResult = typeof handleResult.infer;

/** What an after-gate observes: the final result, or an error if the call threw. */
export type Outcome = HandleResult | { status: "error"; reason: string };

// ── Ports (function/object types — no runtime shape to validate) ─────────────

/** Per-turn context bag. Plugins read/write here; identity & reserved keys are folded in by plugins. */
export type TurnContext = Record<string, unknown>;

// The reserved context-key namespace prefix. Governance OWNS it: keys under `euroclaw__` are stripped
// from caller input and written only by trusted resolution. The engine enforces the strip; the prefix
// is a contract so plugins (skills' reserved tool names) and the runtime can recognise it.
export const RESERVED_CONTEXT_PREFIX = "euroclaw__";

// The well-known reserved context keys (the `euroclaw__` namespace). Governance OWNS the namespace and
// records the `actor`; the claw's identity/membership wiring populates these. Plugins read them.
export const ACTOR_CONTEXT_KEY = "euroclaw__actor";
export const TEAM_CONTEXT_KEY = "euroclaw__team";
export const ROLE_CONTEXT_KEY = "euroclaw__role";
export const CLAW_ID_CONTEXT_KEY = "euroclaw__clawId";
export const THREAD_ID_CONTEXT_KEY = "euroclaw__threadId";
export const RUN_ID_CONTEXT_KEY = "euroclaw__runId";
export const SUBJECT_CONTEXT_KEY = "euroclaw__subjectId";
export const ORGANIZATION_CONTEXT_KEY = "euroclaw__organizationId";
// The redaction CONTAINMENT ref — a polymorphic (scope, scopeId) pointing at the container a
// redaction happened in (`claw:<clawId>` today, `memory:<kbId>` / `task:<taskId>` later). A PII
// placeholder rehydrates only within the same container. `scopeId` is a unique entity id, so the
// container implies its tenant — redaction stays org-blind (no organizationId anywhere in pii).
export const SCOPE_CONTEXT_KEY = "euroclaw__scope";
export const SCOPE_ID_CONTEXT_KEY = "euroclaw__scopeId";
// How the run started — stamped by the runtime from mechanical fact (sendMessage/api.run =
// interactive; engine/scheduled runs = autonomous), never claimed by a caller. Policies read it
// to attenuate borrowed authority: an autonomous run has no human present to confirm.
export const RUN_MODE_CONTEXT_KEY = "euroclaw__runMode";

/** The value vocabulary for `RUN_MODE_CONTEXT_KEY`. */
export type RunMode = "interactive" | "autonomous";

/** The policy-facing stamped identity facts, unprefixed — what engines put into request context. */
export type StampedFacts = {
	role?: string;
	team?: string;
	clawId?: string;
	organizationId?: string;
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
	"euroclaw__role?": "string",
	"euroclaw__team?": "string",
	"euroclaw__clawId?": "string",
	"euroclaw__organizationId?": "string",
	"euroclaw__runMode?": "'interactive' | 'autonomous'",
}).pipe(
	(stamps): StampedFacts => ({
		...(stamps.euroclaw__role !== undefined
			? { role: stamps.euroclaw__role }
			: {}),
		...(stamps.euroclaw__team !== undefined
			? { team: stamps.euroclaw__team }
			: {}),
		...(stamps.euroclaw__clawId !== undefined
			? { clawId: stamps.euroclaw__clawId }
			: {}),
		...(stamps.euroclaw__organizationId !== undefined
			? { organizationId: stamps.euroclaw__organizationId }
			: {}),
		...(stamps.euroclaw__runMode !== undefined
			? { runMode: stamps.euroclaw__runMode }
			: {}),
	}),
);

/**
 * A trusted hook to enrich the (already reserved-key-stripped) context before gates run — the seam
 * where the claw stamps the resolved actor/team/role. Governance stays NEUTRAL: it runs this once per call
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
 */
export type AfterGate<Ctx extends TurnContext = TurnContext> = {
	id: string;
	matcher: (call: BoundaryCall, ctx: Ctx) => boolean;
	handler: (
		call: BoundaryCall,
		ctx: Ctx,
		outcome: Outcome,
	) => void | Promise<void>;
	sealed?: boolean;
};

/** Handed to the tool runner so it can rehydrate PII *inside* its own boundary. */
export type ToolBoundary = {
	rehydrate: <T>(value: T) => Promise<T>;
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
