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
	authorizationError,
	type ClawsStore,
	ENDPOINTS_METADATA,
	type EuroclawPlugin,
	type PolicySourceSlice,
} from "@euroclaw/contracts";
import type { ClawApiCaller, ClawApiMethod } from "./api";

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
} satisfies Record<ClawApiMethod, ApiPermissionLevel>;

/** The TRUE creates — any authenticated principal may perform them, and the created row's owner becomes
 *  the caller (createClaw) or a system principal (bindConversation binds a stranger's conversation). */
export const CORE_API_CREATE_METHODS: readonly ClawApiMethod[] = [
	"createClaw",
	"bindConversation",
];

/** How the PEP loads the acting resource for a core method — the MINIMAL slice-1 mapper (§6's generic
 *  loader registry is slice 5). Only claw/thread-anchored methods load the real row (cross-user
 *  isolation); every other method acts on the caller's own "personal" scope (self-shape, below). */
type ResourceKind = "claw:id" | "claw:clawId" | "thread:id" | "thread:threadId";

const CORE_API_RESOURCES: Partial<Record<ClawApiMethod, ResourceKind>> = {
	getClaw: "claw:id",
	updateClaw: "claw:id",
	archiveClaw: "claw:id",
	getThread: "thread:id",
	archiveThread: "thread:id",
	listThreads: "claw:clawId",
	createThread: "claw:clawId",
	appendMessage: "claw:clawId",
	sendMessage: "claw:clawId",
	listMessages: "thread:threadId",
};

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
		? { createdBy: principal, scope: "personal", scopeId: principal, grants: [] }
		: DENY_SHAPE;
}

/**
 * Build the ONE resource-shape loader for the governed api — closed over the claws store. A method NOT
 * in `CORE_API_RESOURCES` is not anchored to a specific shared row: it acts within the caller's own
 * personal scope (`personalScope`). A resource-anchored claw/thread method MUST load the real row (its
 * `createdBy`/`scope`/`scopeId` → cross-user isolation); an unresolvable row (no store, no id, or absent)
 * FAILS CLOSED to `DENY_SHAPE` — it is NEVER treated as owned by the caller (the self-shape tautology the
 * old loader fell into, which would let a stranger read/mutate a not-found resource). `grants` is always
 * empty (the access_grant table is a later slice — the generic grant POLICY reads it, the DATA arrives
 * later).
 */
function resourceLoaderFor(
	clawsStore: ClawsStore | undefined,
): (
	method: string,
	input: unknown,
	principal: string | undefined,
) => Promise<ApiResourceShape> {
	return async (method, input, principal) => {
		const kind = CORE_API_RESOURCES[method as ClawApiMethod];
		// Not resource-anchored → the caller's own personal scope (NOT a specific shared resource).
		if (kind === undefined) return personalScope(principal);
		// No claws store configured AT ALL → a boot MISCONFIGURATION, not an access denial: there is no
		// persisted resource to protect, and the method itself surfaces a clear `requires a ClawsStore`
		// config error. Fall through to the caller's personal scope so that error is what the caller sees
		// (masking it behind an authz deny would be worse). This is NOT the killed tautology — that was
		// "a store EXISTS but the row is absent ⇒ caller owns it", handled fail-closed below.
		if (clawsStore === undefined) return personalScope(principal);

		let clawId: string | undefined;
		if (kind === "claw:id") clawId = stringField(input, "id");
		else if (kind === "claw:clawId") clawId = stringField(input, "clawId");
		else {
			const threadId =
				kind === "thread:id"
					? stringField(input, "id")
					: stringField(input, "threadId");
			const thread = threadId
				? await clawsStore.threads.get(threadId)
				: undefined;
			clawId = thread?.clawId;
		}
		const claw = clawId ? await clawsStore.claws.get(clawId) : undefined;
		if (!claw) return DENY_SHAPE;
		return {
			createdBy: claw.createdBy,
			scope: claw.scope,
			scopeId: claw.scopeId,
			grants: [],
		};
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
	resolveMemberships?: (
		principal: string,
	) => readonly ApiMembership[] | Promise<readonly ApiMembership[]>;
	appAuthz: AppAuthzConfig | undefined;
	warn: (message: string) => void;
}): Record<string, unknown> {
	const loadResource = resourceLoaderFor(input.clawsStore);
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
