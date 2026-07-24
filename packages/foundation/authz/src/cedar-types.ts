// The Cedar engine's configuration and context types. The engine impl lives in ./cedar-engine, the
// request mapper + escape-hatch plugin in ./cedar-plugin. (The `cedar()` policy-text SOURCE and its
// CedarSourceConfig live in @euroclaw/policy-cedar.)

import type { Entities } from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyAnnotationKind } from "@euroclaw/contracts";
import type { NamedPolicies } from "./policy-bundle";
import type {
	AuthzModel,
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
	ToolCall,
	TurnContext,
} from "@euroclaw/contracts";

/**
 * Cedar's request context — the resolved per-call turn context bag. The mapper reads the acting
 * identity from the ONE stamped `euroclaw__principal` (via `PRINCIPAL_CONTEXT_KEY`) and the spoof-proof
 * facts (role/team/runMode/…) the trusted assembly stamped; approval state is derived server-side.
 * NOT `{ principal: string }` any more (audit #7): the caller never supplies the principal on `run`'s
 * ctx — it is SEEDED from the authenticated caller in the trusted step — so the `$InferContext` fold
 * this feeds must not force an unprefixed `principal` onto `run(prompt, ctx)`.
 */
export type CedarContext = TurnContext;

/**
 * A Cedar `PolicyEngine` that ALSO accepts per-DECISION entities. The base `authorize(req)` evaluates
 * against the engine's construction-time entity directory; the product-api PEP additionally passes the
 * request's own Principal/Resource/Access graph (owner/scope/grant are entity `in` / attribute compares,
 * not context facts), which the engine merges under the directory for that one decision. A caller with
 * only a `PolicyRequest` uses the base overload — `CedarEngine` is a strict widening of `PolicyEngine`.
 */
export type CedarEngine = PolicyEngine & {
	authorize: (
		req: PolicyRequest,
		entities?: Entities,
	) => Promise<PolicyResult>;
};

/** Entities: a static array, or a PROVIDER the engine re-reads per decision (the reload seam). */
export type CedarEntitiesInput =
	| Entities
	| (() => Entities | Promise<Entities>);

export type CedarEngineConfig = {
	/** The policy set. Prefer a NAMED set (`loadPolicyBundle`'s `name → cedar text`): the name is what a
	 *  decision's determining-policy trail reports and the audit persists, so it stays legible instead of
	 *  a positional `policy3`. Plain text is still accepted — Cedar then assigns its own positional ids. */
	policies: string | NamedPolicies;
	/** Policy ANNOTATION keys to surface on decisions — the allowlist plugins declare via
	 *  `plugin.policyAnnotations`. A declared key found on a DETERMINING policy rides out on
	 *  `PolicyResult.annotations`; anything undeclared is inert. Only meaningful for a NAMED set. */
	annotations?: readonly PolicyAnnotationKind[];
	/** Cedar schema text. Optional; when set, requests are validated against it. */
	schema?: string;
	/** Known entities — principals (with attrs/tags/groups) and resources: the synced directory.
	 *  Pass a function to re-read per decision (catalog sync, external syncers). */
	entities?: CedarEntitiesInput;
	/** Validate each request against the schema (needs `schema`). Default: true when `schema` is set. */
	validateRequest?: boolean;
	/** Context key for "confirmation was used" — the needs-approval probe. Default "confirmationUsed". */
	approvalFlag?: string;
};

/** The subset of config the default `mapCall` (request mapper) reads — shared by `cedarPolicyPlugin`
 *  (the engine-wrapper escape hatch) and the assembly's internal floor engine. */
export type CedarMapCallConfig = {
	/** The authorization model — switches the mapper to project `context.args` to the action's
	 *  declared subset and read the resource type from the model. Absent → full args, default types. */
	model?: AuthzModel;
	/** Entity type for the mapped principal (from the stamped `euroclaw__principal`). Default "User". */
	principalType?: string;
	/** Entity type for the mapped resource (the tool). Default "Tool". */
	resourceType?: string;
	/** Context key for "confirmation was used" — the needs-approval probe. Default "confirmationUsed". */
	approvalFlag?: string;
	/** Namespace the resource id as `<prefix>:<tool>` (default none — the bare tool name). */
	prefix?: string;
	/** The egress origin for an action, from its registered binding's server — stamped as the
	 *  spoof-proof `context.server` fact. Model-DERIVED, never caller-derived. */
	serverForAction?: (actionId: string) => string | undefined;
};

export type CedarPluginConfig = CedarEngineConfig & {
	/** The authorization model: renders the Cedar schema, merges the action hierarchy into the
	 *  entities, and switches `mapCall` to model-aware (projected-args filtering, resource types
	 *  from the model). Mutually exclusive with `schema`. */
	model?: AuthzModel;
	/** Map a tool call + Cedar context to (principal, action, resource, context). Override for ABAC. */
	mapCall?: (call: ToolCall, ctx: CedarContext) => PolicyRequest;
	/** The egress origin for an action, from its registered binding's server — stamped as the
	 *  spoof-proof `context.server` fact so egress becomes policy-visible. Model-DERIVED (like
	 *  `entities`), never caller-derived: it comes from the registered model, not `req.context`, so a
	 *  caller/model cannot forge it and a tool cannot target a server other than the one it declares. */
	serverForAction?: (actionId: string) => string | undefined;
	/** Which calls Cedar governs. Default: every call (the allowlist). */
	matcher?: (call: ToolCall, ctx: CedarContext) => boolean;
	/** Entity type for the default-mapped principal (from the stamped `euroclaw__principal`). Default "User". */
	principalType?: string;
	/** Entity type for the default-mapped resource (the tool itself). Default "Tool". */
	resourceType?: string;
	/** Namespace the resource id as `<prefix>:<tool>` (default none — the bare tool name). */
	prefix?: string;
	/** Gate/plugin id. Default "policy:cedar". */
	id?: string;
	/** Seal the gate — the org floor can't be removed or redefined. Default false. */
	sealed?: boolean;
};
