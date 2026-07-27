// The product-API PEP — the api-side analog of the always-on governance FLOOR (authz-floor.ts). Where
// the floor gates AGENT tool calls (`Tool::`), this gates PRODUCT-API calls (`ClawApi::`): one wrapper
// over the WHOLE assembled `claw.api` (core methods AND plugin namespaces alike), each governed method
// routed through `decideApiCall` before it executes. Deny → a typed `authorizationError` (fail-loud,
// like the tool gate). Always-on (governed by default); the escape hatches are explicit and shame-named.
//
// THE MODEL IS GENERIC (docs/plans/app-authz.md §6): the PEP never learns "admin"/"self-service" tiers
// or what "organization" means. It loads an OPAQUE resource SHAPE and checks owner ∪ scope-member ∪
// grant at the action's required LEVEL (read < use < manage). The (scope,scopeId)/grant matching is
// generic and kind-blind; the level decision is Cedar's. See @busyclaw/authz `decideApiCall`.

import {
	API_ACCESS_BASELINE,
	type ApiPermissionLevel,
	type ApiResourceShape,
	type CedarEngine,
	cedarApiEngine,
	decideApiCall,
	loadPolicyBundle,
	type PrincipalScope,
} from "@busyclaw/authz";
import {
	type AccessGrantStore,
	type Adapter,
	type ApprovalStore,
	type AuthzContext,
	type AuthzTarget,
	authorizationError,
	type ClawRunReadModel,
	type ClawsStore,
	configurationError,
	ENDPOINTS_METADATA,
	type EndpointRoute,
	type BusyclawPlugin,
	endpointRoutesOf,
	errorMessage,
	isReservedScope,
	type LooseResourceBinding,
	type PolicySourceSlice,
	RESERVED_SCOPE_PREFIX,
	type RouteAuthz,
	type ShareableLoaderContext,
	type ShareableResource,
	SYSTEM_ANONYMOUS,
} from "@busyclaw/contracts";
import {
	type ClawApiCaller,
	type ClawApiMethod,
	clawApiRouteList,
	NON_ROUTED_API_AUTHZ,
	PROVIDER_TOOL_CALL_SEPARATOR,
} from "./api";

/**
 * The api surface with the caller context appended to every method (flat and nested). A method
 * `(input) => R` becomes `(input, caller?) => R`; a plugin namespace recurses. The caller is OPTIONAL
 * at the type level — you CAN omit it, and then the actor floor denies at runtime (the "zero-config is
 * protected" property). Existing single-arg call sites keep compiling; only the runtime denies them.
 */
export type WithCaller<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R
		? (...args: [...A, caller?: ClawApiCaller]) => R
		: T[K] extends Record<string, unknown>
			? WithCaller<T[K]>
			: T[K];
};

/**
 * The app-authz posture. Both hatches are OFF by default — the PEP enforces. `unsafeOpen` restores the
 * pre-PEP "the host authorizes WHO may call it" world (every governed call permits) for dev/migration;
 * `posture: "shadow"` evaluates and LOGS would-be denials through the warn seam but never blocks — the
 * migration-safe way to see what enforcement would do before turning it on.
 */
export type AppAuthzConfig = {
	unsafeOpen?: true;
	posture?: "enforce" | "shadow";
};

/**
 * The methods that authorize against NOTHING shared — every route whose declaration is `mode: "caller"`.
 * DERIVED from the one route table rather than listed separately: the old parallel `CORE_API_LEVELS` and
 * `CORE_API_CREATE_METHODS` maps were a second source of truth that could drift from the binding they
 * described, and a level recorded in one place while the resource was declared in another is exactly how
 * a method ends up authorizing against something nobody intended.
 *
 * These still reach Cedar. They are members of the `creates` action group, which the sealed baseline
 * permits for any authenticated principal — but a plugin `forbid` still overrides it, so "authorizes
 * against no shared resource" never means "unreachable by policy".
 */
export const CORE_API_CREATE_METHODS: readonly ClawApiMethod[] =
	clawApiRouteList
		.filter((route) => route.authz.mode === "caller")
		.map((route) => route.apiMethod);

/**
 * Every `mode: "caller"` method across the WHOLE assembled api — core AND plugin namespaces. The engine
 * needs all of them, not just core's: a plugin method that authorizes against nothing shared but is
 * absent from the `creates` group has no permit to match, so it would deny universally. `secrets.set`
 * failed exactly that way when only core's list was passed.
 */
/** One route that authorizes against nothing shared, with the reason it gave. */
export type CallerOnlyRoute = { method: string; reason: string };

/**
 * The BOOT-TIME backstop for the type gate — quickhr's `assertAuthzCoverage`, applied to the assembled
 * api. Walks every callable method and refuses to boot if any lacks an authz declaration, listing the
 * offenders.
 *
 * The types already make omission impossible for anything built the intended way: core's `satisfies`
 * pins a declaration per method, and the route builder will not surrender `.handler()` without one. What
 * this catches is the surface those guarantees do not cover — a plugin contributing a PLAIN OBJECT of
 * functions instead of an `endpoints()` namespace. That is legal (a plain contribution simply is not
 * routable), and every one of its methods would deny at first call. A list at boot is a better way to
 * learn that than a denial in production.
 *
 * Returns the caller-only routes so the assembly can answer the question this whole change started
 * from: which methods authorize against nothing but the caller, and why each one says that is alright.
 */
export function assertAuthzCoverage(api: Record<string, unknown>): {
	callerOnly: CallerOnlyRoute[];
} {
	const declared = collectRouteAuthz(api);
	const undeclared = enumerateApiMethodIds(api).filter(
		(method) => !declared.has(method),
	);
	if (undeclared.length > 0) {
		throw configurationError(
			`${undeclared.length} api method(s) declare no authorization`,
			{
				methods: undeclared.join(", "),
				reason:
					"build plugin api namespaces with `endpoints()` over `route.input(…).authz(…).handler(…)` — a plain object of functions carries no route metadata, so the PEP cannot decide those methods and would deny every call",
			},
		);
	}
	const callerOnly: CallerOnlyRoute[] = [];
	for (const [method, authz] of declared) {
		if (authz.mode === "caller")
			callerOnly.push({ method, reason: authz.reason });
	}
	return {
		callerOnly: callerOnly.sort((a, b) => a.method.localeCompare(b.method)),
	};
}

export function callerOnlyMethodIds(api: Record<string, unknown>): string[] {
	return [...collectRouteAuthz(api)]
		.filter(([, authz]) => authz.mode === "caller")
		.map(([method]) => method);
}

function stringField(input: unknown, key: string): string | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const value = (input as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/** A resource shape nothing satisfies — no owner, no scope, no grants — so owner ∪ scope ∪ grant all
 *  evaluate false and the decision DENIES. The FAIL-CLOSED result for a resource-anchored method whose
 *  row can't be resolved. NEVER "the caller owns it." */
const DENY_SHAPE: ApiResourceShape = { grants: [] };

/** The kinds CORE declares on its own routes. Membership separates "this deployment has no such store"
 *  (a configuration error, since a core route named the kind) from "the caller named a kind nothing
 *  registers" (a denial, since share/unshare take the kind from the input). */
const CORE_RESOURCE_KINDS = new Set([
	"claw",
	"thread",
	"message",
	"toolCall",
	"toolResult",
	"checkpoint",
	"runCheckpoint",
	"providerToolCall",
	"run",
	// Registered only when the claw has an approval store, i.e. a database. Naming it here means a
	// claw without one reports a CONFIGURATION error rather than a denial — the distinction this set
	// exists for, and the more useful answer: reporting a missing database as "denied" sends the
	// reader hunting for a policy that does not exist.
	"approval",
]);

// `personalScope(principal)` lived here: it returned a resource whose `createdBy` WAS the caller, and
// the loader fell back to it whenever a method declared no binding. That is the whole vulnerability in
// one function — the decision then asked Cedar "does the caller own this?" about something defined one
// line earlier as caller-owned. It is deleted rather than left unused: every method now resolves a real
// target or declares `mode: "caller"` out loud, and an unresolvable one yields DENY_SHAPE.

/** What a per-kind loader resolves — the plugin-facing opaque {@link ShareableResource} base, plus the
 *  CORE-only `grantParents`: additional (kind, id) whose grants are UNIONED into this resource's (the
 *  folder/file inheritance a thread has over its claw). Plugin loaders return the plain
 *  `ShareableResource` (no parents); the union is otherwise the resource's OWN (kind, id) only. */
type ResolvedResource = ShareableResource & {
	grantParents?: readonly { kind: string; id: string }[];
};
type ResourceLoader = (id: string) => Promise<ResolvedResource | null>;

/**
 * Build the ONE loader registry the PEP consults — CORE loaders (claw/thread/run, closed over the
 * assembled stores) MERGED with every plugin's `shareable` loaders (store-bound now via the wrapped
 * adapter). A `Map<kind, (id) => base>`: the ONLY per-kind bit (§6). A plugin registering a kind that a
 * core loader or another plugin already owns fails LOUD at boot — a kind is never silently shadowed.
 */
export function buildResourceRegistry(input: {
	clawsStore: ClawsStore | undefined;
	runs: ClawRunReadModel | undefined;
	/** Feeds the `approval` loader — see the registration below. */
	approvals: ApprovalStore | undefined;
	adapter: Adapter | undefined;
	plugins: readonly BusyclawPlugin[];
}): Map<string, ResourceLoader> {
	const registry = new Map<string, ResourceLoader>();
	const { approvals, clawsStore, runs } = input;

	if (clawsStore !== undefined) {
		// claw — the base shared agent resource: its own createdBy/scope/scopeId.
		registry.set("claw", async (id) => {
			const claw = await clawsStore.claws.get(id);
			return claw
				? {
						createdBy: claw.createdBy,
						scope: claw.scope,
						scopeId: claw.scopeId,
					}
				: null;
		});
		// thread — no own owner/scope: resolve clawId → the claw's base, and INHERIT the claw's grants
		// (∪ the thread's own, added by the PEP via `grantParents`). Share a claw → its threads come along.
		registry.set("thread", async (id) => {
			const thread = await clawsStore.threads.get(id);
			if (!thread) return null;
			const claw = await clawsStore.claws.get(thread.clawId);
			if (!claw) return null;
			return {
				createdBy: claw.createdBy,
				scope: claw.scope,
				scopeId: claw.scopeId,
				grantParents: [{ kind: "claw", id: thread.clawId }],
			};
		});
		// Every transcript descendant carries a REQUIRED `clawId`, so each resolves to that claw's
		// owner/scope/grants and inherits its grants — share a claw and its transcript comes along. One
		// helper rather than four copies: the only thing that differs is which store the row comes from,
		// and a divergence between them would be an isolation gap that reads as a typo.
		const ownedByClaw =
			(load: (id: string) => Promise<{ clawId: string } | null>) =>
			async (id: string): Promise<ResolvedResource | null> => {
				const row = await load(id);
				if (!row) return null;
				const claw = await clawsStore.claws.get(row.clawId);
				if (!claw) return null;
				return {
					createdBy: claw.createdBy,
					scope: claw.scope,
					scopeId: claw.scopeId,
					grantParents: [{ kind: "claw", id: row.clawId }],
				};
			};
		// approval — the resource H-02 is about. Two anchors, in order, because an approval has two
		// quite different lives:
		//
		//   1. It belongs to a CLAW. Whoever may manage the claw may review what that claw parked. This
		//      is the case that matters: needs-approval exists FOR autonomous runs, whose requester is a
		//      `system:` principal, and an earlier attempt to anchor on the requester alone made exactly
		//      those approvals unapprovable by any human. The claw is the human-owned thing behind them.
		//   2. Failing that (an ad-hoc `generate` belonging to no claw), the REQUESTER owns it — and an
		//      ad-hoc call has an authenticated caller or it does not run, so that owner is a real user.
		//
		// Absent or unresolvable ⇒ null ⇒ DENY, like every other loader. Deciding an approval is not a
		// question you get to answer by asking about a row nobody can find.
		if (approvals !== undefined) {
			registry.set("approval", async (id) => {
				const record = await approvals.get(id);
				if (!record) return null;
				if (record.clawId !== undefined) {
					const claw = await clawsStore.claws.get(record.clawId);
					if (!claw) return null;
					return {
						createdBy: claw.createdBy,
						scope: claw.scope,
						scopeId: claw.scopeId,
						grantParents: [{ kind: "claw", id: record.clawId }],
					};
				}
				// No claw. The run still belonged to a TENANT, and its members are the humans entitled
				// to decide its work — this is what a cron-triggered one-off has instead of an owner.
				// Deliberately NOT "any authenticated human": in a multi-tenant deployment that is
				// every other tenant's humans too, which is a tenancy breach wearing a convenience.
				if (record.scope !== undefined && record.scopeId !== undefined) {
					return { scope: record.scope, scopeId: record.scopeId };
				}
				// An ad-hoc call by a real person, in a deployment that resolves no tenant: they own it.
				// A `system:` requester here has no parent at all and is DENIED — the correct answer for
				// work that belongs to nobody, and a deployment that wants it decidable resolves a
				// tenant.
				return record.principal !== undefined
					? { createdBy: record.principal }
					: null;
			});
		}
		registry.set(
			"message",
			ownedByClaw((id) => clawsStore.messages.get(id)),
		);
		registry.set(
			"toolCall",
			ownedByClaw((id) => clawsStore.toolCalls.get(id)),
		);
		registry.set(
			"toolResult",
			ownedByClaw((id) => clawsStore.toolResults.get(id)),
		);
		registry.set(
			"checkpoint",
			ownedByClaw((id) => clawsStore.checkpoints.get(id)),
		);
		// A run's LATEST checkpoint, keyed by the run id — the anchor for reads that name a run but live
		// in the claws store, so they work in a deployment with no durable engine. A run with no
		// checkpoint yet resolves to nothing and DENIES, which is also "there is nothing to read".
		registry.set(
			"runCheckpoint",
			ownedByClaw((runId) => clawsStore.checkpoints.latestForRun(runId)),
		);
		// The provider-assigned tool call, keyed by its natural pair. Tool-call ids are unique only
		// within a run, so the id here is the PAIR, joined by a NUL — a byte no id can contain, so the
		// split cannot be ambiguous the way a slash or colon would be.
		registry.set(
			"providerToolCall",
			ownedByClaw(async (composite) => {
				const [runId, toolCallId] = composite.split(
					PROVIDER_TOOL_CALL_SEPARATOR,
				);
				if (runId === undefined || toolCallId === undefined) return null;
				return clawsStore.toolCalls.getByToolCallId({ runId, toolCallId });
			}),
		);
	}
	if (runs !== undefined) {
		// run — createdBy is the durable run's principal (scope personal to that principal). An absent
		// run OR an absent/blank run principal → null (DENY): a principal-less run has no owner to isolate.
		registry.set("run", async (id) => {
			const run = await runs.get(id);
			if (!run) return null;
			const principal = run.principal;
			if (principal === undefined || principal.trim() === "") return null;
			return { createdBy: principal, scope: "personal", scopeId: principal };
		});
	}

	// PLUGIN loaders — store-bound against the SAME entity-validating adapter `configure` gets, so a
	// plugin builds its store the same way in both places. Read STATICALLY off the raw plugin object.
	const loaderContext: ShareableLoaderContext = { adapter: input.adapter };
	for (const plugin of input.plugins) {
		for (const shareable of plugin.shareable ?? []) {
			if (registry.has(shareable.kind)) {
				throw configurationError(
					`a shareable kind is already registered: ${shareable.kind}`,
					{
						kind: shareable.kind,
						plugin: plugin.id,
						reason:
							"two loaders claim the same resource kind; kinds must be unique (a plugin cannot shadow a core or another plugin's kind)",
					},
				);
			}
			registry.set(shareable.kind, shareable.load(loaderContext));
		}
	}
	return registry;
}

/**
 * Collect the declared {@link RouteAuthz} of EVERY governed method, keyed by the dotted method id the PEP
 * wraps — core flat methods off their own route defs (`clawApiRouteList`), plugin methods off the route
 * table `endpoints()` re-attaches. Every method has one: core's `satisfies` and the route builder's type
 * gate each make omission a compile error, and this map is the PEP's whole view of what a method
 * authorizes against. A method missing from it is one the PEP cannot decide, so it DENIES rather than
 * guessing — which is precisely the state the old optional binding turned into "the caller owns it".
 */
function collectRouteAuthz(
	api: Record<string, unknown>,
): Map<string, RouteAuthz> {
	const declared = new Map<string, RouteAuthz>();
	for (const route of clawApiRouteList) {
		declared.set(route.apiMethod, route.authz);
	}
	// Methods that are governed but not wire-routed (`stream`). Kept in the same map so the PEP has ONE
	// view of what every method authorizes against, routed or not.
	for (const [method, authz] of Object.entries(NON_ROUTED_API_AUTHZ)) {
		declared.set(method, authz as RouteAuthz);
	}
	const visit = (ns: Record<string, unknown>, prefix: string): void => {
		for (const route of endpointRoutesOf(ns) ?? []) {
			// A route `name` is relative to its namespace mount, so it prefixes.
			const id = prefix ? `${prefix}.${route.name}` : route.name;
			declared.set(id, route.authz);
		}
		for (const [key, value] of Object.entries(ns)) {
			if (value !== null && typeof value === "object") {
				visit(
					value as Record<string, unknown>,
					prefix ? `${prefix}.${key}` : key,
				);
			}
		}
	};
	visit(api, "");
	return declared;
}

/**
 * Build the ONE resource-shape loader for the governed api — over the loader registry + the co-located
 * `bindings` + the grant store. A method with NO binding acts within the caller's own personal scope
 * (`personalScope`). A bound method loads its base row via the registry, then UNIONS its grants
 * (`access_grant WHERE (kind, id)` ∪ any `grantParents`) into the shape the generic decision reads.
 * FAIL-CLOSED throughout: an unresolvable row (no id, absent, or — for a DYNAMIC kind — an unregistered
 * kind) → `DENY_SHAPE`, never "the caller owns it". A STATIC-kind method whose kind has no registered
 * loader is a deployment WITHOUT that store (no DB / no engine) — NOT an access denial: it falls to
 * `personalScope` so the method's own clear config error surfaces (masking it behind a deny is worse).
 * The grant RENDERING already exists (slice 1's entity graph); this just FEEDS it real grants.
 */
function resourceLoaderFor(input: {
	registry: Map<string, ResourceLoader>;
	grantStore: AccessGrantStore | undefined;
}): (target: AuthzTarget) => Promise<ApiResourceShape> {
	const { registry, grantStore } = input;

	const loadShape = async (
		kind: string,
		id: string,
	): Promise<ApiResourceShape> => {
		const loader = registry.get(kind);
		if (loader === undefined) {
			// A CORE kind with no loader is a deployment-shape problem, not an access question: this claw
			// was built without the store that owns those rows, so the PEP cannot answer rather than
			// answering no. Both refuse the call — only one says something true about why, and reporting a
			// missing database as "denied" sends the reader hunting for a policy that does not exist.
			if (CORE_RESOURCE_KINDS.has(kind)) {
				throw configurationError(
					`this deployment cannot authorize "${kind}" resources`,
					{
						kind,
						reason:
							"the store that owns this resource kind is not configured — pass a database/engine to createClaw",
					},
				);
			}
			// An UNREGISTERED kind came from the CALLER (share/unshare take the target kind from the input).
			// That is an access question and the answer is no — naming which kinds exist would make it a probe.
			return DENY_SHAPE;
		}
		const base = await loader(id);
		if (base === null) return DENY_SHAPE;
		// Grants are DATA: the resource's OWN (kind, id) grants ∪ any inherited parents'. Empty when no
		// grant store is configured (grant enforcement needs a DB; owner/scope still decide without it).
		const grantKeys = [{ kind, id }, ...(base.grantParents ?? [])];
		const grants = grantStore
			? (
					await Promise.all(
						grantKeys.map((key) =>
							grantStore.listForResource(key.kind, key.id),
						),
					)
				).flat()
			: [];
		return {
			createdBy: base.createdBy,
			scope: base.scope,
			scopeId: base.scopeId,
			grants,
		};
	};

	// The shape for a target a ROUTE resolved. Two cases, and neither can degrade into "the caller owns
	// it": a `{kind,id}` loads the row (absent → DENY_SHAPE), and a `{scope,scopeId}` renders the boundary
	// with NO `createdBy`, so the owner rule is structurally false and only verified scope membership —
	// resolved out of band, never from the request — can permit.
	const byTarget = async (target: AuthzTarget): Promise<ApiResourceShape> =>
		"kind" in target
			? loadShape(target.kind, target.id)
			: { scope: target.scope, scopeId: target.scopeId, grants: [] };

	return byTarget;
}

/**
 * Build the internal Cedar engine for the product-api PEP (`decideApiCall`'s engine). Split from the
 * tool floor's engine BY DESIGN: unifying them would mean reshaping the already-built floor gate
 * (out of scope), and the Cedar action NAMESPACE gives full isolation regardless — a `ClawApi::` policy
 * cannot reach a `Tool::` request. The bundle's un-removable system floor is the generic
 * `API_ACCESS_BASELINE` (the api's sealed floor — the TOOL floor's SYSTEM_POSTURE is a different, agent
 * surface and is not merged here); every plugin's `policies` slices merge UNDER it, namespace-routed
 * (a plugin `ClawApi::` slice governs here; a `Tool::` slice is inert here and governs in the floor
 * engine). `methodIds` are every governed action (core + plugin dotted) so each sits under the `"api"`
 * umbrella the baseline permits target.
 */
export function buildApiPolicyEngine(input: {
	methodIds: readonly string[];
	createMethodIds: readonly string[];
	plugins: readonly BusyclawPlugin[];
}): CedarEngine {
	const slices: PolicySourceSlice[] = input.plugins.flatMap(
		(plugin) => plugin.policies ?? [],
	);
	const bundle = loadPolicyBundle({
		system: API_ACCESS_BASELINE,
		slices,
	});
	return cedarApiEngine({
		policies: bundle.live,
		methods: input.methodIds,
		createMethods: input.createMethodIds,
	});
}

/** Every callable path in the assembled api as a dotted id — flat core methods and nested plugin
 *  methods (`secrets.set`). Feeds the engine's action hierarchy so every governed method is a modeled
 *  `ClawApi::Action`. Non-function leaves and the endpoints() metadata symbol are skipped. */
export function enumerateApiMethodIds(
	api: Record<string, unknown>,
	prefix = "",
): string[] {
	const ids: string[] = [];
	for (const [key, value] of Object.entries(api)) {
		const id = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "function") ids.push(id);
		else if (value !== null && typeof value === "object") {
			ids.push(...enumerateApiMethodIds(value as Record<string, unknown>, id));
		}
	}
	return ids;
}

/**
 * Wrap the whole assembled api with the PEP. Recurses into plugin namespaces; each governed method
 * becomes `(input, caller?) => …` that runs `decideApiCall` first, then the original method (with the
 * caller passed through, so `run`/`continueRun`/plugin methods that need the principal read it). A
 * method's LEVEL comes from `CORE_API_LEVELS` (plugin/undeclared methods default to `manage`, satisfied
 * by the self-shape owner); its resource from the loader (claw/thread rows, else the caller's own
 * scope). Postures: `unsafeOpen` bypasses; `shadow` logs a would-be denial and proceeds; else enforce.
 */
export function governApi(input: {
	api: Record<string, unknown>;
	engine: CedarEngine;
	clawsStore: ClawsStore | undefined;
	/** The durable run read model (from the engine) — feeds the `run` core loader (owner-isolation by
	 *  the run's principal). `undefined` when no engine is configured; getRun/listRunEvents then fall to
	 *  the method's own "requires a run read model" config error (via personalScope), not an authz deny. */
	runs: ClawRunReadModel | undefined;
	/** The durable approval store — feeds the `approval` loader. An approval anchors on the CLAW whose
	 *  run parked it, falling back to the tenant it ran in. */
	approvals: ApprovalStore | undefined;
	/** The generic ACL store — feeds real grants into the decision (slice 5). `undefined` → grants are
	 *  `[]` (owner/scope still decide). */
	grantStore: AccessGrantStore | undefined;
	/** The entity-validating adapter (the one `configure` gets) — store-binds every plugin `shareable`
	 *  loader. `undefined` on a no-database claw. */
	adapter: Adapter | undefined;
	/** The full plugin list — its `shareable` kinds merge into the loader registry (plugin-extensible). */
	plugins: readonly BusyclawPlugin[];
	/** Which SCOPES the caller belongs to, and at what level — the caller-side mirror of the `(scope,
	 *  scopeId)` a resource carries. The PEP renders each into an `in` edge, then Cedar decides; the pair
	 *  is OPAQUE here exactly as it is on a resource, so this stays kind-blind (no `team:`/`organization:`
	 *  branch anywhere — `grantReaches` compares `<scope>:<scopeId>` as a string). A plugin that knows what
	 *  a group MEANS supplies it; `organization()` is the first. Absent ⇒ `[]`, so the scope-member and
	 *  labelled-grant routes are dormant and only owner / `user:` / `public` decide.
	 *
	 *  A RESOLVER, never a field on the caller: scopes arriving in the caller object would be
	 *  caller-supplied and therefore forgeable — the class of bug docs/plans/stamped-fields.md closed. */
	resolvePrincipalScopes?: (
		principal: string,
	) => readonly PrincipalScope[] | Promise<readonly PrincipalScope[]>;
	appAuthz: AppAuthzConfig | undefined;
	warn: (message: string) => void;
}): Record<string, unknown> {
	const registry = buildResourceRegistry({
		approvals: input.approvals,
		clawsStore: input.clawsStore,
		runs: input.runs,
		adapter: input.adapter,
		plugins: input.plugins,
	});
	// What each ROUTE-built method declared via `.authz(...)`. Present ⇒ the route path below; absent ⇒
	// a core method still on the legacy binding table.
	const routeAuthz = collectRouteAuthz(input.api);
	const loadResource = resourceLoaderFor({
		registry,
		grantStore: input.grantStore,
	});
	const hostScopes = input.resolvePrincipalScopes ?? (() => []);
	// The host's resolver is the one place membership enters the decision, so it is a trust boundary
	// even though the host is trusted code. Core reserves the `busyclaw:` scope prefix for containers it
	// mints to stand in for the ABSENCE of a boundary — a resolver returning one would be claiming
	// membership of "belongs to nothing", turning the sentinel into a skeleton key over every row that
	// carries it. Drop it and say so: a host emitting a reserved scope has a bug, and silently honouring
	// it would be the worst way to find out.
	const resolvePrincipalScopes = async (
		principal: string,
	): Promise<readonly PrincipalScope[]> => {
		const scopes = await hostScopes(principal);
		const allowed = scopes.filter((scope) => !isReservedScope(scope.scope));
		if (allowed.length !== scopes.length) {
			input.warn(
				`busyclaw app-authz: resolvePrincipalScopes returned ${scopes.length - allowed.length} reserved "${RESERVED_SCOPE_PREFIX}" scope(s) for ${principal} — ignored (core reserves that prefix; membership of it is never resolvable)`,
			);
		}
		return allowed;
	};
	const unsafeOpen = input.appAuthz?.unsafeOpen === true;
	const shadow = input.appAuthz?.posture === "shadow";

	/** Run one decision and convert a non-permit into the typed error (or a shadow warning). */
	const enforce = async (spec: {
		method: string;
		level: ApiPermissionLevel;
		principal: string;
		resource: ApiResourceShape;
	}): Promise<void> => {
		const result = await decideApiCall({
			engine: input.engine,
			method: spec.method,
			level: spec.level,
			principal: spec.principal,
			resource: spec.resource,
			scopes: await resolvePrincipalScopes(spec.principal),
		});
		if (result.decision === "permit") return;
		const message = `app-authz denied ${spec.method}: ${result.reason ?? "no policy permits this call"}`;
		if (shadow) {
			input.warn(`busyclaw app-authz shadow: would deny — ${message}`);
			return;
		}
		throw authorizationError(message, {
			method: spec.method,
			decision: result.decision,
		});
	};

	/**
	 * The ACTOR FLOOR, run before any handler is entered. Every route path guarantees its handler a
	 * present, non-blank principal, which is why {@link AuthzContext.principal} is a plain string and no
	 * handler re-derives it. `decideApiCall` enforces the same floor for the legacy path.
	 */
	const requirePrincipal = (
		method: string,
		caller: ClawApiCaller | undefined,
	): string => {
		const principal = caller?.principal;
		if (principal === undefined || principal.trim() === "") {
			throw authorizationError(
				`app-authz denied ${method}: requires a caller principal (actor floor)`,
				{ method, decision: "deny" },
			);
		}
		return principal;
	};

	const wrapMethod = (
		method: string,
		fn: (...args: unknown[]) => unknown,
	): ((...args: unknown[]) => unknown) => {
		const declared = routeAuthz.get(method);
		return async (...args: unknown[]) => {
			// The caller rides at index 1, beside the single domain input at index 0.
			const caller = (args[1] ?? undefined) as ClawApiCaller | undefined;
			const domainInput = args[0];
			if (unsafeOpen) {
				// Still hand over a USABLE principal: handlers stamp `createdBy`/`updatedBy` from it, and a
				// blank string is not a well-formed principal — it would fail the entity boundary rather
				// than reproduce the pre-PEP behaviour this hatch exists to restore.
				return fn(domainInput, {
					caller: caller ?? {},
					principal: caller?.principal ?? SYSTEM_ANONYMOUS,
					check: async () => {},
				} satisfies AuthzContext);
			}
			// A method with no declaration is one the PEP cannot decide. That cannot happen through the
			// types — core's `satisfies` and the route builder's gate both refuse it — so reaching here
			// means the api was assembled some other way, and the only safe answer is no.
			if (declared === undefined) {
				throw authorizationError(
					`app-authz denied ${method}: no authz declaration — the method cannot be decided`,
					{ method, decision: "deny" },
				);
			}
			const principal = requirePrincipal(method, caller);

			if (declared.mode === "resource") {
				// A resolver that throws must DENY, not escape as an unrelated failure a caller could
				// mistake for a permitted call that merely errored.
				let target: AuthzTarget;
				try {
					target = await declared.resolve(domainInput as never);
				} catch (error) {
					throw authorizationError(
						`app-authz denied ${method}: could not resolve the resource to authorize against`,
						{ method, decision: "deny", reason: errorMessage(error) },
					);
				}
				await enforce({
					method,
					level: declared.level,
					principal,
					resource: await loadResource(target),
				});
			} else {
				// `mode: "caller"` still goes to Cedar, with the create shape (no owner, no scope, no
				// grants). The method belongs to the `creates` action group, which the sealed baseline
				// permits for any authenticated principal — so the normal answer is yes, but a plugin
				// `forbid` still overrides. Skipping the decision here would have made these methods
				// unreachable by policy, which is a different and quieter kind of hole.
				await enforce({
					method,
					level: "manage",
					principal,
					resource: { grants: [] },
				});
			}

			// The handler's SECOND parameter is the authz context, not the raw caller: a check that only
			// becomes expressible after loading something needs no extra plumbing, and `principal` is
			// already guaranteed present so no handler re-derives the actor floor.
			return fn(domainInput, {
				caller: caller ?? {},
				principal,
				check: async (level, target, asMethod) =>
					enforce({
						method: asMethod ?? method,
						level,
						principal,
						resource: await loadResource(target),
					}),
			} satisfies AuthzContext);
		};
	};

	// ORIGINAL plugin-endpoint handler → its wrapped (governed) form, keyed by function IDENTITY.
	// `endpoints()` makes a namespace method and its route-table entry the SAME function object
	// (contracts/governance/endpoints.ts: `namespace[name] = value.handler` and the route carries that
	// same `value.handler`), so a route's raw handler is exactly the fn we wrap below. Rebuilding the
	// re-attached table through this map points the HTTP ingress at the GOVERNED method — one door, no
	// raw bypass. Shared across the whole recursion, so a nested route resolves regardless of depth.
	const governedByOriginal = new Map<unknown, unknown>();

	const wrapNamespace = (
		ns: Record<string, unknown>,
		prefix: string,
	): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(ns)) {
			const id = prefix ? `${prefix}.${key}` : key;
			if (typeof value === "function") {
				const wrapped = wrapMethod(
					id,
					value as (...args: unknown[]) => unknown,
				);
				governedByOriginal.set(value, wrapped);
				out[key] = wrapped;
			} else if (value !== null && typeof value === "object") {
				out[key] = wrapNamespace(value as Record<string, unknown>, id);
			} else {
				out[key] = value;
			}
		}
		// An `endpoints()` namespace parks its route table under a non-enumerable symbol that
		// `Object.entries` skips — re-attach it so the wrapped namespace stays HTTP-routable. Each
		// route's handler is remapped to its GOVERNED twin (same fn identity the namespace now exposes),
		// so the HTTP ingress dispatches THROUGH the PEP — identical to the in-process call. A handler
		// with no wrapped twin (shouldn't happen) falls back to the original, never silently dropped.
		const routes = (ns as { [ENDPOINTS_METADATA]?: readonly EndpointRoute[] })[
			ENDPOINTS_METADATA
		];
		if (routes !== undefined) {
			const governedRoutes = routes.map((route) => {
				const governed = governedByOriginal.get(route.handler);
				return governed !== undefined
					? { ...route, handler: governed as EndpointRoute["handler"] }
					: route;
			});
			Object.defineProperty(out, ENDPOINTS_METADATA, { value: governedRoutes });
		}
		return out;
	};

	return wrapNamespace(input.api, "");
}
