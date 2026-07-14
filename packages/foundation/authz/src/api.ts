// The product-API decision surface — `decideApiCall`, the `ClawApi::` PARC entry point (the sibling of
// the floor's `Tool::` tool path). Both run on ONE Cedar decision engine; the Cedar ACTION NAMESPACE
// keeps them apart — a `ClawApi::Action` policy structurally cannot permit a `Tool::Action` request and
// vice versa. `decideApiCall` is what the assembly's product-API PEP calls before every governed
// `claw.api` method.
//
// THE ACCESS MODEL IS GENERIC — no tiers, no roles, no org. The PEP never learns "admin" vs
// "self-service" or what "organization" means; it checks a GENERIC ACL over an OPAQUE resource SHAPE
// (`{ createdBy, scope, scopeId, grants }`) and the caller's OPAQUE membership facts:
//
//   owner        — resource.createdBy == the caller                              (LIVE)
//   scope-member — the caller has a (resource.scope, resource.scopeId) membership at level ≥ required
//   grant        — a resource.grants entry matches the caller (or a team/org ref) at level ≥ required
//
// `scope` is a label, `scopeId`/`principalRef` are opaque, level ordering is `read < use < manage`.
// The three permits live in `API_ACCESS_BASELINE` (the un-removable api floor); the (scope,scopeId) /
// grant-ref MATCHING is euroclaw-resolved here (opaque, kind-blind) and the level DECISION is Cedar's.
//
// WHY THE MATCH IS DONE HERE, NOT IN CEDAR: Cedar (4.11.1) has no higher-order set iteration — a
// `grants.any(g => …)` / `memberships.any(m => …)` lambda is not expressible. So the generic,
// kind-blind matching of memberships to the resource's (scope,scopeId) and of grants to the caller's
// refs is computed here (the §3a "euroclaw-RESOLVED fact" pattern the tool floor already uses for
// role/team) and reduced to two integer level facts the Cedar policies compare against `requiredLevel`.
// The policies stay generic (they read `scopeLevel`/`grantLevel`/`resourceCreatedBy`, never a kind).

import type {
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";

/** An action's required permission LEVEL — the ONE non-derivable per-method fact. Ordered
 *  `read < use < manage`: `read` sees, `use` runs/invokes (distinct from read/write), `manage`
 *  mutates/administers. The owner has the max level implicitly; scope-members and grantees carry a
 *  level compared against the action's required level. */
export type ApiPermissionLevel = "read" | "use" | "manage";

/** The level ordering as integers — Cedar compares `Long >=` (it has no ordered enum). */
export const API_PERMISSION_RANK: Record<ApiPermissionLevel, number> = {
	read: 1,
	use: 2,
	manage: 3,
};

/** The Cedar action ENTITY TYPE for the product api — namespaced `ClawApi::Action`, distinct from the
 *  tool floor's unqualified `Action`. This namespace is the whole isolation mechanism. */
export const API_ACTION_TYPE = "ClawApi::Action";
/** The Cedar resource entity type for a governed api call (opaque — the shape rides in context). */
export const API_RESOURCE_TYPE = "ClawApi::Resource";
/** The umbrella action group every governed api action belongs to — the owner/scope/grant permits
 *  target `action in ClawApi::Action::"api"`. */
export const API_ACTION_GROUP = "api";
/** The action group create* methods additionally belong to — the create-permit targets it. */
export const API_CREATE_GROUP = "creates";

/**
 * The GENERIC baseline access set — the api's un-removable floor (owner ∪ scope-member ∪ grant, plus
 * the create-permit). Authored against the resource SHAPE and the caller's resolved level facts, NEVER
 * a concrete kind/tier/role. Merged as the "system" of the api bundle (a plugin slice can widen but a
 * `forbid` still overrides, the same seal the tool floor has).
 *   - owner is LIVE (createdBy comparison);
 *   - scope-member is present-but-dormant (memberships are empty until the org plugin resolves them);
 *   - grant is present-but-dormant (grants are empty until the access_grant table lands, slice 5) —
 *     the POLICY that reads them ships now; the DATA is later.
 */
export const API_ACCESS_BASELINE = `permit(principal, action in ${API_ACTION_TYPE}::"${API_ACTION_GROUP}", resource) when { context.resourceCreatedBy == context.principalRef };
permit(principal, action in ${API_ACTION_TYPE}::"${API_ACTION_GROUP}", resource) when { context.scopeLevel >= context.requiredLevel };
permit(principal, action in ${API_ACTION_TYPE}::"${API_ACTION_GROUP}", resource) when { context.grantLevel >= context.requiredLevel };
permit(principal, action in ${API_ACTION_TYPE}::"${API_CREATE_GROUP}", resource);`;

/** One entry in the generic ACL (a row of the future `access_grant` table, §6). `principalRef` is
 *  polymorphic and OPAQUE — `user:…` | `team:…` | `organization:…` | `public`; `level` is what the
 *  action-map compares against. Slice 1 carries these as request DATA (empty until slice 5's table). */
export type AccessGrant = {
	principalRef: string;
	level: ApiPermissionLevel;
};

/** The caller's membership in an OPAQUE (scope, scopeId) at a level — the dormant scope-member branch's
 *  input. Empty in slice 1 (the org plugin resolves these later); the shape is generic (never "org"). */
export type ApiMembership = {
	scope: string;
	scopeId: string;
	level: ApiPermissionLevel;
};

/** What the PEP loads for a governed method — the ONE opaque resource shape every governed kind
 *  presents (a claw, a thread, later a skill/workspace). Policies read this shape, never the kind. */
export type ApiResourceShape = {
	/** The owner principal (the LIVE owner rule compares it to the caller). Absent for a create /
	 *  a method with no loadable resource — then the owner rule cannot match. */
	createdBy?: string;
	/** The access boundary label (opaque) and its opaque id — the scope-member branch matches the
	 *  caller's memberships against these. */
	scope?: string;
	scopeId?: string;
	/** Explicit grants on this resource (the generic ACL rows). `[]` until slice 5's table. */
	grants: readonly AccessGrant[];
};

/** The out-of-band caller context — the function-intake image of better-auth's `auth.api.x({ headers
 *  })`: identity travels BESIDE the domain input, never inside it. `principal` is the authz SUBJECT;
 *  absent → the actor floor denies. */
export type ApiCaller = {
	principal?: string;
};

export type DecideApiCallInput = {
	/** The one internal Cedar engine (the assembly builds it over `API_ACCESS_BASELINE` + plugin
	 *  slices; the `ClawApi::` namespace isolates it from `Tool::` policies on the same engine). */
	engine: PolicyEngine;
	/** The api method name — the action id (`ClawApi::Action::"<method>"`). */
	method: string;
	/** The action's required level (default `manage` — fail-closed — decided by the caller's map). */
	level: ApiPermissionLevel;
	/** A create* method (any authenticated principal may create; the created row's owner is then the
	 *  caller). Routes to the create-permit instead of the owner/scope/grant permits. */
	isCreate: boolean;
	/** The authz SUBJECT — the caller's principal. Absent → the actor floor denies before Cedar. */
	principal: string | undefined;
	/** The loaded resource shape (opaque). For a create / no-resource method: `{ grants: [] }`. */
	resource: ApiResourceShape;
	/** The caller's memberships (opaque, empty in slice 1) — the scope-member + team/org-grant inputs. */
	memberships: readonly ApiMembership[];
};

/** The best (highest) membership level the caller holds in the resource's OWN (scope, scopeId), or 0
 *  when no scope / no matching membership. Kind-blind: it compares labels, never interprets them. */
function scopeLevelFor(
	memberships: readonly ApiMembership[],
	resource: ApiResourceShape,
): number {
	if (resource.scope === undefined || resource.scopeId === undefined) return 0;
	let best = 0;
	for (const m of memberships) {
		if (m.scope === resource.scope && m.scopeId === resource.scopeId) {
			best = Math.max(best, API_PERMISSION_RANK[m.level]);
		}
	}
	return best;
}

/** Does a grant's opaque `principalRef` reach the caller? `public` reaches everyone; a direct match
 *  reaches the principal; a `team:`/`organization:` (any labelled) ref reaches a caller who holds a
 *  membership whose `<scope>:<scopeId>` equals it — so grants to groups work the moment memberships
 *  do, with no per-ref-kind code here. */
function grantReaches(
	grant: AccessGrant,
	principal: string,
	memberships: readonly ApiMembership[],
): boolean {
	if (grant.principalRef === "public") return true;
	if (grant.principalRef === principal) return true;
	return memberships.some(
		(m) => `${m.scope}:${m.scopeId}` === grant.principalRef,
	);
}

/** The best grant level reaching the caller on this resource, or 0 when none. */
function grantLevelFor(
	grants: readonly AccessGrant[],
	principal: string,
	memberships: readonly ApiMembership[],
): number {
	let best = 0;
	for (const g of grants) {
		if (grantReaches(g, principal, memberships)) {
			best = Math.max(best, API_PERMISSION_RANK[g.level]);
		}
	}
	return best;
}

/**
 * Decide a governed `claw.api` call against the internal Cedar engine — the api-side analog of the
 * floor's tool gate. The actor floor runs FIRST (absent principal → deny, never reaching Cedar); then
 * the opaque shape + the caller's resolved level facts become a `ClawApi::` PARC request the generic
 * baseline (owner ∪ scope ∪ grant, or the create-permit) decides. Returns the engine's `PolicyResult`
 * (the PEP maps a non-permit to a typed authorization error).
 */
export async function decideApiCall(
	input: DecideApiCallInput,
): Promise<PolicyResult> {
	// The actor floor — an absent caller principal is an immediate deny (a host system call passes an
	// explicit system principal, never absence; the facts-vs-posture discipline).
	if (input.principal === undefined) {
		return {
			decision: "deny",
			reason: `app-authz: ${input.method} requires a caller principal (actor floor)`,
		};
	}
	const scopeLevel = scopeLevelFor(input.memberships, input.resource);
	const grantLevel = grantLevelFor(
		input.resource.grants,
		input.principal,
		input.memberships,
	);
	// Every context fact is ALWAYS stamped (safe defaults) — cedar-wasm errors on an absent-attribute
	// access even under a `has` guard (verified 4.11.1), and an erroring permit silently fails to
	// grant. An empty `resourceCreatedBy` never equals a real principal; zero levels never satisfy a
	// required level ≥ 1 — so a create / no-resource call falls through to the create-permit alone.
	const request: PolicyRequest = {
		principal: { type: "User", id: input.principal },
		action: { type: API_ACTION_TYPE, id: input.method },
		resource: { type: API_RESOURCE_TYPE, id: input.method },
		context: {
			principalRef: input.principal,
			requiredLevel: API_PERMISSION_RANK[input.level],
			resourceCreatedBy: input.resource.createdBy ?? "",
			scopeLevel,
			grantLevel,
		},
	};
	return input.engine.authorize(request);
}
