// The always-on governance FLOOR — the assembly-internal Cedar engine, wired UNCONDITIONALLY into the
// runtime chokepoint. This is what "governed by default" requires: an engine that arrives via an
// optional plugin can't be default-on, so the assembly internalizes it. The Cedar engine + the
// SYSTEM_POSTURE floor are the ASSEMBLY's; `cedar({ policies })` and any plugin's `policies` are
// SOURCES whose slices merge UNDER the sealed floor (`forbid` > `permit`) — a source can narrow or
// widen, but never remove the floor's un-removable forbids.
//
// slice-0 SCOPE: the floor governs the actions in its MODEL — built from the STATIC `tools` that
// declare an `access` class (read/write). A tool that declares no access class is NOT a policy-modeled
// action: the floor's gate matcher skips it, so its own gate (or nothing, as before)
// still governs it — the existing per-tool chokepoint is untouched. Per-org registered-tool + stored
// policy-slice routing (the `createOrgPolicyRouter` composition) is a later slice; this floor delivers
// zero-config governance for host-declared tools.

import {
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
	type ToolCall,
	type ToolDefinitionSet,
	toolDescriptors,
} from "@euroclaw/contracts";

/** The sealed floor gate id — the un-removable governance baseline. */
export const FLOOR_POLICY_ID = "policy:floor";

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
	// 1. The floor's action model — the STATIC tools that declare an access class. Descriptors carry
	//    governance as a typed field, so this is a projection, not a re-validation: a tool with no
	//    `access` simply isn't a policy-modeled action and drops out.
	const model = buildAuthzModel(
		actionInputsFromTools(toolDescriptors(input.tools ?? {})),
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

	// 4. The always-on gate — SEALED (the floor can't be removed or redefined) and matching only the
	//    MODELED actions. deny-by-default applies WITHIN the modeled set; an unmodeled tool call skips
	//    the floor entirely, preserving its own gate (or ungoverned) behaviour.
	//
	//    A call arrives under its model-facing NAME; the model's actions are PATHS. They coincide for
	//    a host tool (key === path) and diverge for a plugin tool, which is called as
	//    `docs__admin__publish` and modeled as `docs.admin.publish`. This index is the ONE place the
	//    two meet — the matcher and the mapper read it together, so every call the matcher claims is
	//    a call the mapper can address, and a name nothing declared falls through to `call.name` and
	//    is simply unmodeled (the pre-existing skip, never a permit).
	const modeled = new Set(model.actions.map((action) => action.id));
	const pathByName = new Map(
		Object.entries(input.tools ?? {}).map(([name, tool]) => [
			name,
			tool.path ?? name,
		]),
	);
	const actionId = (name: string): string => pathByName.get(name) ?? name;
	const mapCall = cedarMapCall({ model });
	return createPolicyPlugin({
		engine,
		mapCall: (call, ctx) =>
			mapCall({ ...call, name: actionId(call.name) }, ctx),
		matcher: (call: ToolCall) => modeled.has(actionId(call.name)),
		id: FLOOR_POLICY_ID,
		sealed: true,
	});
}
