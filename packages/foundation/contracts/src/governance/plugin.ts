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
};

export type EuroclawCronTask<ClawLike = unknown> = {
	id: string;
	handler: (
		ctx: EuroclawCronContext<ClawLike>,
	) => EuroclawCronResult | Promise<EuroclawCronResult>;
};

export type EuroclawCronFlag = "has-cron" | "no-cron" | "unknown-cron";

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
	 *  rather than holding a token — same injection mechanism as `clawsStore`/`effects`/`events`. */
	readonly secrets?: Secrets;
	/** The resolved storage adapter (schema-aware, wrapped once by the assembly). A plugin that owns
	 *  tables builds its store from this at configure time; absent when createClaw got no database. */
	readonly adapter?: Adapter;
	readonly [key: string]: unknown;
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
	/** Secret names this plugin needs — the enumerable half of runtime `secrets.get`. The assembly
	 *  collects these across plugins into the required-names set (boot coverage + `claw.api.secrets`).
	 *  Always-on: needs no table, runs whether or not `dynamicSecretAliases` is enabled. */
	secrets?: readonly SecretDeclaration[];
	/** Secret backends this plugin OFFERS (`secrets` above declares NEEDS; this declares OFFERS). Read
	 *  STATICALLY off the plugin object BEFORE the resolver is built (the assembly builds `secrets`
	 *  before any plugin's `configure` runs) — never registered imperatively. Merged after
	 *  `config.secretProviders`; duplicate provider names fail loud in buildSecrets. */
	secretProviders?: readonly SecretProvider[];
	/** Before-gates this plugin installs (decide). */
	gates?: Gate[];
	/** Boundary before-gates this plugin installs (decide across tool/model boundaries). */
	boundaryGates?: BoundaryGate[];
	/** After-gates this plugin installs (observe). */
	afterGates?: AfterGate[];
	/** Compose this plugin against host-created stores/context before runtime gates are installed. */
	configure?: (
		context: EuroclawPluginConfigureContext,
	) => EuroclawPlugin | undefined;
	/** Product API namespaces this plugin contributes. The composition layer owns merging/conflicts. */
	api?: (context: unknown) => Api;
	/** Adapter routes this plugin contributes. Framework adapters decide how to expose them. */
	routes?: readonly EuroclawRoute[];
	/** Scheduled work this plugin contributes. Framework adapters expose the cron trigger. */
	cron?: readonly EuroclawCronTask[];
};

/** Producer-side narrowing for factories whose plugin's point is offering a secret backend
 *  (a composed integration: provider + routes + schema in ONE plugin). Required and non-empty —
 *  a "provider plugin" that provides nothing cannot compile. Assignable to EuroclawPlugin (an
 *  intersection, not a union: the container field stays optional/wide, `plugins: []` stays homogeneous). */
export type SecretProviderPlugin = EuroclawPlugin & {
	secretProviders: readonly [SecretProvider, ...SecretProvider[]];
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
