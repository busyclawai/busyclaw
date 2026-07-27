// The always-on governance FLOOR — the assembly-internal Cedar engine, wired UNCONDITIONALLY into the
// runtime chokepoint. This is what "governed by default" requires: an engine that arrives via an
// optional plugin can't be default-on, so the assembly internalizes it. The Cedar engine + the
// SYSTEM_POSTURE floor are the ASSEMBLY's; `cedar({ policies })` and any plugin's `policies` are
// SOURCES whose slices merge UNDER the sealed floor (`forbid` > `permit`) — a source can narrow or
// widen, but never remove the floor's un-removable forbids.
//
// SCOPE: the floor gate sees EVERY tool call, and the model classifies them. A static tool that
// declares no `access` class is modeled as a WRITE (confirmation interactively, refusal autonomously);
// an action the model does not contain at all reaches Cedar and is denied, because no policy can name
// it. Both are deliberate — the floor previously matched only modeled actions, which turned a missing
// stamp into an ungoverned tool. Per-org registered-tool + stored policy-slice routing (the
// `createOrgPolicyRouter` composition) is a later slice.

import {
	actionEntitiesFromModel,
	actionInputsFromTools,
	buildAuthzModel,
	cedarFloorEngine,
	cedarMapCall,
	createPolicyPlugin,
	createShadowPolicyEngine,
	loadPolicyBundle,
	SYSTEM_POSTURE,
} from "@euroclaw/authz";
import {
	type EuroclawPlugin,
	type PolicyEngine,
	type PolicySourceSlice,
	runActionsOf,
	type ToolDefinitionSet,
	type ToolDescriptor,
	toolDescriptors,
} from "@euroclaw/contracts";
import { discoveryTools, EXECUTE_TOOL_PATH } from "@euroclaw/runtime";

/** The sealed floor gate id — the un-removable governance baseline. */
export const FLOOR_POLICY_ID = "policy:floor";

/**
 * The descriptors the floor turns into policy-nameable ACTIONS — everything except
 * `euroclaw.execute`.
 *
 * That one is a wire ENCODING of a call, not a tool. The ingress unwraps it and the floor decides the
 * TARGET, so a policy naming `euroclaw.execute` would be inert for real routing while LOOKING like
 * control over the router — a `forbid` on it blocks nothing, and a `permit(writes)` would sweep it up
 * with everything else. discovery.ts's header states the invariant this keeps: execute must never be
 * the thing governance decides on.
 *
 * ONE function because the model is built in TWO places — once at assembly from the static tools, and
 * once per run from the tools a boundary registered. The first version wrote the exclusion out at the
 * assembly site only, and the per-run path put `execute` straight back: the meta-tools are minted from
 * whatever set is discoverable, so a claw with nothing statically discoverable and a registered tool
 * that IS mints them per run. The invariant then held in one configuration and broke in the other,
 * which is the worst way for a security property to behave. Both callers go through here.
 *
 * Exported for its own test: it is a one-line predicate carrying an invariant that already regressed
 * once by being written out twice, so it is worth pinning directly rather than only through whichever
 * behaviour happens to notice.
 */
export function modelableActions(
	descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
	return descriptors.filter(
		(descriptor) => descriptor.path !== EXECUTE_TOOL_PATH,
	);
}

/**
 * Build the always-on floor policy plugin: the ONE internal Cedar engine over `SYSTEM_POSTURE` +
 * every plugin's `policies` sources, wrapped in a SEALED before-gate. The gate matches only the
 * MODELED actions (host tools that declare an access class) so unstamped tools stay governed exactly
 * as before. Returned as a plugin the assembly prepends to the runtime's plugin list — always present,
 * never a config option.
 */
export function buildFloorPolicyPlugin(input: {
	tools?: ToolDefinitionSet;
	plugins: readonly EuroclawPlugin[];
	warn?: (message: string) => void;
}): EuroclawPlugin {
	// 1. The floor's action model — every tool the run can reach, classified. Descriptors carry
	//    governance as a typed field, so this is a projection, not a re-validation.
	//
	//    The host's tools are not the whole set. The runtime injects its own always-on meta-tools
	//    (`euroclaw.search`, `euroclaw.execute`) into the same chokepoint, and once the floor gate
	//    stopped skipping unmodeled calls, anything the model does not contain is DENIED. Omitting
	//    them here would therefore have refused discovery itself — search returning nothing, not
	//    because policy said so but because the assembly never told the model those tools exist.
	//    They are added from the same `discoveryTools` the runtime will build, so the two cannot
	//    drift: it derives them from the tool set, and returns nothing when none are discoverable.
	//
	//    `euroclaw.execute` is the ONE deliberate exclusion — see {@link modelableActions}.
	const tools = input.tools ?? {};
	const model = buildAuthzModel(
		actionInputsFromTools(
			modelableActions(toolDescriptors({ ...tools, ...discoveryTools(tools) })),
		),
	);

	// 2. Policy SOURCES: every plugin's `policies` slices, merged UNDER the sealed floor. `cedar({
	//    policies })` is the canonical contributor; any plugin may add slices. `PolicySourceSlice` is
	//    structurally the bundle-loader's input.
	const slices: PolicySourceSlice[] = input.plugins.flatMap(
		(plugin) => plugin.policies ?? [],
	);
	const bundle = loadPolicyBundle({ system: SYSTEM_POSTURE, slices });
	// Policy-ANNOTATION keys plugins declare (`@escalate("team:x")` → `{ key: "escalate" }`). Collected
	// the same way as `policies`/`shareable`: statically off the raw plugin, before any configure runs.
	// The keys stay OPAQUE here — a declared key's value rides the decision out for the plugin to act on.
	const annotations = input.plugins.flatMap(
		(plugin) => plugin.policyAnnotations ?? [],
	);

	// 3. The ONE internal engine over the merged live set (+ a shadow candidate ONLY when a source
	//    contributed a shadow slice — a real second evaluation that never changes the live decision).
	const live = cedarFloorEngine({ policies: bundle.live, model, annotations });
	const warn = input.warn ?? ((message: string) => console.warn(message));
	const shadowPolicies = bundle.shadow;
	const engine: PolicyEngine = shadowPolicies
		? createShadowPolicyEngine({
				live,
				candidate: () =>
					cedarFloorEngine({ policies: shadowPolicies, model, annotations }),
				observe: (divergence) =>
					warn(
						`euroclaw authz shadow divergence on ${divergence.request.action.id}: live=${divergence.live} candidate=${divergence.candidate}`,
					),
			})
		: live;

	// 4. The always-on gate — SEALED (the floor can't be removed or redefined) and matching EVERY tool
	//    call. It used to match only the modeled actions, which made "absent from the model" mean
	//    "skip the floor": the two cheapest mistakes in the system — forgetting an access stamp, and
	//    registering a tool after the static model was compiled — both landed on ungoverned execution.
	//    Deny-by-default is worth nothing if not-being-asked is reachable.
	//
	//    An action the model does not declare now reaches Cedar and is REFUSED there: no policy can
	//    name it, so nothing permits it, and the sealed posture's default is deny. That is the fallback
	//    rule — unknown means no, never "no matching gate, therefore continue". A host that wants a
	//    dynamic tool to run must put it in the model, not omit it from the question.
	//
	//    `call.name` IS the action id here: the model-facing wire name is translated back to the
	//    canonical path at the run loop's ingress, so the floor — like dispatch, the audit and every
	//    gate — only ever sees paths. It used to need an index to reconcile the two, which put a
	//    second id inside the governance layer; moving the translation to the edge deleted it.
	const mapCall = cedarMapCall({ model });
	// 5. Per-RUN actions. The model above is compiled once, from the static tools — but a boundary's
	//    registered tools arrive per run through `resolveTools`, after that compilation. An action the
	//    model has never heard of is refused, so without this a registered tool could never run: the
	//    fallback rule that makes unknown mean no would also make "not yet known" mean no.
	//
	//    The runtime stamps this run's extra descriptors onto the resolved context; they become action
	//    entities merged UNDER the engine's directory, so a run can ADD actions and never redefine one.
	//    Cached by the descriptor array's identity — one array per run, so this builds once per run
	//    rather than once per tool call.
	const runEntities = new WeakMap<object, unknown>();
	return createPolicyPlugin({
		engine,
		mapCall,
		entitiesFor: (ctx) => {
			const descriptors = runActionsOf(ctx);

			if (descriptors.length === 0) return undefined;
			const cached = runEntities.get(descriptors);
			if (cached !== undefined) return cached;
			const built = actionEntitiesFromModel(
				buildAuthzModel(actionInputsFromTools(modelableActions(descriptors))),
			);
			runEntities.set(descriptors, built);
			return built;
		},
		id: FLOOR_POLICY_ID,
		sealed: true,
	});
}
