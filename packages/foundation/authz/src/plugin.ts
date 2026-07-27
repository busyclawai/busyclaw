// The scaffolding that turns any PolicyEngine into a euroclaw plugin: a cross-cutting,
// deny-by-default before-gate that runs `mapCall → engine.authorize → GateDecision` on every
// matched call. Engine-neutral — it speaks PARC, never Cedar/OPA/better-auth.
//
// Each policy plugin declares the REQUEST CONTEXT it needs (its `Ctx`) — Cedar wants a
// `principal`, better-auth wants `headers`. That `Ctx` is folded onto the claw's `run(prompt, ctx)`
// (the better-auth $InferContext pattern), so euroclaw invents no identity of its own: you pass
// exactly what the installed engines ask for, and each reads its own thing.

import type {
	EuroclawPlugin,
	GateDecision,
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
	ToolCall,
	TurnContext,
} from "@euroclaw/contracts";
import { policyRequest, policyResult } from "@euroclaw/contracts";
import { validationError } from "@euroclaw/errors";
import { type } from "arktype";

/**
 * A policy plugin that declares the per-request context (`Ctx`) it needs — folded onto the
 * claw's `run(prompt, ctx)`. The `& { $InferContext }` is what surfaces (and requires) that ctx.
 *
 * `"no-cron"` is stated, not defaulted: a policy plugin is a gate and nothing else, and the phantom's
 * DEFAULT is the whole flag union — which createClaw reads as "might contribute cron" and answers by
 * demanding a `cronHandler` from every host that installs one.
 */
export type PolicyPlugin<
	Ctx extends Record<string, unknown> = Record<string, never>,
> = EuroclawPlugin<"no-cron"> & {
	$InferContext: Ctx;
};

export type PolicyPluginConfig<Ctx extends Record<string, unknown>> = {
	engine: PolicyEngine;
	/** Turn a governed tool call + the request context into a policy request — engine-specific. */
	mapCall: (call: ToolCall, ctx: Ctx) => PolicyRequest;
	/** Which calls this engine governs. Default: every call (deny-by-default allowlist). */
	matcher?: (call: ToolCall, ctx: Ctx) => boolean;
	/** Gate id (and plugin id). Default "policy". */
	id?: string;
	/** Seal the gate so it can't be removed or redefined — the unremovable org floor. */
	sealed?: boolean;
	/**
	 * Extra entities for THIS decision, derived from the request context — how a per-run action (a
	 * boundary's registered tool) becomes something policy can name, without recompiling the engine.
	 * Merged UNDER the engine's own directory, so a run can ADD actions and never redefine one.
	 * Ignored by an engine that takes no per-decision entities.
	 */
	entitiesFor?: (ctx: Ctx) => unknown;
};

/**
 * Adapt any `PolicyEngine` into a euroclaw plugin. Engines are deny-by-default, so installing
 * this turns the agent into an allowlist; `Ctx` (inferred from `mapCall`) becomes the context the
 * caller must supply at `run`.
 */
export function createPolicyPlugin<Ctx extends Record<string, unknown>>(
	config: PolicyPluginConfig<Ctx>,
): PolicyPlugin<Ctx> {
	const id = config.id ?? "policy";
	const baseMatcher = config.matcher ?? (() => true);
	const validateRequest = (value: unknown): PolicyRequest => {
		const valid = policyRequest(value);
		if (valid instanceof type.errors) {
			throw validationError(`policy "${id}" request invalid`, valid.summary, {
				policyId: id,
			});
		}
		return valid;
	};
	const validateResult = (value: unknown): PolicyResult => {
		const valid = policyResult(value);
		if (valid instanceof type.errors) {
			throw validationError(`policy "${id}" result invalid`, valid.summary, {
				policyId: id,
			});
		}
		return valid;
	};
	return {
		id,
		// Phantom (types only): the request context this engine reads, folded onto `run`'s ctx.
		$InferContext: {} as Ctx,
		gates: [
			{
				id,
				sealed: config.sealed,
				matcher: (call: ToolCall, ctx: TurnContext) =>
					baseMatcher(call, ctx as Ctx),
				handler: async (call: ToolCall, ctx: TurnContext) => {
					const req = validateRequest(config.mapCall(call, ctx as Ctx));
					// Per-decision entities, when the config derives any from this request's context —
						// how a per-run action becomes nameable without recompiling the engine. Passed
						// positionally to engines that accept them (cedar merges them UNDER its directory);
						// an engine whose `authorize` takes one argument simply ignores the extra.
						const extra = config.entitiesFor?.(ctx as Ctx);
						const result =
							extra === undefined
								? await config.engine.authorize(req)
								: await (
										config.engine.authorize as (
											request: PolicyRequest,
											entities?: unknown,
										) => Promise<PolicyResult>
									)(req, extra);
						return decide(validateResult(result));
				},
			},
		],
	};
}

/** Map an engine result onto core's GateDecision (deny requires a reason; carry the trail). */
function decide(result: PolicyResult): GateDecision {
	const trail = result.policies?.length
		? ` [${result.policies.join(", ")}]`
		: "";
	// The determining policies' DECLARED annotations ride the decision out — the HOST's bag, so an
	// after-gate can act on them (route an escalation, feed a plugin's own queue), and the MODEL's,
	// which the runtime hands to the agent on a blocked call. Carried together, never merged: which
	// audience a key belongs to was settled by its declaration, back in the engine.
	const annotations = {
		...(result.annotations ? { annotations: result.annotations } : {}),
		...(result.modelAnnotations
			? { modelAnnotations: result.modelAnnotations }
			: {}),
	};
	if (result.decision === "permit") return { decision: "permit" };
	if (result.decision === "needs-approval") {
		return {
			decision: "needs-approval",
			reason: (result.reason ?? "approval required") + trail,
			...annotations,
		};
	}
	return {
		decision: "deny",
		reason: (result.reason ?? "no policy permits this action") + trail,
		...annotations,
	};
}
