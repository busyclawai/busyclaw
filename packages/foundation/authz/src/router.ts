// The per-organization policy router — a PolicyEngine that resolves each decision to the compiled
// bundle for the request's organization and delegates. Engine-agnostic (better-auth/SAP engines
// need the same routing) and core's chokepoint is untouched: it lives here, in @busyclaw/authz.
//
// Content-addressed cache (D4): `keyFor(org)` is the bundle identity — it MUST fold in every input
// of the bundle (model version, policy-set version, entity source), so organizations with no
// customization hash to the same key and SHARE one bundle. Content-keyed invalidation falls out:
// a registration bumps whatever keyFor reads → the next decision misses → rebuild. No event bus, no
// invalidate API (do not add one). Single-flight: the cache stores the build PROMISE so concurrent
// first decisions build once; a rejected build is evicted so the next decision retries. LRU by
// insertion order (Map) — a hit refreshes recency, an insert past maxBundles evicts the oldest.

import type {
	PolicyEngine,
	PolicyEngineCapabilities,
	ScopeRef,
} from "@busyclaw/contracts";
import { UNSCOPED } from "@busyclaw/contracts";

export type OrgPolicyRouterConfig = {
	/** Bundle identity. MUST uniquely identify EVERY input of the bundle — model version,
	 *  policy-set version, AND the entity source. Scopes may share a key (and thus a bundle) ONLY
	 *  when all three are identical (the "system" bundle for uncustomized scopes). */
	keyFor: (boundary: ScopeRef) => string | Promise<string>;
	/** Build the compiled bundle for a config scope (e.g. buildAuthzModel(rows) → cedar({model,
	 *  policies, entities})). Called once per distinct key; cached. */
	engineFor: (boundary: ScopeRef) => PolicyEngine | Promise<PolicyEngine>;
	capabilities?: PolicyEngineCapabilities;
	/** LRU size. Default 64. */
	maxBundles?: number;
};

const DEFAULT_MAX_BUNDLES = 64;

/** Resolve each decision to its scope's content-addressed bundle and delegate. */
export function createOrgPolicyRouter(
	config: OrgPolicyRouterConfig,
): PolicyEngine {
	const maxBundles = config.maxBundles ?? DEFAULT_MAX_BUNDLES;
	// Stores the build PROMISE (not the resolved engine) — single-flight for concurrent first calls.
	const cache = new Map<string, Promise<PolicyEngine>>();

	return {
		capabilities: config.capabilities,
		// `entities` is forwarded, not consumed: routing chooses WHICH bundle answers, never what the
		// request may name. Dropping it made every run-registered action unnameable in the bundle the
		// router picked, so the floor denied each one with "no policy permits this action" — the exact
		// tools per-org routing exists to govern.
		async authorize(req, entities) {
			// Typed by the PARC contract (validated at the gate) — no duck-probing. BOTH halves or no
			// boundary: half a key names no boundary, and routing on it would hand this decision another
			// boundary's compiled policy bundle. The absent case is UNSCOPED, not `undefined`, so
			// `keyFor`/`engineFor` are asked one question with one shape — they used to each carry an
			// `| undefined` and answer it their own way.
			const scope = req.context.configScope;
			const scopeId = req.context.configScopeId;
			const boundary =
				typeof scope === "string" && typeof scopeId === "string"
					? { scope, scopeId }
					: UNSCOPED;
			const key = await config.keyFor(boundary);

			const cached = cache.get(key);
			let pending: Promise<PolicyEngine>;
			if (cached) {
				// Hit — refresh recency (delete + re-insert moves it to the newest slot).
				cache.delete(key);
				cache.set(key, cached);
				pending = cached;
			} else {
				pending = Promise.resolve().then(() => config.engineFor(boundary));
				cache.set(key, pending);
				// A failed build must not poison the cache — evict it so the next decision retries.
				pending.catch(() => {
					if (cache.get(key) === pending) cache.delete(key);
				});
				while (cache.size > maxBundles) {
					const oldest = cache.keys().next().value;
					if (oldest === undefined) break;
					cache.delete(oldest);
				}
			}

			const engine = await pending;
			return engine.authorize(req, entities);
		},
	};
}
