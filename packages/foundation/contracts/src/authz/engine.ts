// The policy-engine PORT. Engines are pluggable evaluators over the one PARC vocabulary:
// @euroclaw/authz is the reference engine (and the sealed floor — only it has
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

/** The port every policy engine implements (Cedar local-WASM, better-auth, SAP remote, …). */
export type PolicyEngine = {
	authorize: (req: PolicyRequest) => PolicyResult | Promise<PolicyResult>;
	capabilities?: PolicyEngineCapabilities;
};
