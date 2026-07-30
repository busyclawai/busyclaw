// The policy-engine PORT. Engines are pluggable evaluators over the one PARC vocabulary:
// @busyclaw/authz is the reference engine (and the sealed floor — only it has
// arg-conditions + the needs-approval probe); better-auth/SAP/remote engines layer beside it as
// additional deny-capable gates. Ports are behaviour, not data — plain types, no schema.

import type { PolicyRequest, PolicyResult } from "./request";

/**
 * What an engine can actually read and decide — declared, not assumed. The validate CLI and the
 * boot coverage audit use this to warn when a policy's intent needs a capability no installed
 * engine has (e.g. an arg-condition routed to an identity-only engine would silently not fire).
 */
export type PolicyEngineCapabilities = {
	/** Can it condition on the projected `context.args`, or only on identity facts? */
	reads: "identity" | "identity+args";
	/** Can it return `needs-approval` (vs only permit/deny)? */
	approvals: boolean;
};

/** The port every policy engine implements (Cedar local-WASM, better-auth, SAP remote, …).
 *
 * `entities` is the PER-DECISION entity supplement: actions and objects that exist for THIS request
 * only, and so cannot be in the engine's compiled directory — a tool a boundary registered at run
 * time, the api PEP's Principal/Resource/Access graph. Cedar merges them UNDER its directory; an
 * engine that has no such notion ignores the argument.
 *
 * It is declared here, on the port, because it is not optional in the way an unused argument is
 * optional: an engine that never receives it cannot NAME a per-run action, and deny-by-default then
 * refuses every one of them. It was previously an untyped positional argument the gate cast its way
 * past, which hid both wrapper engines in this package dropping it.
 *
 * TWO deliberate limits, neither of which a comment can fix, so both are pinned by tests instead:
 *   - `authorize` is declared as a METHOD, not a function-valued property, so an engine may refine
 *     the parameter to its own entity representation (Cedar's `Entities`) without a cast at the
 *     implementation. Method parameters are bivariant, so that refinement is unchecked — the price
 *     of letting each engine name its own entity type in a port that cannot name any of them.
 *   - A wrapper's `authorize(req)` stays assignable whether or not it forwards, because a function
 *     of fewer parameters always is. Declaring the parameter documents the channel; it CANNOT make
 *     a dropped supplement a compile error. Each wrapper carries a test that fails when it drops.
 */
export type PolicyEngine = {
	authorize(
		req: PolicyRequest,
		entities?: unknown,
	): PolicyResult | Promise<PolicyResult>;
	capabilities?: PolicyEngineCapabilities;
};
