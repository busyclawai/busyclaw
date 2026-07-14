// Cedar RENDERINGS of the neutral authorization model — pure string/data generation, no
// cedar-wasm here (the eval that consumes these lives beside it in ./cedar-engine). The model is
// canonical; Cedar text is
// a projection of it: one action per ActionDef with typed context.args (via the shared
// projection — render and request-filter must agree), action groups via `in [...]` membership,
// entity types with parents and `tags String` (ABAC via hasTag/getTag), principals declared by
// the host (default User).

import type {
	ActionDef,
	AuthzEntity,
	AuthzModel,
	EntityRef,
	JsonObject,
} from "@euroclaw/contracts";
import { API_ACTION_GROUP, API_ACTION_TYPE, API_CREATE_GROUP } from "./api";
import { cedarQuote, projectArgs } from "./projection";

export type CedarSchemaOptions = {
	/** Wrap the schema in a namespace. Default: none (policies say `Action::"x"`, `Tool::"y"`). */
	namespace?: string;
	/** Principal entity types declared and applied to every action. Default `["User"]`. */
	principalTypes?: readonly string[];
};

// The standard request context every action carries — the runtime-stamped, spoof-proof facts.
// `confirmationUsed` is always present (mapCall hardcodes false; the probe flips it); the rest
// are optional (stamped when resolution provides them). `server` is the model-derived egress
// origin of the action's binding (a registered tool literally cannot target another server), so an
// org can write egress policy over `context.server`. Per-action `args` appends when the action's
// schema projects.
const CONTEXT_FIELDS =
	"confirmationUsed: Bool, clawId?: String, organizationId?: String, role?: String, runMode?: String, server?: String, team?: String";

function renderAction(
	action: ActionDef,
	principals: readonly string[],
): string {
	const membership = action.groups.length
		? ` in [${action.groups.map((g) => cedarQuote(g)).join(", ")}]`
		: "";
	const projection = action.args ? projectArgs(action.args) : undefined;
	const args = projection ? `, args?: ${projection.cedarType}` : "";
	return `action ${cedarQuote(action.id)}${membership} appliesTo {principal: [${principals.join(", ")}], resource: [${action.resourceType}], context: {${CONTEXT_FIELDS}${args}}};`;
}

/** Render the model as Cedar schema text (the ./cedar-engine eval parses/validates it). */
export function modelToCedarSchema(
	model: AuthzModel,
	options: CedarSchemaOptions = {},
): string {
	const principals = options.principalTypes ?? ["User"];

	// Declare every entity type: principals, the model's resource types, and any parent types
	// referenced but not declared (defensive — a hand-built model may omit them).
	const declared = new Map<string, readonly string[]>();
	for (const p of principals) declared.set(p, []);
	for (const e of model.entityTypes) {
		declared.set(e.type, e.parents ?? []);
	}
	for (const e of model.entityTypes) {
		for (const parent of e.parents ?? []) {
			if (!declared.has(parent)) declared.set(parent, []);
		}
	}
	const entities = [...declared.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([type, parents]) => {
			const inClause = parents.length ? ` in [${parents.join(", ")}]` : "";
			return `entity ${type}${inClause} tags String;`;
		});

	// Action groups: the model's declared groups plus any referenced by actions (defensive).
	const groupIds = new Map<string, readonly string[]>();
	for (const g of model.groups) groupIds.set(g.id, g.memberOf ?? []);
	for (const a of model.actions) {
		for (const g of a.groups) if (!groupIds.has(g)) groupIds.set(g, []);
	}
	const groups = [...groupIds.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, memberOf]) => {
			const inClause = memberOf.length
				? ` in [${memberOf.map((m) => cedarQuote(m)).join(", ")}]`
				: "";
			return `action ${cedarQuote(id)}${inClause};`;
		});

	const actions = model.actions.map((a) => renderAction(a, principals));

	const body = [...entities, "", ...groups, "", ...actions].join("\n");
	return options.namespace
		? `namespace ${options.namespace} {\n${body}\n}`
		: body;
}

/** One entity in cedar-wasm's Entities JSON shape. */
export type CedarEntityJson = {
	uid: EntityRef;
	attrs: JsonObject;
	parents: EntityRef[];
	tags?: Record<string, string>;
};

/** Map the directory's entities into cedar-wasm's Entities shape (attrs/parents defaulted). */
export function entitiesToCedarJson(
	entities: readonly AuthzEntity[],
): CedarEntityJson[] {
	return entities.map((e) => ({
		uid: e.uid,
		attrs: e.attrs ?? {},
		parents: [...(e.parents ?? [])],
		...(e.tags !== undefined ? { tags: e.tags } : {}),
	}));
}

/**
 * The model's actions as Action entities (with their group parents) in cedar-wasm shape.
 * `action in Action::"group"` needs the action hierarchy at AUTHORIZATION time, not just in the
 * schema — merge these into the entities passed to the authorizer.
 */
export function actionEntitiesFromModel(model: AuthzModel): CedarEntityJson[] {
	const groupRef = (id: string): EntityRef => ({ type: "Action", id });
	const groups = model.groups.map((g) => ({
		uid: groupRef(g.id),
		attrs: {},
		parents: (g.memberOf ?? []).map(groupRef),
	}));
	const actions = model.actions.map((a) => ({
		uid: groupRef(a.id),
		attrs: {},
		parents: a.groups.map(groupRef),
	}));
	return [...groups, ...actions];
}

/**
 * The `ClawApi::Action` hierarchy for the product-api PEP — every governed method under the `"api"`
 * umbrella group (the owner/scope/grant permits target it), create methods additionally under
 * `"creates"` (the create-permit targets it; `"creates" in "api"`, so a create action is still in the
 * umbrella by transitivity). The api engine needs this at EVALUATION time, exactly as the tool floor
 * needs `actionEntitiesFromModel` — but under the ClawApi ACTION NAMESPACE, which is the whole reason a
 * `ClawApi::` policy cannot reach a `Tool::` request. Kept beside the tool renderer because this is
 * where the cedar-wasm entity shape lives. `buildAuthzModel` is deliberately NOT reused: it hardcodes
 * an access→`reads`/`writes` group (the pre-§6 tool-risk axis) and `actionEntitiesFromModel` emits
 * UNQUALIFIED `Action::…` uids — both wrong for the generic, namespaced permission-level model.
 */
export function apiActionEntities(input: {
	methods: readonly string[];
	createMethods: readonly string[];
}): CedarEntityJson[] {
	const ref = (id: string): EntityRef => ({ type: API_ACTION_TYPE, id });
	const creates = new Set(input.createMethods);
	const groups: CedarEntityJson[] = [
		{ uid: ref(API_ACTION_GROUP), attrs: {}, parents: [] },
		{ uid: ref(API_CREATE_GROUP), attrs: {}, parents: [ref(API_ACTION_GROUP)] },
	];
	const actions: CedarEntityJson[] = input.methods.map((method) => ({
		uid: ref(method),
		attrs: {},
		parents: [
			creates.has(method) ? ref(API_CREATE_GROUP) : ref(API_ACTION_GROUP),
		],
	}));
	return [...groups, ...actions];
}
