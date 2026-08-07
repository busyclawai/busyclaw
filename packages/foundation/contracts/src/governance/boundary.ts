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
/**
 * Every boundary this principal BELONGS TO, and their role in each.
 *
 * Replaced a singular `busyclaw__team` + `busyclaw__role` pair. That pair made core assert two things it
 * has no business asserting: that a boundary is a *team* (an organization is a plugin — the same reason
 * `organizationId` became the opaque `(scope, scopeId)` pair), and that a principal is in exactly ONE of
 * them with exactly ONE role. Neither survives contact with a real deployment: people sit in several
 * teams, and "admin of payments, member of platform" has no singular `context.role`.
 *
 * The `(scope, scopeId)` halves are OPAQUE here — some plugin gives the label meaning. The string form a
 * policy matches on (`<scope>:<scopeId>`) is deliberately the SAME one `grantReaches` compares, so
 * membership reads identically on the tool floor and in the api PEP instead of being two vocabularies.
 */
export const MEMBERSHIPS_CONTEXT_KEY = "busyclaw__memberships";
export const CLAW_ID_CONTEXT_KEY = "busyclaw__clawId";
export const THREAD_ID_CONTEXT_KEY = "busyclaw__threadId";
export const RUN_ID_CONTEXT_KEY = "busyclaw__runId";
/**
 * The plugin-contributed fact bag — see `RunFactResolver`.
 *
 * ONE RESERVED KEY HOLDING A RECORD, rather than letting plugins stamp `busyclaw__*` keys of their
 * own. Those are the runtime's own namespace and are STRIPPED from caller input on the way in; a
 * plugin writing there would be indistinguishable from a caller trying to forge one, and could shadow
 * `busyclaw__principal`. Inside the bag a plugin can only collide with itself.
 */
export const FACTS_CONTEXT_KEY = "busyclaw__facts";

/**
 * One fact → the tags a policy can match on: the key alone, and the key with its value.
 *
 * Both, because they answer different questions and only one of them is knowable in advance. "Is this
 * a subagent at all" is `contains("subagents.agentDepth")` — the asker does not know the depth. "Is it
 * a direct child" is `contains("subagents.agentDepth:1")`.
 */
export function runFactTags(
	pluginId: string,
	key: string,
	value: string | number | boolean,
): [string, string] {
	const name = `${pluginId}.${key}`;
	return [name, `${name}:${String(value)}`];
}
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
/** WHICH PII NAMESPACE this turn reads and mints in — an ENTITY reference (`claw`, `run`, a plugin
 *  id), not a tenancy boundary. See pii-container.ts for why the two are different dimensions and why
 *  sharing one name cost a silent class of bug. */
export const PII_CONTAINER_KIND_CONTEXT_KEY = "busyclaw__piiContainerKind";
export const PII_CONTAINER_ID_CONTEXT_KEY = "busyclaw__piiContainerId";
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

/**
 * ONE membership: the opaque boundary a principal belongs to, and their role in it.
 *
 * `role` is OPTIONAL because belonging and ranking are different facts — a deployment can answer "which
 * boundaries is this person in" without having a role vocabulary at all, and a membership with no role
 * still decides every `scopes.contains(…)` policy.
 */
export type Membership = {
	scope: string;
	scopeId: string;
	role?: string;
};

/** The `<scope>:<scopeId>` string a policy matches a membership on — the SAME form `grantReaches`
 *  compares a labelled grant against, so the two never drift into separate vocabularies. */
export function membershipScopeRef(membership: Membership): string {
	return `${membership.scope}:${membership.scopeId}`;
}

/** The `<scope>:<scopeId>#<role>` string a policy matches a ROLE-IN-A-BOUNDARY on. Scoped on purpose:
 *  the old global `context.role == "admin"` could not say WHERE someone was an admin, so a role held in
 *  one boundary answered for every other one. */
export function membershipRoleRef(membership: Membership): string | undefined {
	return membership.role === undefined
		? undefined
		: `${membershipScopeRef(membership)}#${membership.role}`;
}

/** The policy-facing stamped identity facts, unprefixed — what engines put into request context. */
export type StampedFacts = {
	memberships?: readonly Membership[];
	clawId?: string;
	configScope?: string;
	configScopeId?: string;
	runMode?: RunMode;
	/** Plugin-contributed tags: `<pluginId>.<key>` and `<pluginId>.<key>:<value>`. See
	 *  `RunFactResolver`. A SET because a Cedar schema cannot declare an open record — the same reason
	 *  `memberships` reaches a policy as flat `scopes`/`roles`. */
	facts?: readonly string[];
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
	"busyclaw__memberships?": type({
		scope: "string",
		scopeId: "string",
		"role?": "string",
	}).array(),
	"busyclaw__clawId?": "string",
	"busyclaw__configScope?": "string",
	"busyclaw__configScopeId?": "string",
	"busyclaw__runMode?": "'interactive' | 'autonomous'",
	// A SET OF TAGS, not a record, and that is forced by Cedar rather than chosen: a schema declares
	// named attributes, so an open string-keyed map cannot be validated. `scopes` and `roles` are the
	// same shape for the same reason — open-ended values the runtime cannot name in advance, projected
	// into `Set<String>`. Each fact appears twice: `<plugin>.<key>` (it exists) and
	// `<plugin>.<key>:<value>` (what it is).
	"busyclaw__facts?": "string[]",
}).pipe(
	(stamps): StampedFacts => ({
		...(stamps.busyclaw__memberships !== undefined
			? { memberships: stamps.busyclaw__memberships }
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
		...(stamps.busyclaw__facts !== undefined
			? { facts: stamps.busyclaw__facts }
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
