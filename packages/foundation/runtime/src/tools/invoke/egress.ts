// The runtime's egress binding. The pure network floor lives in @busyclaw/egress (Node-free — SSRF
// range guard, https-only, resolve-once pinning), and its Node half (the node:dns default resolver
// and the pinning dispatcher) in the @busyclaw/egress/node subpath, shared with the sandboxes plugin
// so there is ONE such binding rather than a copy per consumer. This file only re-exports the
// surface under the runtime's own name, so provider.ts and the runtime barrels are untouched.

export type {
	EgressDecision,
	EgressLookup,
	EgressOptions,
	ResolvedAddress,
} from "@busyclaw/egress";

export { blockedAddressReason } from "@busyclaw/egress";
export {
	assertEgressAllowedOnNode as assertEgressAllowed,
	type PinnedConnection,
	type PinnedLookup,
	pinnedConnection,
	pinnedFetch,
	pinnedLookup,
} from "@busyclaw/egress/node";
