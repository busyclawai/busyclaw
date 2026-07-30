// @busyclaw/policy-cedar — the `cedar()` policy SOURCE: raw Cedar policy TEXT contributed to the
// assembly's internal engine, merged UNDER the sealed SYSTEM_POSTURE floor (`forbid` > `permit`).
// The Cedar decision ENGINE (eval, floor, mapper, escape-hatch plugin) lives in @busyclaw/authz;
// this package is a thin source — no cedar-wasm, no engine.

import type { CedarContext, PolicyPlugin } from "@busyclaw/authz";

/** Config for the `cedar()` policy SOURCE — the raw Cedar TEXT laid beneath the floor. */
export type CedarSourceConfig = {
	/** Raw Cedar policy text — one or more `permit`/`forbid` statements laid beneath the floor. */
	policies: string;
	/** A human label / stable slice id (audit + bundle identity). Default derived from `id`. */
	name?: string;
	/** Plugin id. Default "policy:cedar". */
	id?: string;
	/** Merge mode. `enforce` (default) joins the live set; `shadow` is evaluated but never applied. */
	mode?: "enforce" | "shadow" | "off";
	/**
	 * WHICH plane these policies govern. Default `"tool"` — `cedar()` exists to shape what the AGENT
	 * may do, and that is what nearly every caller writes it for.
	 *
	 * The default is deliberately the NARROW one. Reaching the product api is a separate decision
	 * about who may call the application's own methods, and an author who wants it says so; an author
	 * who does not think about it gets the plane they were thinking about. Before this existed every
	 * slice reached both, so an unqualified `permit(principal, action, resource);` written for tools
	 * also permitted api actions over the owner/scope/grant rules (R-H04).
	 */
	plane?: "tool" | "api" | "both";
};

/**
 * `cedar({ policies })` — a policy SOURCE. It contributes raw Cedar TEXT into the assembly's bundle,
 * merged UNDER the sealed SYSTEM_POSTURE floor (`forbid` > `permit`) by the assembly's ONE internal
 * engine. It provides NO engine and NO schema: `cedar()` connected or not, the engine is the
 * assembly's. Connect it only to ADD custom rules beneath the floor — a `forbid` narrows, a `permit`
 * widens, and neither can remove the floor's un-removable forbids.
 *
 * The `$InferContext` folds an OPEN turn context onto `run(prompt, ctx)` — it does NOT require the
 * caller to supply a `principal`. The acting identity is the ONE stamped `busyclaw__principal`, seeded
 * by the trusted context assembly from the authenticated caller (never a caller-typed ctx field — that
 * was audit #7). The source's policies reference the principal; the internal engine's mapper reads it
 * from the stamp.
 */
export function cedar(config: CedarSourceConfig): PolicyPlugin<CedarContext> {
	const id = config.id ?? "policy:cedar";
	return {
		id,
		// Phantom (types only): the request context these policies read, folded onto `run`'s ctx.
		$InferContext: {} as CedarContext,
		policies: [
			{
				name: config.name ?? id,
				cedar: config.policies,
				mode: config.mode ?? "enforce",
				plane: config.plane ?? "tool",
			},
		],
	};
}
