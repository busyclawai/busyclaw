// The authorization REQUEST contracts — PARC (principal/action/resource/context), the universal
// ABAC vocabulary every policy engine speaks. Engine-neutral: never Cedar/OPA/better-auth shapes;
// each engine package formats these natively. Data contracts are arktype schemas because they
// validate at a trust boundary: `mapCall` results and engine answers are third-party code, and a
// malformed decision must fail LOUD at the gate, not fail open. See docs/architecture/12-conventions.md.

import { type } from "arktype";

export const entityRef = type({ type: "string", id: "string" });

/** A reference to an entity in the policy model. Each engine formats it natively. */
export type EntityRef = typeof entityRef.infer;

export const policyRequest = type({
	principal: entityRef,
	action: entityRef,
	resource: entityRef,
	// The busyclaw-standard context facts, typed by NAME — runtime-stamped and spoof-proof
	// (mapCall reads them from resolution context; caller-supplied busyclaw__ keys are stripped
	// upstream). Consumers (the org router, engines) read them typed instead of duck-probing.
	// Engines append their own keys (e.g. the projected `args`) through the index signature.
	context: {
		"confirmationUsed?": "boolean",
		"clawId?": "string",
		"configScope?": "string",
		"configScopeId?": "string",
		/** Every boundary the principal belongs to, as `<scope>:<scopeId>`. ALWAYS supplied by the engine
		 *  (empty when it has none) — never optional in a built request, for the same reason `runMode`
		 *  never is: cedar-wasm ERRORS on an absent base, and an erroring policy is SILENTLY SKIPPED. An
		 *  unguarded `context.scopes.contains(…)` over a missing base takes a `forbid` down with it. */
		"scopes?": "string[]",
		/** The same memberships that carry a role, as `<scope>:<scopeId>#<role>` — so a policy names WHERE
		 *  a role is held. Also always supplied. */
		"roles?": "string[]",
		"runMode?": "'interactive' | 'autonomous'",
		"[string]": "unknown",
	},
});

/** The universal authorization request (PARC — principal/action/resource/context). */
export type PolicyRequest = typeof policyRequest.infer;

export const policyResult = type({
	decision: "'permit' | 'deny' | 'needs-approval'",
	"reason?": "string | undefined",
	"policies?": type("string").array().or("undefined"),
	/** The DECLARED annotations of the determining policies (`@escalate("team:x")` → `{escalate}`),
	 *  filtered to the keys plugins declared. Opaque here — the declaring plugin owns the meaning. */
	"annotations?": type({ "[string]": "string" }).or("undefined"),
	/** The same, for the keys declared `audience: "model"` — a DISJOINT bag, because these reach the
	 *  agent (a blocked call's result, a tool-search disclosure) and the ones above never may. An
	 *  engine that fills this owes the {@link MODEL_ANNOTATION_MAX_LENGTH} bound per value. */
	"modelAnnotations?": type({ "[string]": "string" }).or("undefined"),
});

/** What an engine returns. `policies` is the determining-policy trail (for the audit); `annotations`
 *  carries the declared policy metadata a plugin routes on, and `modelAnnotations` the metadata
 *  written for the agent instead. */
export type PolicyResult = typeof policyResult.infer;
