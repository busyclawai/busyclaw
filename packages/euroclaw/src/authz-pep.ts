// The product-API PEP — the api-side analog of the always-on governance FLOOR (authz-floor.ts). Where
// the floor gates AGENT tool calls (`Tool::`), this gates PRODUCT-API calls (`ClawApi::`): one wrapper
// over the WHOLE assembled `claw.api` (core methods AND plugin namespaces alike), each governed method
// routed through `decideApiCall` before it executes. Deny → a typed `authorizationError` (fail-loud,
// like the tool gate). Always-on (governed by default); the escape hatches are explicit and shame-named.
//
// THE MODEL IS GENERIC (docs/plans/app-authz.md §6): the PEP never learns "admin"/"self-service" tiers
// or what "organization" means. It loads an OPAQUE resource SHAPE and checks owner ∪ scope-member ∪
// grant at the action's required LEVEL (read < use < manage). The (scope,scopeId)/grant matching is
// generic and kind-blind; the level decision is Cedar's. See @euroclaw/authz `decideApiCall`.

import {
	API_ACCESS_BASELINE,
	type ApiMembership,
	type ApiPermissionLevel,
	type ApiResourceShape,
	type CedarEngine,
	cedarApiEngine,
	decideApiCall,
	loadPolicyBundle,
} from "@euroclaw/authz";
import {
	type AccessGrantStore,
	type Adapter,
	authorizationError,
	type ClawRunReadModel,
	type ClawsStore,
	configurationError,
	ENDPOINTS_METADATA,
	type EuroclawPlugin,
	endpointRoutesOf,
	type LooseResourceBinding,
	type PolicySourceSlice,
	type ShareableLoaderContext,
	type ShareableResource,
} from "@euroclaw/contracts";
import {
	type ClawApiCaller,
	type ClawApiMethod,
	clawApiRouteList,
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
 * The per-method required LEVEL — the ONE non-derivable per-method fact. A FULL record over every
 * `ClawApi` method (a missing OR mistyped key fails to compile — `satisfies` pins it), so adding an api
 * method forces an intentional level, never a silent `manage` default. `read` sees, `use` runs/invokes,
 * `manage` mutates/administers. The owner has max level implicitly; the level bites a NON-owner caller
 * whose scope/grant level is compared against it.
 */
export const CORE_API_LEVELS = {
	bindConversation: "manage",
	createClaw: "manage",
	getClaw: "read",
	updateClaw: "manage",
	archiveClaw: "manage",
	createThread: "use",
	getThread: "read",
	listThreads: "read",
	archiveThread: "manage",
	appendMessage: "use",
	getMessage: "read",
	listMessages: "read",
	sendMessage: "use",
	forgetSubject: "manage",
	createToolCall: "use",
	getToolCall: "read",
	getToolCallByProviderId: "read",
	updateToolCallStatus: "use",
	createToolResult: "use",
	getToolResult: "read",
	listToolResults: "read",
	createCheckpoint: "use",
	getCheckpoint: "read",
	getLatestCheckpoint: "read",
	run: "use",
	continueRun: "use",
	grantApproval: "manage",
	denyApproval: "manage",
	getApproval: "read",
	listApprovals: "read",
	getEffect: "read",
	registerOpenApiSpec: "manage",
	listRegisteredTools: "read",
	listActions: "read",
	putPolicySlice: "manage",
	listPolicySlices: "read",
	deletePolicySlice: "manage",
	startRun: "use",
	continueEngineRun: "use",
	getRun: "read",
	listRunEvents: "read",
	// The generic share/unshare api (slice 5) — LEVEL manage, so the PEP requires the caller MANAGE the
	// TARGET resource before a grant can be written: you can only share what you manage.
	shareResource: "manage",
	unshareResource: "manage",
} satisfies Record<ClawApiMethod, ApiPermissionLevel>;

/** The TRUE creates — any authenticated principal may perform them, and the created row's owner becomes
 *  the caller (createClaw) or a system principal (bindConversation binds a stranger's conversation). */
export const CORE_API_CREATE_METHODS: readonly ClawApiMethod[] = [
	"createClaw",
	"bindConversation",
];

// Which resource a governed method acts on — the STATIC (kind, input[idKey]) and DYNAMIC
// (input[kindKey], input[idKey]) bindings — is no longer a central map here. It is CO-LOCATED and
// type-checked on each method's OWN def: core methods on their `clawApiRoutes[method].resource` (see
// api.ts), plugin methods on their `endpoints()` def `resource` (carried into the route metadata). The
// loader below reads those declarations via `collectResourceBindings`. A method with NO binding is not
// resource-anchored — it acts within the caller's personal scope (`personalScope`).

const CREATE_SET = new Set<string>(CORE_API_CREATE_METHODS);
const LEVELS = CORE_API_LEVELS as Record<string, ApiPermissionLevel>;

function stringField(input: unknown, key: string): string | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const value = (input as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/** A resource shape nothing satisfies — no owner, no scope, no grants — so owner ∪ scope ∪ grant all
 *  evaluate false and the decision DENIES. The FAIL-CLOSED result for a resource-anchored method whose
 *  row can't be resolved. NEVER "the caller owns it." */
const DENY_SHAPE: ApiResourceShape = { grants: [] };

/** The caller's own PERSONAL scope — the honest shape for a method NOT anchored to a specific shared row
 *  (secrets, policy slices, the caller's own runs …): the row such a method touches is keyed by the
 *  caller, so `createdBy == caller` is the TRUTH here, not a not-found fallback. An absent principal gets
 *  the deny shape (the actor floor already denied it upstream). */
function personalScope(principal: string | undefined): ApiResourceShape {
	return principal !== undefined
		? {
				createdBy: principal,
				scope: "personal",
				scopeId: principal,
				grants: [],
			}
		: DENY_SHAPE;
}

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
	adapter: Adapter | undefined;
	plugins: readonly EuroclawPlugin[];
}): Map<string, ResourceLoader> {
	const registry = new Map<string, ResourceLoader>();
	const { clawsStore, runs } = input;

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
 * Collect the CO-LOCATED resource bindings across the whole assembled api into one lookup, keyed by the
 * dotted method id the PEP wraps. Core flat methods carry their binding on their own route def
 * (`clawApiRouteList`); plugin methods carry theirs on their `endpoints()` def, re-attached under
 * `ENDPOINTS_METADATA` and read via `endpointRoutesOf` (a route `name` is relative to its namespace
 * mount, so it prefixes). This READS the declarations each method owns — it is the plugin-extensible
 * analog of the loader registry, not a second parallel source of truth like the old central maps.
 */
function collectResourceBindings(
	api: Record<string, unknown>,
): Map<string, LooseResourceBinding> {
	const bindings = new Map<string, LooseResourceBinding>();
	for (const route of clawApiRouteList) {
		if (route.resource !== undefined) {
			bindings.set(route.apiMethod, route.resource);
		}
	}
	const visit = (ns: Record<string, unknown>, prefix: string): void => {
		for (const route of endpointRoutesOf(ns) ?? []) {
			if (route.resource !== undefined) {
				const id = prefix ? `${prefix}.${route.name}` : route.name;
				bindings.set(id, route.resource);
			}
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
	return bindings;
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
	bindings: Map<string, LooseResourceBinding>;
	grantStore: AccessGrantStore | undefined;
}): (
	method: string,
	methodInput: unknown,
	principal: string | undefined,
) => Promise<ApiResourceShape> {
	const { registry, bindings, grantStore } = input;

	const loadShape = async (
		kind: string,
		id: string,
	): Promise<ApiResourceShape> => {
		const loader = registry.get(kind);
		if (loader === undefined) return DENY_SHAPE;
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

	return async (method, methodInput, principal) => {
		const binding = bindings.get(method);
		// No binding — the method is not resource-anchored: the caller's own personal scope.
		if (binding === undefined) return personalScope(principal);
		// DYNAMIC-kind methods (share/unshare): the target kind + id BOTH come from the INPUT. An
		// unregistered kind or a missing field fails CLOSED (you can't (un)share what does not resolve).
		if (!("kind" in binding)) {
			const kind = stringField(methodInput, binding.kindKey);
			const id = stringField(methodInput, binding.idKey);
			if (kind === undefined || id === undefined) return DENY_SHAPE;
			return loadShape(kind, id);
		}
		// STATIC-kind methods: fixed kind, id from the input. A known kind with no registered loader = a
		// deployment WITHOUT that store (no DB / no engine): NOT an access denial — fall to personalScope
		// so the method's own config error surfaces (slice-1's behavior).
		if (registry.get(binding.kind) === undefined) {
			return personalScope(principal);
		}
		const id = stringField(methodInput, binding.idKey);
		if (id === undefined) return DENY_SHAPE;
		return loadShape(binding.kind, id);
	};
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
	plugins: readonly EuroclawPlugin[];
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
	/** The generic ACL store — feeds real grants into the decision (slice 5). `undefined` → grants are
	 *  `[]` (owner/scope still decide). */
	grantStore: AccessGrantStore | undefined;
	/** The entity-validating adapter (the one `configure` gets) — store-binds every plugin `shareable`
	 *  loader. `undefined` on a no-database claw. */
	adapter: Adapter | undefined;
	/** The full plugin list — its `shareable` kinds merge into the loader registry (plugin-extensible). */
	plugins: readonly EuroclawPlugin[];
	resolveMemberships?: (
		principal: string,
	) => readonly ApiMembership[] | Promise<readonly ApiMembership[]>;
	appAuthz: AppAuthzConfig | undefined;
	warn: (message: string) => void;
}): Record<string, unknown> {
	const registry = buildResourceRegistry({
		clawsStore: input.clawsStore,
		runs: input.runs,
		adapter: input.adapter,
		plugins: input.plugins,
	});
	// The co-located bindings — read off each method's own def (core route defs + plugin endpoints defs).
	const bindings = collectResourceBindings(input.api);
	const loadResource = resourceLoaderFor({
		registry,
		bindings,
		grantStore: input.grantStore,
	});
	const resolveMemberships = input.resolveMemberships ?? (() => []);
	const unsafeOpen = input.appAuthz?.unsafeOpen === true;
	const shadow = input.appAuthz?.posture === "shadow";

	const wrapMethod = (
		method: string,
		fn: (...args: unknown[]) => unknown,
	): ((...args: unknown[]) => unknown) => {
		return async (...args: unknown[]) => {
			// The caller rides at index 1 (beside the single domain input at index 0) — the WithCaller
			// contract. Missing → the actor floor denies. All args pass through to the method, so a
			// plugin handler that needs the caller (e.g. secretStore) reads it at index 1.
			const caller = (args[1] ?? undefined) as ClawApiCaller | undefined;
			const principal = caller?.principal;
			const call = () => fn(...args);
			if (unsafeOpen) return call();
			const level = LEVELS[method] ?? "manage";
			const isCreate = CREATE_SET.has(method);
			const resource = isCreate
				? { grants: [] }
				: await loadResource(method, args[0], principal);
			const memberships =
				principal !== undefined ? await resolveMemberships(principal) : [];
			const result = await decideApiCall({
				engine: input.engine,
				method,
				level,
				principal,
				resource,
				memberships,
			});
			if (result.decision === "permit") return call();
			const message = `app-authz denied ${method}: ${result.reason ?? "no policy permits this call"}`;
			if (shadow) {
				input.warn(`euroclaw app-authz shadow: would deny — ${message}`);
				return call();
			}
			throw authorizationError(message, { method, decision: result.decision });
		};
	};

	const wrapNamespace = (
		ns: Record<string, unknown>,
		prefix: string,
	): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(ns)) {
			const id = prefix ? `${prefix}.${key}` : key;
			if (typeof value === "function") {
				out[key] = wrapMethod(id, value as (...args: unknown[]) => unknown);
			} else if (value !== null && typeof value === "object") {
				out[key] = wrapNamespace(value as Record<string, unknown>, id);
			} else {
				out[key] = value;
			}
		}
		// An `endpoints()` namespace parks its route table under a non-enumerable symbol that
		// `Object.entries` skips — re-attach it so the wrapped namespace stays HTTP-routable. The
		// carried route handlers are the RAW (unwrapped) ones by design: the HTTP adapter is a distinct
		// ingress that resolves its own caller (the adapter-ingress frontier); the wrapper governs the
		// IN-PROCESS `claw.api` surface.
		const routes = (ns as { [ENDPOINTS_METADATA]?: unknown })[
			ENDPOINTS_METADATA
		];
		if (routes !== undefined) {
			Object.defineProperty(out, ENDPOINTS_METADATA, { value: routes });
		}
		return out;
	};

	return wrapNamespace(input.api, "");
}
