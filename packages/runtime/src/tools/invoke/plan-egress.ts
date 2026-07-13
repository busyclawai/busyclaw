// The egress plan COMPILER: given a backend's declared egress capability (+ the Cedar policy, the
// stamped facts, and the secret resolver the interceptor outbound will consume), produce the
// enforcement that backend can actually apply — and NEVER silently over-claim what a tier
// structurally cannot do.
//
// The counterpart of the PolicyEngine port on the egress side: `planEgress` reads a backend's
// `EgressCapability` and emits an `EgressPlan` matched to it, plus `UnenforcedNote`s for every policy
// dimension the chosen tier cannot enforce (surfaced both at boot and per-execution — decision 4).
//
// Slice-2 scope: `blocked` and `allowlist` are compiled concretely here; the `interceptor` plan's
// governed outbound is DEPENDENCY-INJECTED via `buildOutbound` (tests pass a fake; slice 3 supplies
// the real authorize → floor → claim-check → audit outbound). This keeps the compiler pure — types +
// branching — with the interceptor implementation cleanly deferred. Co-located with tools/invoke/
// because that slice-3 outbound reuses the invoke credential + floor + audit stages.

import type {
	EgressCapability,
	EgressPlan,
	GovernedOutbound,
	PolicyEngine,
	Secrets,
	StampedFacts,
	UnenforcedNote,
} from "@euroclaw/contracts";
import { configurationError } from "@euroclaw/contracts";

/** Inputs to the egress compiler. `policy` / `facts` / `secrets` are what the interceptor outbound
 *  consumes (per-request authorize + claim-check in slice 3); the slice-2 compiler itself reads only
 *  `capability`, `hosts`, and `buildOutbound`, but the signature is stable so slice 3 adds no params. */
export type PlanEgressInput = {
	/** What the target backend can enforce — the discriminant the compiler branches on. */
	capability: EgressCapability;
	/** The Cedar engine the interceptor outbound authorizes each request against (slice 3). */
	policy: PolicyEngine;
	/** The runtime-stamped identity facts (principal/org/runMode) the outbound carries into policy. */
	facts: StampedFacts;
	/** The one-door reader for claim-check credential injection at egress (slice 3). */
	secrets: Secrets;
	/** The explicit allowlist host-set for the `allowlist` tier (decision 2 — the Cedar
	 *  host-projection compiler that derives this is slice 4). Ignored by the other tiers. */
	hosts?: readonly string[];
	/** Builds the interceptor tier's governed outbound. Injected so slice 2 stays pure: tests pass a
	 *  fake, slice 3 supplies the real authorize+floor+claim-check+audit outbound. REQUIRED when the
	 *  capability is `interceptor`; ignored otherwise. */
	buildOutbound?: () => GovernedOutbound;
};

/** The compiler result: the plan the backend applies, and the honest gaps (decision 4). */
export type PlanEgressResult = {
	plan: EgressPlan;
	unenforced: UnenforcedNote[];
};

/** Dimensions the host-level `allowlist` tier structurally cannot enforce (it matches on the
 *  destination host only). STATIC per posture — no policy introspection needed; the Cedar
 *  host-projection (slice 4) refines WHICH hosts, never WHAT is unenforceable. */
const ALLOWLIST_UNENFORCED: readonly UnenforcedNote[] = [
	{
		dimension: "method",
		detail:
			"host-level egress matches on the destination host only; the request method is not seen or enforced",
	},
	{
		dimension: "path",
		detail:
			"host-level egress matches on the destination host only; the request path is not seen or enforced",
	},
	{
		dimension: "resource",
		detail:
			"host-level egress cannot distinguish resources under one host (e.g. a single repo on api.github.com)",
	},
	{
		dimension: "conditions",
		detail:
			"host-level egress matches on the destination host only; per-request policy conditions (runMode, approval, confirmationUsed, arg-conditions) are not evaluated or enforced",
	},
	{
		dimension: "credential-isolation",
		detail:
			"the guest process holds its own credentials on this tier; euroclaw cannot claim-check (inject/substitute) them at egress — egress containment, not credential isolation",
	},
];

/**
 * Compile a backend's egress capability into the plan it can enforce, plus the unenforced-policy
 * notes. `blocked` → no egress. `allowlist` → the static host-set (decision 2) the backend's firewall
 * enforces, with the static unenforced notes above. `interceptor` → the injected governed outbound,
 * which enforces every dimension (no unenforced notes). Fails LOUD — never a silent mis-plan — when
 * an `interceptor` capability arrives with no `buildOutbound` to realize it.
 */
export function planEgress(input: PlanEgressInput): PlanEgressResult {
	const { capability } = input;
	switch (capability.posture) {
		case "blocked":
			return { plan: { mode: "blocked" }, unenforced: [] };
		case "allowlist":
			return {
				plan: { mode: "allowlist", allow: input.hosts ?? [] },
				unenforced: [...ALLOWLIST_UNENFORCED],
			};
		case "interceptor": {
			const build = input.buildOutbound;
			if (!build) {
				throw configurationError(
					"planEgress: an interceptor capability requires buildOutbound to realize the governed outbound",
					{ transport: capability.transport },
				);
			}
			return {
				plan: { mode: "interceptor", outbound: build() },
				unenforced: [],
			};
		}
	}
}
