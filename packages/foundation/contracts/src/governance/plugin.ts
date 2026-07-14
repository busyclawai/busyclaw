/**
 * Portions of this file are adapted from Better Auth
 * (https://github.com/better-auth/better-auth), Copyright (c) 2024 - present,
 * Bereket Engida, licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 * Copyright (c) 2026 Konstantin Ponomarev.
 *
 * Adapted (patterns/API, not verbatim): the plugin-as-data-object shape with phantom
 * type carriers, and the tuple-fold that intersects a field across all plugins (cf.
 * `InferPluginFieldFromTuple` / `InferPluginTypes`). Reason-code catalog helpers live in
 * `reason-codes.ts`.
 */

// Plugins contribute gates at RUNTIME and named info at COMPILE TIME. The fold below
// is the better-auth pattern: capture the config generically with
// `createGovernance<const Config>` and intersect a chosen field from every plugin.
//   $Infer        — phantom types the plugin introduces        → ec.$Infer        (types only)
//   $InferContext — context fields the plugin makes available  → typed on ctx     (types only)
//   $REASON_CODES — reason code → message catalog              → ec.$REASON_CODES (types AND runtime)
// See docs/research/better-auth/design-lessons-for-euroclaw.md.

import type { ClawsStore } from "../claws/contracts";
import type { EffectStore } from "../effects";
import type { EntityField } from "../entity";
import type { EventSink } from "../events";
import type { Adapter } from "../storage";
import type {
	SecretDeclaration,
	SecretProvider,
	Secrets,
} from "../tools/secrets";
import type { AfterGate, BoundaryGate, Gate } from "./boundary";
import type { ReasonCode } from "./reason-codes";

export type EuroclawHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export type EuroclawRouteRequest = {
	method: string;
	url: string;
	headers: { get: (name: string) => string | null };
	json: () => Promise<unknown>;
	text: () => Promise<string>;
};

export type EuroclawRouteResult = {
	body?: unknown;
	headers?: Record<string, string>;
	status?: number;
};

export type EuroclawRouteContext<ClawLike = unknown> = {
	request: EuroclawRouteRequest;
	claw: ClawLike;
	params: Record<string, string>;
	/** The one-door secret reader, threaded by the HTTP adapter from the assembled claw so a route
	 *  handler resolves credentials at CALL time (`ctx.secrets.get(name)`) rather than closing over a
	 *  configure-captured reader. Optional because the adapter dispatches with whatever claw it is
	 *  handed — a partial claw (tests, a bare handler) carries no `$context.secrets`. */
	secrets?: Secrets;
};

export type EuroclawRoute<ClawLike = unknown> = {
	id?: string;
	method: EuroclawHttpMethod;
	path: string;
	handler: (
		ctx: EuroclawRouteContext<ClawLike>,
	) => EuroclawRouteResult | Promise<EuroclawRouteResult>;
};

export type EuroclawCronStatus = "idle" | "processed" | "limit";

export type EuroclawCronResult = {
	processed?: number;
	status?: EuroclawCronStatus;
	data?: unknown;
};

export type EuroclawCronContext<ClawLike = unknown> = {
	claw: ClawLike;
	request?: EuroclawRouteRequest;
	limit?: number;
	/** The one-door secret reader, threaded by the HTTP adapter from the assembled claw (same as
	 *  {@link EuroclawRouteContext}) so a cron handler resolves credentials at CALL time. Optional for
	 *  the same reason — the adapter may dispatch with a partial claw. */
	secrets?: Secrets;
};

export type EuroclawCronTask<ClawLike = unknown> = {
	id: string;
	handler: (
		ctx: EuroclawCronContext<ClawLike>,
	) => EuroclawCronResult | Promise<EuroclawCronResult>;
};

export type EuroclawCronFlag = "has-cron" | "no-cron" | "unknown-cron";

/**
 * A Cedar policy slice a plugin contributes as a policy SOURCE (see {@link EuroclawPlugin.policies}).
 * Structurally the assembly's bundle-loader input — a human label, the raw Cedar text, and the merge
 * mode. `enforce` joins the live set; `shadow` is evaluated but never applied; `off` is dropped. The
 * raw Cedar is UNTRUSTED text: it is parsed only at engine construction, never here.
 */
export type PolicySourceSlice = {
	name: string;
	cedar: string;
	mode: "enforce" | "shadow" | "off";
};

// Core contributes the dependencies it OWNS (claws, effects, events, secrets) plus the resolved storage
// adapter. A plugin that owns its own tables (e.g. channels, skills) reads `adapter` and builds its OWN
// store from it — the assembly passes it in, so core stays agnostic about what plugins exist and never
// creates a plugin's store. Extra assembly-specific values still ride the index signature.
export type EuroclawPluginConfigureContext = {
	readonly clawsStore?: ClawsStore;
	readonly effects?: EffectStore;
	readonly events?: EventSink;
	/** The one-door secret reader (`@euroclaw/secrets`, built once by the assembly). A plugin that
	 *  calls out (channels, sandbox egress) resolves credentials through `context.secrets.get(name)`
	 *  rather than holding a token — same injection mechanism as `clawsStore`/`effects`/`events`.
	 *  REQUIRED: the reader is constitutive (the assembly always builds it over the env default), so a
	 *  plugin never has to `?.`-chain it. `adapter` stays optional — a no-database claw is a real state. */
	readonly secrets: Secrets;
	/** The resolved storage adapter (schema-aware, wrapped once by the assembly). A plugin that owns
	 *  tables builds its store from this at configure time; absent when createClaw got no database. */
	readonly adapter?: Adapter;
	readonly [key: string]: unknown;
};

/**
 * The RUNTIME half of a plugin — the surfaces that depend on host-created stores/context and so are
 * produced by `configure`, not declared statically. `configure(ctx)` returns ONLY this (never a whole
 * plugin): the STATIC fields (id, schema, `secrets`, gates, $phantoms) are read off the raw object
 * BEFORE configure runs, so returning a changed one would silently no-op — making that unrepresentable
 * is the point. Handlers close over the configure `ctx` argument; no mutable-slot capture, no `?.`.
 */
export type EuroclawPluginRuntime<
	Api extends Record<string, unknown> = Record<never, never>,
> = {
	/** Product API namespaces this plugin contributes (the composition layer merges them). */
	api?: (context: unknown) => Api;
	/** Adapter routes this plugin contributes. Framework adapters decide how to expose them. */
	routes?: readonly EuroclawRoute[];
	/** Scheduled work this plugin contributes. Framework adapters expose the cron trigger. */
	cron?: readonly EuroclawCronTask[];
};

/** A euroclaw plugin: a plain data object. Only `id` is required. */
export type EuroclawPlugin<
	HasCron extends EuroclawCronFlag = EuroclawCronFlag,
	RoutePaths extends readonly string[] = readonly string[],
	Api extends Record<string, unknown> = Record<never, never>,
> = {
	id: string;
	/** Phantom: whether this plugin definitely contributes cron tasks. */
	$HasCron?: HasCron;
	/** Phantom: whether this plugin owns a table and so needs a database. Set `true` and createClaw's
	 *  RequireDatabaseForPlugins demands a `database` at compile time (with a runtime backstop). */
	$RequiresDatabase?: boolean;
	/** Phantom: route paths this plugin definitely contributes, for literal duplicate checks. */
	$RoutePaths?: RoutePaths;
	/** Phantom: named types this plugin introduces (folded onto `ec.$Infer`). */
	$Infer?: Record<string, unknown>;
	/** Phantom: product API this plugin contributes to `claw.api`. */
	$Api?: Api;
	/** Phantom: context fields this plugin makes available (folded onto the turn `ctx`). */
	$InferContext?: Record<string, unknown>;
	/** Governance reason code catalog; merged (runtime + type) onto `ec.$REASON_CODES`. */
	$REASON_CODES?: Record<string, ReasonCode>;
	/**
	 * Model schema this plugin contributes: extra fields on a default model (keyed by its name, e.g.
	 * `claw`) or a brand-new table. The assembly merges these into the entity field maps (default <
	 * plugin < host) — both the runtime schema/validators and the inferred record types. Declared with
	 * `field.*()` builders, closed with `satisfies`.
	 */
	schema?: {
		readonly [model: string]: { readonly fields: Record<string, EntityField> };
	};
	/** What this plugin OFFERS and EXPECTS from the one-door reader — grouped under one namespace so the
	 *  bare `secrets` no longer overloads the offers/needs/reader senses.
	 *  - `providers`: secret backends this plugin contributes, read STATICALLY off the raw plugin object
	 *    BEFORE the reader is built (the assembly builds it before any `configure` runs) — never
	 *    registered imperatively. Merged after the assembly's env default; duplicate provider names fail
	 *    loud in buildSecrets.
	 *  - `expects`: canonical names this plugin expects to resolve — the enumerable half of runtime
	 *    `secrets.get`, feeding warn-only boot coverage (nothing fails when one is unresolved). Always-on,
	 *    needs no table. Named `expects` (not needs/requires) because coverage is a warning, not a gate. */
	secrets?: {
		providers?: readonly SecretProvider[];
		expects?: readonly SecretDeclaration[];
	};
	/** Cedar policy slices this plugin contributes as a policy SOURCE. The assembly merges them UNDER
	 *  the always-on SYSTEM_POSTURE floor into its ONE internal Cedar engine (`forbid` > `permit`, so a
	 *  source can narrow but never punch through the floor). A source contributes policy TEXT only —
	 *  never the engine or the schema, both of which are the assembly's. Read STATICALLY off the raw
	 *  plugin object (like `secrets.providers`/`eventSinks`), so the engine compiles before any
	 *  `configure` runs. `cedar({ policies })` is the canonical source; any plugin may contribute. */
	policies?: readonly PolicySourceSlice[];
	/** Before-gates this plugin installs (decide). */
	gates?: Gate[];
	/** Boundary before-gates this plugin installs (decide across tool/model boundaries). */
	boundaryGates?: BoundaryGate[];
	/** After-gates this plugin installs (observe). */
	afterGates?: AfterGate[];
	/** Operational event sinks this plugin contributes — OBSERVE-ONLY by construction (`EventSink.emit`
	 *  returns void: nothing to veto, nothing to rewrite; decisions belong to gates). Sinks receive the
	 *  same merged stream as host sinks (runtime lifecycle events + plugin-emitted) and join the
	 *  fan-out's observer class: isolated per-sink, failures warned, never propagated into the run.
	 *  Read STATICALLY off the raw plugin object BEFORE `configure` runs (same as `secrets.providers`) —
	 *  events only fire at runtime, so a sink that needs configure-time state closes over a binding its
	 *  plugin's `configure` assigns later. A sink must NOT emit through the configure context's `events`
	 *  door: that re-enters the very fan-out it observes (loop). */
	eventSinks?: readonly EventSink[];
	/** Compose this plugin against host-created stores/context, returning ONLY the RUNTIME half
	 *  ({@link EuroclawPluginRuntime}) — routes/cron/api built over the store/reader that arrive here.
	 *  Returns `undefined` when a plugin has nothing runtime to add (a static-only plugin skips
	 *  `configure` entirely). It CANNOT return changed static fields — that shape is unrepresentable. */
	configure?: (
		context: EuroclawPluginConfigureContext,
	) => EuroclawPluginRuntime<Api> | undefined;
	/** Product API namespaces this plugin contributes. The composition layer owns merging/conflicts. */
	api?: (context: unknown) => Api;
	/** Adapter routes this plugin contributes. Framework adapters decide how to expose them. */
	routes?: readonly EuroclawRoute[];
	/** Scheduled work this plugin contributes. Framework adapters expose the cron trigger. */
	cron?: readonly EuroclawCronTask[];
};

/** Producer-side narrowing for factories whose plugin's point is offering a secret backend
 *  (a composed integration: provider + routes + schema in ONE plugin). `secrets.providers` is required
 *  and non-empty — a "provider plugin" that provides nothing cannot compile. Assignable to EuroclawPlugin
 *  (an intersection, not a union: the container field stays optional/wide, `plugins: []` stays homogeneous). */
export type SecretProviderPlugin = EuroclawPlugin & {
	secrets: { providers: readonly [SecretProvider, ...SecretProvider[]] };
};

/** Union → intersection (a ubiquitous TS idiom — not better-auth-specific). */
export type UnionToIntersection<U> = (
	U extends unknown
		? (k: U) => void
		: never
) extends (k: infer I) => void
	? I
	: never;

/** True only for `any` (a ubiquitous TS idiom). Stops a stray `any` collapsing the fold. */
type IsAny<T> = 0 extends 1 & T ? true : false;
type EmptyObject = Record<never, never>;

/** Intersect field `K` across every plugin in a config (the one reusable fold). */
type FoldPluginField<Config, K extends string> = Config extends {
	plugins: infer P;
}
	? P extends ReadonlyArray<infer Item>
		? UnionToIntersection<
				Item extends Record<K, infer V>
					? IsAny<V> extends true
						? EmptyObject
						: V
					: EmptyObject
			>
		: EmptyObject
	: EmptyObject;

export type InferPlugins<Config> = FoldPluginField<Config, "$Infer">;
export type InferPluginApi<Config> = FoldPluginField<Config, "$Api">;
export type InferContext<Config> = FoldPluginField<Config, "$InferContext">;
export type InferReasonCodes<Config> = FoldPluginField<Config, "$REASON_CODES">;

/**
 * Intersect the `schema[M].fields` map every plugin contributes for model `M` — the field-map analog
 * of {@link InferPlugins}. Plugins that don't touch `M` contribute nothing. The assembly merges the
 * result under the default field map (and over it goes the host's additions).
 */
export type InferPluginSchema<Config, M extends string> = Config extends {
	plugins: infer P;
}
	? P extends ReadonlyArray<infer Item>
		? UnionToIntersection<
				Item extends { schema: infer S }
					? S extends Record<M, { fields: infer F }>
						? IsAny<F> extends true
							? EmptyObject
							: F extends Record<string, EntityField>
								? F
								: EmptyObject
						: EmptyObject
					: EmptyObject
			>
		: EmptyObject
	: EmptyObject;
