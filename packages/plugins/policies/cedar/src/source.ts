// @euroclaw/policy-cedar — the `cedar()` policy SOURCE: raw Cedar policy TEXT contributed to the
// assembly's internal engine, merged UNDER the sealed SYSTEM_POSTURE floor (`forbid` > `permit`).
// The Cedar decision ENGINE (eval, floor, mapper, escape-hatch plugin) lives in @euroclaw/authz;
// this package is a thin source — no cedar-wasm, no engine.

import type { CedarContext, PolicyPlugin } from "@euroclaw/authz";

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
};

/**
 * `cedar({ policies })` — a policy SOURCE. It contributes raw Cedar TEXT into the assembly's bundle,
 * merged UNDER the sealed SYSTEM_POSTURE floor (`forbid` > `permit`) by the assembly's ONE internal
 * engine. It provides NO engine and NO schema: `cedar()` connected or not, the engine is the
 * assembly's. Connect it only to ADD custom rules beneath the floor — a `forbid` narrows, a `permit`
 * widens, and neither can remove the floor's un-removable forbids.
 *
 * The `$InferContext` folds an OPEN turn context onto `run(prompt, ctx)` — it does NOT require the
 * caller to supply a `principal`. The acting identity is the ONE stamped `euroclaw__principal`, seeded
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
			},
		],
	};
}
