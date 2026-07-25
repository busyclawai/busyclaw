// The runtime's egress binding. The pure network floor lives in @euroclaw/egress (Node-free — SSRF
// range guard, https-only, resolve-once pinning), and its Node half (the node:dns default resolver
// and the pinning dispatcher) in the @euroclaw/egress/node subpath, shared with the sandboxes plugin
// so there is ONE such binding rather than a copy per consumer. This file only re-exports the
// surface under the runtime's own name, so provider.ts and the runtime barrels are untouched.

export {
	assertEgressAllowedOnNode as assertEgressAllowed,
	type PinnedConnection,
	pinnedConnection,
	type PinnedLookup,
	pinnedLookup,
} from "@euroclaw/egress/node";

export { blockedAddressReason } from "@euroclaw/egress";
export type {
	EgressDecision,
	EgressLookup,
	EgressOptions,
	ResolvedAddress,
} from "@euroclaw/egress";
