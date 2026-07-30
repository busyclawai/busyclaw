// The shadow policy engine — slice 6b. `shadow` mode is a REAL second evaluation, not a flag: this
// wraps a live engine + a candidate, evaluates BOTH per decision, and when their decisions diverge
// calls an injected `observe` callback — then returns the LIVE result UNCHANGED. Shadow never changes
// the answer; it only records what the candidate WOULD have decided. Engine-agnostic; `observe` is a
// host callback (routed to audit/telemetry), NOT a new port. Installed only when the bundle has a
// candidate set (loadPolicyBundle → bundle.shadow).
//
// STRICT ISOLATION — a "safe to experiment with" shadow slice must NEVER break live authorization,
// so EVERY candidate failure mode is contained and the live result is always returned:
//   - construction: the candidate is a LAZY builder, built once here in a try/catch; a malformed
//     shadow policy set (a customer typo) that throws at build → shadow is disabled, live is served.
//   - evaluation: the candidate's authorize runs best-effort; a rejection is swallowed.
//   - observe: a throwing host observer is swallowed — it fires exactly on divergence and must not
//     take down the very decisions it is meant to only watch.

import type {
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
} from "@busyclaw/contracts";

export type ShadowDivergence = {
	request: PolicyRequest;
	live: PolicyResult["decision"];
	candidate: PolicyResult["decision"];
};

/** Wrap a live engine + a lazily-built candidate: evaluate both, observe divergences, ALWAYS return
 *  the live result. A candidate that fails to build, rejects, or an observer that throws can never
 *  change (or crash) the live decision. */
export function createShadowPolicyEngine(config: {
	live: PolicyEngine;
	/** Built ONCE here, in a try/catch — a throw (malformed shadow policy set) disables shadow, never
	 *  breaks live. Lazy so construction is isolated inside this wrapper. */
	candidate: () => PolicyEngine;
	observe: (divergence: ShadowDivergence) => void;
	/** Optional: surface a candidate that failed to BUILD (a broken shadow slice), without breaking
	 *  live. Absent ⇒ shadow is silently disabled for this bundle until the slice is fixed. */
	onCandidateBuildError?: (error: unknown) => void;
}): PolicyEngine {
	let candidate: PolicyEngine | undefined;
	try {
		candidate = config.candidate();
	} catch (error) {
		config.onCandidateBuildError?.(error);
	}
	return {
		// The shadow wrapper decides nothing of its own — it speaks with the live engine's capabilities.
		capabilities: config.live.capabilities,
		// `entities` reaches BOTH sides. Live, because a wrapper that narrows what the request may name
		// is not observing the decision, it is changing it — dropping this denied every run-registered
		// action the moment any source contributed a shadow slice. Candidate, because a shadow run
		// compared against a narrower world reports divergences the candidate policy never caused.
		async authorize(req, entities) {
			// No candidate (build failed) → pure passthrough.
			if (!candidate) return config.live.authorize(req, entities);
			// Both run in parallel, but the candidate's rejection is CAUGHT to undefined — the live
			// result must survive a broken shadow policy.
			const [live, candidateResult] = await Promise.all([
				config.live.authorize(req, entities),
				// Promise.resolve: the port allows a sync OR async authorize; either way a rejection is
				// caught to undefined so a broken candidate can never take down the live result.
				Promise.resolve(candidate.authorize(req, entities)).then(
					(result) => result,
					() => undefined,
				),
			]);
			if (candidateResult && candidateResult.decision !== live.decision) {
				try {
					config.observe({
						request: req,
						live: live.decision,
						candidate: candidateResult.decision,
					});
				} catch {
					// A throwing observer must not change the answer it only watches.
				}
			}
			return live;
		},
	};
}
