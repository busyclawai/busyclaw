// The per-organization policy BUNDLE — slice 6b. A pure merge of the code-owned system posture with a
// customer's stored policy slices. Engine-agnostic: this produces NAMED policy TEXT (name → cedar);
// the host compiles it into a PolicyEngine. A settled ruling lives here: `shadow` is a REAL second
// evaluation, not an include/exclude flag — the bundle carries a `shadow` CANDIDATE set only when
// shadow slices exist, and the host wraps two engines with createShadowPolicyEngine. No shadow slices
// ⇒ no candidate ⇒ the live engine is used directly.

import { configurationError } from "@euroclaw/contracts";

export type PolicySliceLike = {
	name: string;
	cedar: string;
	mode: "enforce" | "shadow" | "off";
};

/**
 * A NAMED policy set: each slice's own `name` → its Cedar text. The name is what a decision's
 * determining-policy trail reports and the compliance audit persists, so it is deliberately the same
 * handle the policy is MANAGED by (a stored slice's name, a code-owned floor rule's key) — not a
 * positional `policy3` that shifts the moment a slice is added above it, and not metadata buried in
 * the Cedar source. Still engine-agnostic: the values are plain text. A value holding SEVERAL policies
 * is split by the cedar layer into `<name>#<i>` (cedar-wasm takes one policy per id).
 */
export type NamedPolicies = Readonly<Record<string, string>>;

export type PolicyBundle = {
	/** The enforced set — system posture + every enforce slice. The REAL decision. */
	live: NamedPolicies;
	/** The candidate set — live + every shadow slice — or undefined when no shadow slice
	 *  exists (so the caller skips the second engine entirely). */
	shadow?: NamedPolicies;
};

/**
 * Merge the system posture with a customer's slices into the NAMED policy set the engine compiles.
 * `enforce` slices join `live`; `shadow` slices produce a distinct `candidate` (only when at least one
 * exists); `off` slices are dropped. Pure — the input is stored rows (already parsed) or host config.
 *
 * A slice may never REUSE a name already in the set. The merge is keyed, so a collision would silently
 * REPLACE the rule it collides with — a customer slice named for a floor rule would overwrite the seal,
 * and two slices sharing a name would be indistinguishable in the audit trail. Fail LOUD instead.
 */
export function loadPolicyBundle(input: {
	system: NamedPolicies;
	slices: readonly PolicySliceLike[];
}): PolicyBundle {
	const live: Record<string, string> = { ...input.system };
	const shadowOnly: Record<string, string> = {};
	for (const slice of input.slices) {
		if (slice.mode === "off") continue; // dropped entirely
		if (live[slice.name] !== undefined || shadowOnly[slice.name] !== undefined) {
			throw configurationError(`duplicate policy slice name: ${slice.name}`, {
				name: slice.name,
				reason:
					"a slice name must be unique across the system posture and every other slice — a reused name would replace the rule it collides with",
			});
		}
		if (slice.mode === "enforce") live[slice.name] = slice.cedar;
		else shadowOnly[slice.name] = slice.cedar;
	}
	if (Object.keys(shadowOnly).length === 0) return { live };
	return { live, shadow: { ...live, ...shadowOnly } };
}

/**
 * The org's bundle identity for the policy router — `${organizationId}:${changeCount}`, or the shared
 * `"system"` bundle when the org is uncustomized (changeCount 0) or absent. `changeCount` is
 * count(authz_change) for the org: the log is APPEND-ONLY, so the count strictly increases and no two
 * authz states share a key — SOUND under add/edit/DELETE (a delete APPENDS an event, bumping the
 * count), where `max(updatedAt)` is not (deleting a non-newest row leaves the max unchanged → a stale
 * bundle). The router reads one cheap `count()` per decision and calls this.
 */
export function authzBundleKey(input: {
	organizationId: string | undefined;
	changeCount: number;
}): string {
	if (input.organizationId === undefined || input.changeCount === 0) {
		return "system";
	}
	return `${input.organizationId}:${input.changeCount}`;
}
