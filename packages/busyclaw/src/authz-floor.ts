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
	authzBundleKey,
	buildAuthzModel,
	cedarFloorEngine,
	cedarMapCall,
	createOrgPolicyRouter,
	createPolicyPlugin,
	createShadowPolicyEngine,
	loadPolicyBundle,
	SYSTEM_POSTURE,
} from "@busyclaw/authz";
import {
	type BusyclawPlugin,
	type PolicyEngine,
	type PolicySourceSlice,
	runActionsOf,
	type ScopeRef,
	type ToolCall,
	type ToolDefinitionSet,
	type ToolDescriptor,
	toolDescriptors,
} from "@busyclaw/contracts";
import {
	discoveryTools,
	EXECUTE_TOOL_PATH,
	originOfCall,
} from "@busyclaw/runtime";

/** The sealed floor gate id — the un-removable governance baseline. */
export const FLOOR_POLICY_ID = "policy:floor";

/**
 * The descriptors the floor turns into policy-nameable ACTIONS — everything except
 * `busyclaw.execute`.
 *
 * That one is a wire ENCODING of a call, not a tool. The ingress unwraps it and the floor decides the
 * TARGET, so a policy naming `busyclaw.execute` would be inert for real routing while LOOKING like
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
	plugins: readonly BusyclawPlugin[];
	warn?: (message: string) => void;
	/** The durable registry, when the claw has a database. Present ⇒ customer policy slices written
	 *  through `putPolicySlice` REACH this floor; absent ⇒ code-owned policy only, exactly as before.
	 *  Stored slices used to be written, kept, and never consulted — the floor a running claw enforced
	 *  was whatever compiled at createClaw, so an admin editing policy changed nothing and was told
	 *  nothing. */
	registry?: {
		policySlices: {
			listForScope: (ref: ScopeRef) => Promise<readonly PolicySourceSlice[]>;
		};
		authzChanges: { count: (ref: ScopeRef) => Promise<number> };
	};
}): BusyclawPlugin {
	// 1. The floor's action model — every tool the run can reach, classified. Descriptors carry
	//    governance as a typed field, so this is a projection, not a re-validation.
	//
	//    The host's tools are not the whole set. The runtime injects its own always-on meta-tools
	//    (`busyclaw.search`, `busyclaw.execute`) into the same chokepoint, and once the floor gate
	//    stopped skipping unmodeled calls, anything the model does not contain is DENIED. Omitting
	//    them here would therefore have refused discovery itself — search returning nothing, not
	//    because policy said so but because the assembly never told the model those tools exist.
	//    They are added from the same `discoveryTools` the runtime will build, so the two cannot
	//    drift: it derives them from the tool set, and returns nothing when none are discoverable.
	//
	//    `busyclaw.execute` is the ONE deliberate exclusion — see {@link modelableActions}.
	const tools = input.tools ?? {};
	const staticDescriptors = modelableActions(
		toolDescriptors({ ...tools, ...discoveryTools(tools) }),
	);
	const model = buildAuthzModel(actionInputsFromTools(staticDescriptors));

	// 1b. The egress origin each of those tools DECLARES — the `context.server` fact, so a policy can
	//     say where a tool may reach and have that fire. It used to be stamped by nothing: the mapper
	//     has always accepted a `serverForAction` provider, the assembly never passed one, and the
	//     only thing in the repo that built one was a test. So `context.server` was a fact the schema
	//     declared, the docs designed around, and no running claw ever produced — a policy naming it
	//     was inert, which is the worst state for a governance fact to be in. It reads as enforcement.
	const staticByPath = new Map(
		staticDescriptors.map((descriptor) => [descriptor.path, descriptor]),
	);

	// 2. Policy SOURCES: every plugin's `policies` slices, merged UNDER the sealed floor. `cedar({
	//    policies })` is the canonical contributor; any plugin may add slices. `PolicySourceSlice` is
	//    structurally the bundle-loader's input.
	// Only slices that say they govern THIS plane — see PolicySourceSlice.plane. A slice aimed at the
	// product api is not merely inert here, it is not compiled here.
	const slices: PolicySourceSlice[] = input.plugins.flatMap((plugin) =>
		(plugin.policies ?? []).filter(
			(slice) => slice.plane === "tool" || slice.plane === "both",
		),
	);
	// Policy-ANNOTATION keys plugins declare (`@escalate("team:x")` → `{ key: "escalate" }`). Collected
	// the same way as `policies`/`shareable`: statically off the raw plugin, before any configure runs.
	// The keys stay OPAQUE here — a declared key's value rides the decision out for the plugin to act on.
	const annotations = input.plugins.flatMap(
		(plugin) => plugin.policyAnnotations ?? [],
	);

	const warn = input.warn ?? ((message: string) => console.warn(message));

	// 3. The engine over a merged live set (+ a shadow candidate ONLY when a source contributed a
	//    shadow slice — a real second evaluation that never changes the live decision).
	const engineOver = (merged: PolicySourceSlice[]): PolicyEngine => {
		const compiled = loadPolicyBundle({
			system: SYSTEM_POSTURE,
			slices: merged,
		});
		const live = cedarFloorEngine({
			policies: compiled.live,
			model,
			annotations,
		});
		const shadowPolicies = compiled.shadow;
		if (!shadowPolicies) return live;
		return createShadowPolicyEngine({
			live,
			candidate: () =>
				cedarFloorEngine({ policies: shadowPolicies, model, annotations }),
			observe: (divergence) =>
				warn(
					`busyclaw authz shadow divergence on ${divergence.request.action.id}: live=${divergence.live} candidate=${divergence.candidate}`,
				),
		});
	};

	// 3b. With a database, each decision resolves to its boundary's bundle: code-owned slices PLUS
	//     whatever that scope stored. Content-addressed — `keyFor` folds in the append-only change
	//     log's count, so a write bumps the count, the next decision misses the cache, and the bundle
	//     rebuilds. That is why there is no invalidate call to forget: the key IS the content.
	//
	//     Only tool-plane stored slices land here, for the same reason plugin slices are filtered
	//     (R-H04) — a slice naming no resource type matches everything in whichever engine it reaches.
	const registry = input.registry;
	// Built EAGERLY, always — even when a router will serve the decisions. The code-owned set is known
	// at assembly, so a malformed policy or an over-long annotation must fail HERE, when the claw is
	// built, rather than on whichever request happens to be first. Routing made every build lazy and
	// silently moved that failure into traffic; this is also the bundle every uncustomized boundary
	// resolves to, so nothing is compiled twice to keep the property.
	const codeOwned = engineOver(slices);
	const engine: PolicyEngine = registry
		? createOrgPolicyRouter({
				// The router picks a bundle; it does not decide, so it must not describe itself as a
				// weaker evaluator than the bundles it serves. Every one of them comes from `engineOver`,
				// so they all declare the same capabilities — and the coverage audit reads these to warn
				// when a policy's intent needs something no installed engine has. Left unset, routing
				// silently downgraded the floor to "no declared capabilities" and those warnings would
				// have fired against the one engine that does support arg-conditions and approvals.
				...(codeOwned.capabilities
					? { capabilities: codeOwned.capabilities }
					: {}),
				keyFor: async (ref) =>
					authzBundleKey({
						configScope: ref,
						changeCount: await registry.authzChanges.count(ref),
					}),
				engineFor: async (ref) => {
					// No absent-boundary branch. A run that names no tenant carries UNSCOPED, nothing is
					// ever stored there, so it falls out of the general path below as the code-owned
					// bundle — by the same rule every uncustomized boundary follows, rather than by a
					// special case that had to be kept in step with it.
					const stored = await registry.policySlices.listForScope(ref);
					const tool = stored.filter(
						(slice) => slice.plane === "tool" || slice.plane === "both",
					);
					// A scope with no slices of its own is the same bundle too — the router keys them
					// together, and rebuilding per scope would be work with no different answer.
					if (tool.length === 0) return codeOwned;
					return engineOver([...slices, ...tool]);
				},
			})
		: codeOwned;

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
	//    The origin resolver reaches the same two places the ACTIONS come from — the static set, and
	//    this run's registered descriptors. Both, because either alone is wrong in a way that reads as
	//    policy: a run-only resolver leaves a host's own bound tools with no declared destination, and
	//    a static-only one leaves every registered tool without the fact the egress rules are written
	//    about. The per-run half is cached on the descriptor array's identity, like the entities below.
	const runByPath = new WeakMap<object, Map<string, ToolDescriptor>>();
	const originFor = (input: {
		call: ToolCall;
		ctx: unknown;
	}): string | undefined => {
		const { call, ctx } = input;
		const fromStatic = staticByPath.get(call.name);
		if (fromStatic !== undefined) return originOfCall(fromStatic, call.args);
		const descriptors = runActionsOf(ctx);
		if (descriptors.length === 0) return undefined;
		let indexed = runByPath.get(descriptors);
		if (indexed === undefined) {
			indexed = new Map(descriptors.map((d) => [d.path, d]));
			runByPath.set(descriptors, indexed);
		}
		const descriptor = indexed.get(call.name);
		return descriptor && originOfCall(descriptor, call.args);
	};
	const mapCall = cedarMapCall({ model, serverForAction: originFor });
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
