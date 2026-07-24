// The Cedar EVAL surfaces — the runtime that turns the neutral model + policy TEXT into decisions.
// Consolidated into @euroclaw/authz beside cedar.ts (the schema renderer these consume) so this
// package is THE Cedar decision engine:
//   - `cedarMapCall(config)`     — the default request mapper (tool call → PARC request): stamps the
//     spoof-proof facts, projects `context.args` to the model's declared subset, and stamps the
//     model-derived `context.server`. Used BOTH by the assembly's floor engine and `cedarPolicyPlugin`.
//   - `cedarFloorEngine(config)` — raw policy TEXT + the action MODEL → a Cedar PolicyEngine, the
//     model's action hierarchy merged in as entities. What the assembly compiles its internal floor
//     bundle (SYSTEM_POSTURE + plugin `policies` sources) into.
//   - `cedarPolicyPlugin(config)`— the engine-wrapper ESCAPE HATCH: `cedarEngine` + `cedarMapCall`
//     behind `createPolicyPlugin`, with NO floor. For a host that wants Cedar as a standalone gate
//     outside the assembly, and for the policy-engine test surface.
//
// The `cedar()` policy-TEXT SOURCE (contributes slices under the floor, no eval) lives in
// @euroclaw/policy-cedar. The AUTHORIZATION MODEL drives the mapper/engine when provided: it renders
// the Cedar schema, merges the action hierarchy into the entities (so `action in Action::"writes"`
// works at evaluation time), and filters `context.args` to the PROJECTED subset (the same walker that
// rendered the schema, so request validation and reality never disagree).

import type { Entities } from "@cedar-policy/cedar-wasm/nodejs";
import type {
	AuthzModel,
	PolicyEngine,
	PolicyRequest,
	ToolCall,
} from "@euroclaw/contracts";
import {
	authorizationError,
	configurationError,
	PRINCIPAL_CONTEXT_KEY,
	stampedFacts,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import {
	actionEntitiesFromModel,
	apiActionEntities,
	modelToCedarSchema,
} from "./cedar";
import { cedarEngine } from "./cedar-engine";
import type {
	CedarContext,
	CedarEngine,
	CedarEntitiesInput,
	CedarMapCallConfig,
	CedarPluginConfig,
} from "./cedar-types";
import { createPolicyPlugin, type PolicyPlugin } from "./plugin";
import type { NamedPolicies } from "./policy-bundle";
import { type ArgsProjection, projectArgs } from "./projection";

type ModelIndexEntry = {
	resourceType: string;
	projection: ArgsProjection | undefined;
};

/** Per-action lookup, projected ONCE at construction (render and filter share the walker). */
function indexModel(model: AuthzModel): Map<string, ModelIndexEntry> {
	const index = new Map<string, ModelIndexEntry>();
	for (const action of model.actions) {
		index.set(action.id, {
			resourceType: action.resourceType,
			projection: action.args ? projectArgs(action.args) : undefined,
		});
	}
	return index;
}

/**
 * The default request mapper: turn a governed tool call + the request context into a PARC request.
 *   principal = `${principalType}::"${stamped euroclaw__principal}"`, action = `Action::"<tool>"`,
 *   resource  = `${resourceType}::"<tool>"`, context = `{ args, <approvalFlag>:false, <facts>, … }`.
 * The principal is the ONE stamped identity (never the caller-controllable unprefixed `ctx.principal` —
 * audit #7); absent → fail closed (deny).
 * With `model`, `context.args` carries only the PROJECTED subset for the matched action and the
 * resource type comes from the model. Exported so the assembly's internal floor engine and
 * `cedarPolicyPlugin` share ONE mapping — request validation and reality never disagree.
 */
export function cedarMapCall(
	config: CedarMapCallConfig = {},
): (call: ToolCall, ctx: CedarContext) => PolicyRequest {
	const principalType = config.principalType ?? "User";
	const resourceType = config.resourceType ?? "Tool";
	const approvalFlag = config.approvalFlag ?? "confirmationUsed";
	const resourceId = (name: string) =>
		config.prefix ? `${config.prefix}:${name}` : name;
	const modelIndex = config.model ? indexModel(config.model) : undefined;

	return (call: ToolCall, ctx: CedarContext): PolicyRequest => {
		// The PARC principal is the ONE stamped identity — `euroclaw__principal`, written ONLY by the
		// trusted context assembly (the caller seed / the identity resolver) AFTER the caller's own
		// `euroclaw__` keys were stripped. NEVER the caller-controllable unprefixed `ctx.principal`
		// (audit #7: reading that let a forged principal drive the Cedar decision while audit/store
		// recorded the stamped one). Absent → the run carries no authenticated identity: FAIL CLOSED
		// (deny — a thrown authz error refuses the call), never authorize a modeled action for nobody.
		const principal = ctx[PRINCIPAL_CONTEXT_KEY];
		if (typeof principal !== "string" || principal.length === 0) {
			throw authorizationError("tool floor denies: no stamped principal", {
				reason:
					"the run has no authenticated identity (euroclaw__principal is unset) — fail closed",
			});
		}
		// The runtime-stamped facts (role/team from membership, clawId/runMode/organizationId from the
		// runtime — spoof-proof: caller euroclaw__ keys are stripped upstream), read through the ONE
		// typed contracts reader. A garbage stamp is a host config bug: fail loud here, never silently
		// unstamped.
		const facts = stampedFacts(ctx);
		if (facts instanceof type.errors) {
			throw validationError("cedar context invalid", facts.summary);
		}
		const indexed = modelIndex?.get(call.name);
		// Model-aware args: only the PROJECTED subset crosses (Cedar records are closed — an undeclared
		// attr fails request validation; the projection dropped it from the schema).
		const args = indexed
			? indexed.projection
				? { args: indexed.projection.filter(call.args) }
				: {}
			: { args: call.args };
		// The egress origin comes from the model/binding side provider, NOT ctx — a caller/model cannot
		// forge context.server, and a tool cannot target a server it did not declare.
		const server = config.serverForAction?.(call.name);
		return {
			principal: { type: principalType, id: principal },
			action: { type: "Action", id: call.name },
			resource: {
				type: indexed?.resourceType ?? resourceType,
				id: resourceId(call.name),
			},
			context: {
				...args,
				[approvalFlag]: false,
				...facts,
				// runMode is ALWAYS stamped (default autonomous) so policies can reference
				// context.runMode without the missing-attribute error cedar-wasm raises on an absent
				// optional — an unknown mode reads as autonomous, the fail-closed default.
				runMode: facts.runMode ?? "autonomous",
				...(server !== undefined ? { server } : {}),
			},
		};
	};
}

/**
 * Build a Cedar PolicyEngine from raw policy TEXT + the action MODEL: the model's action hierarchy
 * becomes the engine's entities so `action in Action::"<group>"` resolves at evaluation time. This is
 * what the ASSEMBLY compiles its internal floor bundle (SYSTEM_POSTURE + plugin `policies` sources)
 * into — the cedar-wasm entity cast stays localized here, in the package that owns Cedar.
 */
export function cedarFloorEngine(config: {
	policies: string | NamedPolicies;
	model: AuthzModel;
}): PolicyEngine {
	return cedarEngine({
		policies: config.policies,
		entities: actionEntitiesFromModel(config.model) as Entities,
	});
}

/**
 * Build the product-api Cedar PolicyEngine (`decideApiCall`'s engine) from the compiled api policy
 * text + the governed method names: the `ClawApi::Action` hierarchy becomes the engine's entities so
 * `action in ClawApi::Action::"api"`/`"creates"` resolves at evaluation time. The api-side sibling of
 * `cedarFloorEngine` — the tool floor's SYSTEM_POSTURE is deliberately NOT here: reads/writes/confirm
 * is an AGENT-autonomy floor, meaningless for product-api calls, whose sealed floor is the generic
 * `API_ACCESS_BASELINE`. So this engine only ever sees `ClawApi::` policies + entities.
 */
export function cedarApiEngine(config: {
	policies: string | NamedPolicies;
	methods: readonly string[];
	createMethods: readonly string[];
}): CedarEngine {
	return cedarEngine({
		policies: config.policies,
		entities: apiActionEntities({
			methods: config.methods,
			createMethods: config.createMethods,
		}) as Entities,
	});
}

/**
 * The engine-wrapper ESCAPE HATCH (the shape `cedar()` used to be): `cedarEngine` + `cedarMapCall`
 * behind `createPolicyPlugin`, with NO SYSTEM_POSTURE floor. `createGovernance({ plugins: [
 * cedarPolicyPlugin({ policies }) ] })` makes every matched tool call answer to Cedar directly
 * (deny-by-default). The COMMON path is now the assembly's internal engine + `cedar()` sources —
 * this remains for a host that wants Cedar as a standalone gate and for the policy-engine test surface.
 */
export function cedarPolicyPlugin(
	config: CedarPluginConfig,
): PolicyPlugin<CedarContext> {
	if (config.model && config.schema !== undefined) {
		throw configurationError(
			"cedarPolicyPlugin: provide `model` (schema is rendered from it) or `schema`, not both",
		);
	}

	// With a model: the action hierarchy must exist at EVALUATION time for `action in`, so the model's
	// action entities merge into whatever the host's entities (or provider) supply.
	const schema = config.model
		? modelToCedarSchema(config.model)
		: config.schema;
	const actionEntities = config.model
		? (actionEntitiesFromModel(config.model) as Entities)
		: undefined;
	const entities: CedarEntitiesInput | undefined = actionEntities
		? async () => {
				const base =
					typeof config.entities === "function"
						? await config.entities()
						: (config.entities ?? []);
				return [...base, ...actionEntities] as Entities;
			}
		: config.entities;

	const mapCall =
		config.mapCall ??
		cedarMapCall({
			...(config.model !== undefined ? { model: config.model } : {}),
			...(config.principalType !== undefined
				? { principalType: config.principalType }
				: {}),
			...(config.resourceType !== undefined
				? { resourceType: config.resourceType }
				: {}),
			...(config.approvalFlag !== undefined
				? { approvalFlag: config.approvalFlag }
				: {}),
			...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
			...(config.serverForAction !== undefined
				? { serverForAction: config.serverForAction }
				: {}),
		});
	return createPolicyPlugin({
		engine: cedarEngine({
			policies: config.policies,
			...(schema !== undefined ? { schema } : {}),
			...(entities !== undefined ? { entities } : {}),
			...(config.validateRequest !== undefined
				? { validateRequest: config.validateRequest }
				: {}),
			...(config.approvalFlag !== undefined
				? { approvalFlag: config.approvalFlag }
				: {}),
		}),
		mapCall,
		matcher: config.matcher,
		id: config.id ?? "policy:cedar",
		sealed: config.sealed,
	});
}
