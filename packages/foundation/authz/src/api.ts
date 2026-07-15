// The product-API decision surface — `decideApiCall`, the `ClawApi::` PARC entry point (the sibling of
// the floor's `Tool::` tool path). It runs on a SEPARATE Cedar engine from the tool floor
// (`cedarApiEngine`), namespace-isolated: a `ClawApi::Action` policy structurally cannot permit a
// `Tool::Action` request and vice versa. `decideApiCall` is what the assembly's product-API PEP calls
// before every governed `claw.api` method.
//
// THE ACCESS MODEL IS GENERIC — no tiers, no roles, no org. The PEP never learns "admin" vs
// "self-service" or what "organization" means; it checks a GENERIC ACL over an OPAQUE resource SHAPE
// (`{ createdBy, scope, scopeId, grants }`) and the caller's OPAQUE membership facts, evaluated as REAL
// CEDAR over a per-request ENTITY GRAPH — NOT integer context facts:
//
//   owner        — `resource.createdBy == principal`            (entity/attr equality, LIVE)
//   scope-member — `principal in resource.requiredScopeAccess`  (leveled `in`, dormant)
//   grant        — `principal in resource.requiredGrantAccess`  (leveled `in`, dormant)
//
// The LEVEL ordering (`read < use < manage`) is CEDAR'S, expressed as an access-node hierarchy
// `…:manage in …:use in …:read`: the caller is `in` the node its membership/grant grants, the resource's
// `requiredXAccess` attribute points at the node for the action's required level, and being `in` a higher
// node is transitively being `in` every lower one — so a `use` member satisfies a `read` requirement but
// NOT a `manage` one, decided entirely by Cedar `in`, never a TS `>=`. The euroclaw side only RENDERS the
// graph (which membership/grant maps to which node — kind-blind, opaque labels); every DECISION is
// Cedar's. `scope`/`scopeId`/`principalRef` are opaque; the three permits live in `API_ACCESS_BASELINE`
// (the un-removable api floor). Owner is LIVE; scope-member and grant are present-but-dormant (their `in`
// edges are empty until the org plugin resolves memberships and the access_grant table lands) — the
// POLICY and the RENDERING ship now, the DATA arrives later.

import type { Entities, EntityJson } from "@cedar-policy/cedar-wasm/nodejs";
import type {
	AccessGrant,
	AccessGrantPermission,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
import { grantReaches } from "@euroclaw/contracts";
import type { CedarEngine } from "./cedar-types";

/** An action's required permission LEVEL — the ONE non-derivable per-method fact. Ordered
 *  `read < use < manage`: `read` sees, `use` runs/invokes (distinct from read/write), `manage`
 *  mutates/administers. The owner has the max level implicitly; scope-members and grantees carry a level
 *  the resource's requirement is compared against — by Cedar `in`, not a TS compare. ALIASES the grant
 *  level in @euroclaw/contracts (the store's `access_grant.permission`), so the store, the grant shape,
 *  and the action-required level are ONE vocabulary with no conversion seam. */
export type ApiPermissionLevel = AccessGrantPermission;

/** The level order, ASCENDING — the ONLY place the ordering is expressed. Rendered as the Cedar access-
 *  node hierarchy `…:manage in …:use in …:read` (each level's node parents the one below), so Cedar
 *  decides "holds ≥ the required level" by transitive `in`. */
const API_LEVELS_ASCENDING: readonly ApiPermissionLevel[] = [
	"read",
	"use",
	"manage",
];

/** The Cedar action ENTITY TYPE for the product api — namespaced `ClawApi::Action`, distinct from the
 *  tool floor's unqualified `Action`. This namespace is the whole isolation mechanism. */
export const API_ACTION_TYPE = "ClawApi::Action";
/** The Cedar resource entity type for a governed api call. Its access lives in ATTRIBUTES
 *  (`createdBy`, `requiredScopeAccess`, `requiredGrantAccess`), never in context. */
export const API_RESOURCE_TYPE = "ClawApi::Resource";
/** The caller's Cedar entity type — GENERIC and neutral (NOT "User"): a `system:` principal is not a
 *  user, and no kind/role is ever modeled. */
export const API_PRINCIPAL_TYPE = "ClawApi::Principal";
/** The leveled access-node entity type — the `scope:<scope>:<scopeId>:<level>` and
 *  `grant:<method>:<level>` hierarchies the owner/scope/grant `in` compares walk. */
export const API_ACCESS_TYPE = "ClawApi::Access";
/** The umbrella action group every governed api action belongs to — the owner/scope/grant permits
 *  target `action in ClawApi::Action::"api"`. */
export const API_ACTION_GROUP = "api";
/** The action group create* methods additionally belong to — the create-permit targets it. */
export const API_CREATE_GROUP = "creates";

/**
 * The GENERIC baseline access set — the api's un-removable floor (owner ∪ scope-member ∪ grant, plus the
 * create-permit). Authored against the resource ENTITY (its `createdBy` owner attribute and its two
 * requirement pointers), NEVER a concrete kind/tier/role. Merged as the "system" of the api bundle (a
 * plugin slice can widen but a `forbid` still overrides, the same seal the tool floor has).
 *   - owner is LIVE (`resource.createdBy == principal`);
 *   - scope-member is present-but-dormant (`principal in resource.requiredScopeAccess`; the caller's
 *     membership `in` edges are empty until the org plugin resolves them);
 *   - grant is present-but-dormant (`principal in resource.requiredGrantAccess`; grants are empty until
 *     the access_grant table lands) — the POLICY ships now, the DATA later.
 */
export const API_ACCESS_BASELINE = `permit(principal, action in ${API_ACTION_TYPE}::"${API_ACTION_GROUP}", resource) when { resource.createdBy == principal };
permit(principal, action in ${API_ACTION_TYPE}::"${API_ACTION_GROUP}", resource) when { principal in resource.requiredScopeAccess };
permit(principal, action in ${API_ACTION_TYPE}::"${API_ACTION_GROUP}", resource) when { principal in resource.requiredGrantAccess };
permit(principal, action in ${API_ACTION_TYPE}::"${API_CREATE_GROUP}", resource);`;

/** One entry in the generic ACL (a row of the `access_grant` table, projected). `principalRef` is
 *  polymorphic and OPAQUE — `user:…` | `team:…` | `organization:…` | `public`; `level` is what the
 *  resource's requirement is compared against. Carried as request DATA (the store's `listForResource`
 *  feeds it — slice 5). The type is DEFINED in @euroclaw/contracts (beside the `AccessGrantStore` port,
 *  the layer the store lives under) and re-exported here so the store returns exactly the shape the PEP
 *  renders — one type, no translation. */
export type { AccessGrant };

/** The caller's membership in an OPAQUE (scope, scopeId) at a level — the dormant scope-member branch's
 *  input. Empty until the org plugin resolves them; the shape is generic (never "org"). */
export type ApiMembership = {
	scope: string;
	scopeId: string;
	level: ApiPermissionLevel;
};

/** What the PEP loads for a governed method — the ONE opaque resource shape every governed kind presents
 *  (a claw, a thread, later a skill/workspace). Rendered into the resource entity; policies read the
 *  entity, never the kind. */
export type ApiResourceShape = {
	/** The owner principal (the LIVE owner rule compares it to the caller). Absent/blank for a create /
	 *  an unresolvable resource — then the owner rule cannot match (rendered as a sentinel owner). */
	createdBy?: string;
	/** The access boundary label (opaque) and its opaque id — the scope-member branch renders the
	 *  caller's memberships and the resource's requirement against these. */
	scope?: string;
	scopeId?: string;
	/** Explicit grants on this resource (the generic ACL rows). `[]` until the access_grant table lands. */
	grants: readonly AccessGrant[];
};

/** The out-of-band caller context — the function-intake image of better-auth's `auth.api.x({ headers
 *  })`: identity travels BESIDE the domain input, never inside it. `principal` is the authz SUBJECT;
 *  absent → the actor floor denies. */
export type ApiCaller = {
	principal?: string;
};

export type DecideApiCallInput = {
	/** The product-api Cedar engine (`cedarApiEngine`) — SEPARATE from the tool floor's engine,
	 *  namespace-isolated (`ClawApi::` vs `Tool::`). Accepts the per-request entity graph. */
	engine: CedarEngine;
	/** The api method name — the action id (`ClawApi::Action::"<method>"`). */
	method: string;
	/** The action's required level (`read < use < manage`) — the ONE non-derivable per-method fact. */
	level: ApiPermissionLevel;
	/** The authz SUBJECT — the caller's principal. Absent/blank → the actor floor denies before Cedar. */
	principal: string | undefined;
	/** The loaded resource shape (opaque). For a create / no-resource method: `{ grants: [] }`. */
	resource: ApiResourceShape;
	/** The caller's memberships (opaque, empty until the org plugin resolves them) — the scope-member
	 *  branch's `in` edges. */
	memberships: readonly ApiMembership[];
};

// `grantReaches` — does a grant's opaque `principalRef` reach the caller (public / direct / labelled
// membership) — is DEFINED in @euroclaw/contracts (beside `AccessGrant`), so the skills runtime gate and
// this PEP share ONE matcher. Here it decides graph RENDERING only (which grant becomes a principal `in`
// edge); whether the reached grant's LEVEL satisfies the requirement stays Cedar's `in`. `ApiMembership`
// is a structural superset of the `GrantMembership` it takes, so the richer memberships pass straight in.

/**
 * Render the per-request Cedar entity graph for one governed call: the caller `Principal`, the loaded
 * `Resource` (its owner + the two requirement pointers, all in ATTRIBUTES), and the leveled `Access`
 * chains the owner/scope/grant `in` compares walk. Every DECISION is left to Cedar — this only decides
 * which node each opaque membership/grant maps to (kind-blind). This is the api sibling of quickhr's
 * `loadEntitySlice` (resolve rows into entities/attrs at load), specialized to the generic access model.
 */
function buildApiEntities(input: {
	method: string;
	principal: string;
	level: ApiPermissionLevel;
	resource: ApiResourceShape;
	memberships: readonly ApiMembership[];
}): EntityJson[] {
	const { method, principal, level, resource, memberships } = input;

	const access = (id: string): { type: string; id: string } => ({
		type: API_ACCESS_TYPE,
		id,
	});
	const principalUid = (id: string): { type: string; id: string } => ({
		type: API_PRINCIPAL_TYPE,
		id,
	});
	const scopeBaseOf = (scope: string, scopeId: string): string =>
		`scope:${scope}:${scopeId}`;
	const grantBase = `grant:${method}`;

	// Every access base whose leveled chain must exist so `in` resolves transitively: the resource's own
	// scope (the scope requirement), the grant key (the grant requirement), and each membership's scope.
	const bases = new Set<string>([grantBase]);
	if (resource.scope !== undefined && resource.scopeId !== undefined) {
		bases.add(scopeBaseOf(resource.scope, resource.scopeId));
	}
	for (const m of memberships) bases.add(scopeBaseOf(m.scope, m.scopeId));

	const entities: EntityJson[] = [];
	// The leveled chain per base: `<base>:manage in <base>:use in <base>:read` — each level's node parents
	// the one below, so being `in` a higher node is transitively being `in` every lower one.
	for (const base of bases) {
		for (let i = 0; i < API_LEVELS_ASCENDING.length; i++) {
			const lvl = API_LEVELS_ASCENDING[i];
			const lower = i > 0 ? API_LEVELS_ASCENDING[i - 1] : undefined;
			entities.push({
				uid: access(`${base}:${lvl}`),
				attrs: {},
				parents: lower !== undefined ? [access(`${base}:${lower}`)] : [],
			});
		}
	}

	// The caller's `in` edges — RENDERED from its opaque memberships + the grants that reach it (the kind-
	// blind, euroclaw-resolved side). NO level compare here: each membership makes the caller `in` its own
	// `<scope>:<scopeId>:<level>` node; each reaching grant makes it `in` the resource's
	// `grant:<method>:<level>` node. The chain then decides whether that satisfies the required level.
	const principalParents: Array<{ type: string; id: string }> = [];
	for (const m of memberships) {
		principalParents.push(
			access(`${scopeBaseOf(m.scope, m.scopeId)}:${m.level}`),
		);
	}
	for (const g of resource.grants) {
		if (grantReaches(g, principal, memberships)) {
			principalParents.push(access(`${grantBase}:${g.level}`));
		}
	}
	entities.push({
		uid: principalUid(principal),
		attrs: {},
		parents: principalParents,
	});

	// The resource entity — access in ATTRIBUTES, ALWAYS stamped (cedar-wasm errors on an absent-attribute
	// access, and an erroring permit silently fails to grant). The SENTINEL for "no owner" / "no scope" is
	// the resource's OWN uid: it is a `ClawApi::Resource`, a DIFFERENT entity type than a principal or an
	// access node, so `resource.createdBy == principal` and `principal in resource.requiredScopeAccess`
	// are structurally false (never coincidentally equal to a real caller — airtight without a magic id).
	const resourceUid = { type: API_RESOURCE_TYPE, id: method };
	const createdBy = resource.createdBy;
	const ownerRef =
		createdBy !== undefined && createdBy.trim() !== ""
			? principalUid(createdBy)
			: resourceUid;
	const requiredScopeAccess =
		resource.scope !== undefined && resource.scopeId !== undefined
			? access(`${scopeBaseOf(resource.scope, resource.scopeId)}:${level}`)
			: resourceUid;
	entities.push({
		uid: resourceUid,
		attrs: {
			createdBy: { __entity: ownerRef },
			requiredScopeAccess: { __entity: requiredScopeAccess },
			requiredGrantAccess: { __entity: access(`${grantBase}:${level}`) },
		},
		parents: [],
	});

	return entities;
}

/**
 * Decide a governed `claw.api` call against the product-api Cedar engine — the api-side analog of the
 * floor's tool gate. The actor floor runs FIRST (absent/blank principal → deny, never reaching Cedar);
 * then the opaque shape + the caller's memberships become a per-request `ClawApi::` entity graph the
 * generic baseline (owner ∪ scope ∪ grant, or the create-permit) decides. Returns the engine's
 * `PolicyResult` (the PEP maps a non-permit to a typed authorization error).
 */
export async function decideApiCall(
	input: DecideApiCallInput,
): Promise<PolicyResult> {
	// The actor floor — an absent OR blank/whitespace caller principal is an immediate deny (a host system
	// call passes an explicit `system:` principal, never absence or blank; the facts-vs-posture
	// discipline). Runs BEFORE Cedar and guarantees a real, non-blank principal downstream — so a sentinel
	// or empty-string `createdBy` can never coincidentally equal the caller.
	const principal = input.principal;
	if (principal === undefined || principal.trim() === "") {
		return {
			decision: "deny",
			reason: `app-authz: ${input.method} requires a caller principal (actor floor)`,
		};
	}
	const entities: Entities = buildApiEntities({
		method: input.method,
		principal,
		level: input.level,
		resource: input.resource,
		memberships: input.memberships,
	});
	const request: PolicyRequest = {
		principal: { type: API_PRINCIPAL_TYPE, id: principal },
		action: { type: API_ACTION_TYPE, id: input.method },
		resource: { type: API_RESOURCE_TYPE, id: input.method },
		context: {},
	};
	return input.engine.authorize(request, entities);
}
