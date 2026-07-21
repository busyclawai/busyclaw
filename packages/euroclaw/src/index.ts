import type { ClawEngineFactory, ClawEngineHandle } from "@euroclaw/contracts";
import {
	type Adapter,
	type AuditSink,
	type ClawsStore,
	configurationError,
	type EffectStore,
	type EuroclawCronFlag,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	errorMessage,
	type InferPluginApi,
	ORGANIZATION_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	type Secrets,
} from "@euroclaw/contracts";
import {
	createRegisteredToolProvider,
	createRuntime,
	defaultRuntimeNewId,
	pluginEventSink,
	type Runtime,
	type RuntimeConfig,
	type RuntimeEventSink,
} from "@euroclaw/runtime";
import { buildSecrets, env } from "@euroclaw/secrets";
import { entityAdapter } from "@euroclaw/storage-core";
import {
	createClawsStore,
	createEffectStore,
	createRegistryStores,
	type RegistryStores,
} from "@euroclaw/storage-durable";
import { type as ark } from "arktype";
import {
	type ClawApi,
	type ClawContext,
	type ClawCronHandlerConfig,
	clawCronHandlerSecretConfig,
	clawCronHandlerUnsafeConfig,
	createClawApi,
} from "./api";
import { buildFloorPolicyPlugin } from "./authz-floor";
import { type ClawDatabase, resolveDatabase } from "./database";
import { createClawRuntimeEventSink } from "./events";
import type { ClawSchemaConfig, RequireNoCoreColumnCollision } from "./models";
import {
	normalizeRedactionConfig,
	REDACTION_SYSTEM_FRAGMENT,
	type RedactionConfig,
	resolveRedaction,
	withImmutableRedaction,
} from "./redaction";
import { collectSecretDeclarations, validateSecretsAtBoot } from "./secrets";
import { collectModelFields, getEuroclawModels } from "./tables";

export type {
	BindConversationClawInput,
	BindConversationInput,
	BindConversationResult,
	BindConversationThreadInput,
	ClawApi,
	ClawApiHttpMethod,
	ClawApiInputSchema,
	ClawApiMethod,
	ClawApiRouteDefinition,
	ClawContext,
	ClawCronHandlerConfig,
	ClawCronHandlerSecretConfig,
	ClawCronHandlerUnsafeConfig,
	ClawSendInput,
	ClawSendResult,
} from "./api";
export {
	bindConversationClawInput,
	bindConversationThreadInput,
	clawApiInputSchemas,
	clawApiRouteList,
	clawApiRoutes,
	clawCronHandlerSecretConfig,
	clawCronHandlerUnsafeConfig,
	parseClawApiInput,
} from "./api";

export type ClawStores = {
	claws?: ClawsStore;
	effects?: EffectStore;
	registry?: RegistryStores;
};

export type ClawConfig<Config extends RuntimeConfig = RuntimeConfig> = Omit<
	Config,
	// `recording` is assembly-owned (the claws-store transcript sink) — user sinks are observers
	// by definition, so the field never reaches the createClaw surface.
	| "database"
	| "effectStore"
	| "events"
	| "recording"
	| "resolveTools"
	| "redactor"
> & {
	cronHandler?: ClawCronHandlerConfig;
	database?: ClawDatabase;
	engine?: ClawEngineFactory<
		Runtime<Config>,
		ClawEngineHandle,
		EuroclawCronFlag
	>;
	events?: RuntimeEventSink | readonly RuntimeEventSink[];
	/** Entity-column extension per DB model — the `additionalFields` analog, mirroring
	 *  `plugin.schema.claw.fields`. (Not LLMs — see `model`/`models`.) */
	schema?: ClawSchemaConfig;
	/** Redaction POLICY — a `Detector[]` (strict over those detectors), or the object form for
	 *  posture, dedup key, and `raw`/`per-claw`. The assembly builds the mechanism from the same
	 *  `database` as every other store; `createRuntime.redactor` stays the mechanism port. */
	redaction?: RedactionConfig;
	stores?: ClawStores;
};

/**
 * The config as everything past the intake sees it: `database` resolved to the storage protocol.
 * An intersection (not an Omit re-derivation) so TS can prove it satisfies RuntimeConfig for any
 * Config extending ClawConfig.
 */
type ResolvedConfig<Config> = Config & { database?: Adapter };

type EngineCronFlag<Config> = Config extends {
	engine: ClawEngineFactory<infer _RuntimeLike, infer _Handle, infer HasCron>;
}
	? HasCron
	: "no-cron";

type PluginCronFlag<Config> = Config extends {
	plugins: readonly (infer Plugin)[];
}
	? Plugin extends { $HasCron?: infer HasCron }
		? Extract<HasCron, EuroclawCronFlag>
		: "unknown-cron"
	: "no-cron";

type HasCronContributor<Config> = "has-cron" extends
	| EngineCronFlag<Config>
	| PluginCronFlag<Config>
	? true
	: false;

type RoutePathsOf<Plugin> = Plugin extends { $RoutePaths?: infer Paths }
	? Paths extends readonly string[]
		? Paths
		: []
	: [];

type ConcatRoutePaths<Plugins> = Plugins extends readonly [
	infer Head,
	...infer Tail,
]
	? [...RoutePathsOf<Head>, ...ConcatRoutePaths<Tail>]
	: [];

type HasDuplicateRoutePath<
	Items extends readonly string[],
	Seen extends readonly string[] = [],
> = Items extends readonly [
	infer Head extends string,
	...infer Tail extends string[],
]
	? Head extends Seen[number]
		? true
		: HasDuplicateRoutePath<Tail, [...Seen, Head]>
	: false;

type MissingCronHandlerError = {
	readonly "ERROR: createClaw requires cronHandler because an engine/plugin/channel contributes cron tasks": never;
	readonly "FIX: add cronHandler: { secret: string } or disable cron tasks on the contributor": never;
};

type RequireCronHandler<Config> =
	HasCronContributor<Config> extends true
		? Config extends { cronHandler: ClawCronHandlerConfig }
			? unknown
			: MissingCronHandlerError
		: unknown;

type DuplicatePluginRoutePathError = {
	readonly "ERROR: duplicate plugin route path detected": never;
	readonly "FIX: set a unique webhook.path or endpointKey for each channel/plugin": never;
};

type RequireUniquePluginRoutePaths<Config> = Config extends {
	plugins: infer Plugins extends readonly unknown[];
}
	? HasDuplicateRoutePath<ConcatRoutePaths<Plugins>> extends true
		? DuplicatePluginRoutePathError
		: unknown
	: unknown;

type MissingDatabaseForPluginError = {
	readonly "ERROR: a plugin needs a database (e.g. channels registrations contributes a table)": never;
	readonly "FIX: pass database to createClaw, or disable the plugin feature that needs it": never;
};

/**
 * The `$HasCron`→RequireCronHandler fold, for storage: a plugin marks itself with a `$RequiresDatabase:
 * true` phantom when it owns a table that has nowhere to live without a database (channels registrations
 * sets it when enabled). Read the marker off the plugin tuple — a required-field match, so a plugin that
 * doesn't set it contributes `never` — and reject at compile time an owning config that passes no
 * `database`. The runtime configurationError in createClaw backstops JS / `as any` callers. Resolves to
 * `unknown` (no-op) when no plugin requires a database or one is present.
 */
type PluginRequiresDatabase<Config> = Config extends {
	plugins: readonly (infer Plugin)[];
}
	? Plugin extends { $RequiresDatabase: infer Requires }
		? Requires
		: never
	: never;

type RequireDatabaseForPlugins<Config> =
	true extends PluginRequiresDatabase<Config>
		? Config extends { database: infer Database }
			? [Database] extends [undefined]
				? MissingDatabaseForPluginError
				: unknown
			: MissingDatabaseForPluginError
		: unknown;

export type Claw<Config extends RuntimeConfig = RuntimeConfig> = {
	readonly api: ClawApi<Config> & InferPluginApi<Config>;
	readonly $context: ClawContext<Config> & {
		readonly audit?: AuditSink;
		readonly approvals: Runtime<Config>["approvals"];
	};
};

function eventSinksFrom(
	input: RuntimeEventSink | readonly RuntimeEventSink[] | undefined,
): RuntimeEventSink[] {
	if (!input) return [];
	return "emit" in input ? [input] : [...input];
}

function hasCronTasks(plugins: readonly EuroclawPlugin[]): boolean {
	return plugins.some((plugin) => (plugin.cron?.length ?? 0) > 0);
}

function assertCronHandler(input: {
	cronHandler: ClawCronHandlerConfig | undefined;
	plugins: readonly EuroclawPlugin[];
}): void {
	if (!hasCronTasks(input.plugins)) return;
	if (input.cronHandler === undefined) {
		throw configurationError(
			"createClaw requires cronHandler because an engine/plugin/channel contributes cron tasks",
		);
	}
	if (input.cronHandler === false) return;
	const unsafe = clawCronHandlerUnsafeConfig(input.cronHandler);
	if (!(unsafe instanceof ark.errors)) return;
	const secret = clawCronHandlerSecretConfig(input.cronHandler);
	if (secret instanceof ark.errors || secret.secret.length === 0) {
		throw configurationError(
			"createClaw cronHandler.secret must be a non-empty string",
		);
	}
}

function normalizeRoutePath(path: string): string {
	const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
	return withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")
		? withLeadingSlash.slice(0, -1)
		: withLeadingSlash;
}

function assertUniquePluginRoutes(plugins: readonly EuroclawPlugin[]): void {
	const seen = new Map<string, string>();
	for (const plugin of plugins) {
		for (const route of plugin.routes ?? []) {
			const key = `${route.method} ${normalizeRoutePath(route.path)}`;
			const routeId = route.id ?? `${plugin.id}:${route.method}:${route.path}`;
			const previous = seen.get(key);
			if (previous) {
				throw configurationError("duplicate euroclaw plugin route", {
					key,
					previous,
					route: routeId,
				});
			}
			seen.set(key, routeId);
		}
	}
}

function configurePlugins(input: {
	context: EuroclawPluginConfigureContext;
	plugins: readonly EuroclawPlugin[];
}): EuroclawPlugin[] {
	return input.plugins.map((plugin) => {
		// configure returns only the RUNTIME half (routes/cron/api built over the arriving store/reader);
		// merge it over the static plugin. The static fields (schema, secrets, gates, $phantoms) are the
		// plugin's own — the runtime half can only add/replace routes/cron/api, never a static field.
		const runtime = plugin.configure?.(input.context);
		return runtime ? { ...plugin, ...runtime } : plugin;
	});
}

function assertApiContribution(input: {
	pluginId: string;
	value: unknown;
}): Record<string, unknown> {
	if (
		input.value === null ||
		typeof input.value !== "object" ||
		Array.isArray(input.value)
	) {
		throw configurationError("euroclaw plugin api must be an object", {
			pluginId: input.pluginId,
		});
	}
	return input.value as Record<string, unknown>;
}

function createPluginApi(input: {
	baseApi: object;
	context: ClawContext;
	plugins: readonly EuroclawPlugin[];
}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const owners = new Map<string, string>();
	for (const plugin of input.plugins) {
		if (!plugin.api) continue;
		const api = assertApiContribution({
			pluginId: plugin.id,
			value: plugin.api(input.context),
		});
		for (const [key, value] of Object.entries(api)) {
			const previous = owners.get(key);
			if (previous) {
				throw configurationError("duplicate euroclaw plugin api namespace", {
					namespace: key,
					pluginId: plugin.id,
					previous,
				});
			}
			if (key in input.baseApi) {
				throw configurationError(
					"euroclaw plugin api conflicts with base api",
					{
						namespace: key,
						pluginId: plugin.id,
					},
				);
			}
			owners.set(key, plugin.id);
			out[key] = value;
		}
	}
	return out;
}

/**
 * Build the per-run tool resolver for an organization's registered rows: synthesize its rows into
 * invoker-backed tools, with org/principal read from the RESOLVED turn context and closure-captured at
 * synthesis (never the AI-SDK execute options, which carry no turn context). The provider is built
 * once here (over the one-door reader); the returned resolver runs per turn.
 *
 * The invoker resolves each registration's credential by its `source` name through the reader — the
 * requirement's `scheme` is apply-only (how to place the material, read from the spec's securityScheme).
 * KNOWN LIMITATION: name = source assumes ONE credential per registration; a spec declaring multiple
 * distinct-credential securitySchemes would collide on `source` — the per-registration credential-name
 * override is a later slice. Do NOT build the override here.
 */
function registeredToolResolver(
	stores: RegistryStores,
	secrets: Secrets,
): NonNullable<RuntimeConfig["resolveTools"]> {
	const provider = createRegisteredToolProvider({ secrets });
	return async (ctx) => {
		const organizationId = ctx[ORGANIZATION_CONTEXT_KEY];
		if (typeof organizationId !== "string") return {};
		const rows =
			await stores.registeredTools.listByOrganization(organizationId);
		const principal = ctx[PRINCIPAL_CONTEXT_KEY];
		return provider(rows, {
			organizationId,
			principal: typeof principal === "string" ? principal : undefined,
		});
	};
}

/**
 * `createClaw` constraint: a claw needs exactly one model source. Resolves to `unknown` (no-op) when
 * `model` is present, or `models` is a non-empty pool; otherwise to an error-shaped type whose keys
 * name the problem in the compile error. Mirrors {@link RequireNoCoreColumnCollision}. The runtime
 * `createModelSelector` backstops JS / `as any` callers.
 */
export type RequireModelOrModels<Config> = Config extends { model: object }
	? Config extends { models: object }
		? {
				readonly "ERROR: `model` and `models` are mutually exclusive": never;
				readonly "FIX: use the single-model `model`, or the `models` pool — not both": never;
			}
		: unknown
	: Config extends { models: infer Pool }
		? [keyof Pool] extends [never]
			? {
					readonly "ERROR: the `models` pool is empty": never;
					readonly "FIX: add at least one named model, e.g. models: { fast: … }": never;
				}
			: unknown
		: {
				readonly "ERROR: createClaw needs a model": never;
				readonly "FIX: pass `model` (single) or a non-empty `models` pool": never;
			};

export function createClaw<const Config extends ClawConfig<RuntimeConfig>>(
	config: Config &
		RequireCronHandler<Config> &
		RequireUniquePluginRoutePaths<Config> &
		RequireNoCoreColumnCollision<Config> &
		RequireModelOrModels<Config> &
		RequireDatabaseForPlugins<Config>,
): Claw<ResolvedConfig<Config>> {
	const adapter = config.database
		? resolveDatabase(config.database)
		: undefined;
	const pluginList = (config.plugins ?? []) as readonly EuroclawPlugin[];
	// A plugin that owns a table (channels registrations) marks itself $RequiresDatabase — its table has
	// nowhere to live without one. Runtime backstop for the compile-time RequireDatabaseForPlugins guard.
	if (
		!adapter &&
		pluginList.some((plugin) => plugin.$RequiresDatabase === true)
	) {
		throw configurationError(
			"a plugin needs a database (e.g. channels registrations contributes a table)",
			{
				reason:
					"pass database to createClaw, or disable the plugin feature that needs it",
			},
		);
	}
	// Durable state (approvals, events, checkpoints) persists what the runtime hands it, and the
	// runtime refuses that without a durable redactor — surface the decision HERE, in the config
	// vocabulary the host actually writes. A legacy runtime-level `redactor` (JS callers; the field
	// is gone from ClawConfig) still flows through and meets the runtime guard on its own.
	const legacyRedactor = (config as { redactor?: RuntimeConfig["redactor"] })
		.redactor;
	if (
		adapter &&
		config.redaction === undefined &&
		legacyRedactor === undefined
	) {
		throw configurationError(
			"database-backed claws persist approvals, events, and checkpoints — configure redaction",
			{
				reason:
					'add redaction: { detector, indexKey } to redact durable state, or redaction: { posture: "raw" } to accept unerasable persistence',
			},
		);
	}
	// The one operator-notice door (RuntimeConfig.warn): the assembly resolves it ONCE and routes
	// every boot/assembly warning through it — redaction (prefix "euroclaw redaction:"), secrets boot
	// (prefix "euroclaw secrets:"), and the event fan-out's observer-failure reports. `config.warn`
	// also rides the createRuntime spread untouched, so the runtime's own sites (tool-name
	// collisions) resolve the SAME door.
	const warn = config.warn ?? ((message: string) => console.warn(message));
	// The one door every subsystem resolves credentials through, built once from the provider chain.
	// Plugin-contributed providers come FIRST; `env()` is appended as the lowest-priority FALLBACK
	// floor — always present, because installing a provider plugin must never silently REMOVE env
	// (plugins are additive), yet env only ever serves a name nothing else resolves. A plugin that
	// contributes its own `env`-named provider (e.g. `secrets([env({ vars })])`, to reconfigure or
	// deterministically shadow it) suppresses the auto-floor. Contributions are read STATICALLY off the
	// raw plugin list — the reader is built before `configure` runs, so consumers close over the
	// complete chain. buildSecrets then floats data-tier providers (runtime-managed rows) ahead of
	// config-tier ones and fails loud on a duplicate name across the whole chain.
	const pluginProviders = pluginList.flatMap(
		(plugin) => plugin.secrets?.providers ?? [],
	);
	const providers = [
		...pluginProviders,
		...(pluginProviders.some((provider) => provider.name === "env")
			? []
			: [env()]),
	];
	const secrets: Secrets = buildSecrets(providers);
	// Fail fast at init if any plugin/host schema collides with a core column — the same collection the
	// `generate` CLI runs, so a bad registration surfaces here, not at migration time. The merged
	// MODEL map (fields per model) also drives the entity-validating adapter handed to plugins below —
	// migration and persistence share one source.
	const models = getEuroclawModels({
		schema: config.schema,
		plugins: pluginList,
		redaction: config.redaction,
	});
	const modelFields = collectModelFields(
		pluginList,
		config.schema,
		config.redaction,
	);
	const clawAdditionalFields = modelFields.claw;
	const perClawRedaction =
		normalizeRedactionConfig(config.redaction)?.posture === "per-claw";
	const resolvedClawsStore =
		config.stores?.claws ??
		(adapter
			? createClawsStore(
					adapter,
					clawAdditionalFields
						? { additionalFields: { claw: clawAdditionalFields } }
						: {},
				)
			: undefined);
	// Posture is a birth fact of the row — wrap ONCE so every writer (api, plugins, sinks) sees
	// the same immutability wall.
	const clawsStore =
		perClawRedaction && resolvedClawsStore
			? withImmutableRedaction(resolvedClawsStore)
			: resolvedClawsStore;
	const redaction = resolveRedaction({
		config: config.redaction,
		adapter,
		clawsStore,
		warn: (message) => warn(`euroclaw redaction: ${message}`),
	});
	// The placeholder contract rides the system prompt whenever placeholders can actually appear.
	const system = redaction.armed
		? [config.system, REDACTION_SYSTEM_FRAGMENT]
				.filter((part): part is string => typeof part === "string")
				.join("\n\n")
		: config.system;
	const configuredEffectStore = (config as { effectStore?: EffectStore })
		.effectStore;
	const effectsStore =
		config.stores?.effects ??
		configuredEffectStore ??
		(adapter ? createEffectStore(adapter) : undefined);
	// The tool registry rides the same adapter — it's product durable state, not a plugin.
	const registryStores =
		config.stores?.registry ??
		(adapter ? createRegistryStores(adapter) : undefined);
	// Registered tools become executable per run (see registeredToolResolver above): the invoker
	// resolves each row's credential through the one-door reader by its `source` name.
	const resolveTools = registryStores
		? registeredToolResolver(registryStores, secrets)
		: undefined;
	// The recording/observer split: the claws-store transcript sink is the ONE load-bearing
	// recording sink (its failures fail the run); every user-configured AND plugin-contributed sink
	// is an observer — isolated in the fan-out, warned on failure. Plugin sinks are read STATICALLY
	// off the raw plugin list (same as secrets.providers above): the emit door below closes over this
	// fan-out before any `configure` runs, and events only FIRE at runtime — a sink that needs
	// configured state closes over a binding its plugin's `configure` assigns. The ONE merged list
	// feeds both pipelines — the plugin emit door here and the runtime's own emit path (`events`
	// passed to createRuntime below) — so a plugin sink never sees door-emitted events but misses
	// runtime events, or vice versa.
	const recordingSink = clawsStore
		? createClawRuntimeEventSink(clawsStore)
		: undefined;
	const observerSinks: readonly RuntimeEventSink[] = [
		...eventSinksFrom(config.events),
		...pluginList.flatMap((plugin) => plugin.eventSinks ?? []),
	];
	const eventFanout = {
		recording: recordingSink,
		observers: observerSinks,
		warn,
	};
	const configuredPlugins = configurePlugins({
		context: {
			// The resolved adapter, wrapped ONCE with the merged models (better-auth builds its adapter
			// with the full getAuthTables schema the same way) and passed through the configure context's
			// index signature. The entity layer validates every row against its model's record schema,
			// so a plugin read is a checked read; plugins open a typed lens over it (entityView) with
			// their own field maps and never wrap adapters themselves. The storage-durable stores above
			// deliberately take the RAW adapter instead and wrap internally: they ARE the storage layer
			// (entityDb is theirs to use), and their constructors are public host API — the wrap-once
			// rule exists to keep PLUGINS free of the storage implementation, not to move every wrap to
			// the assembly.
			adapter: adapter ? entityAdapter(adapter, models) : undefined,
			clawsStore,
			effects: effectsStore,
			events: pluginEventSink(eventFanout),
			secrets,
		},
		plugins: (config.plugins ?? []) as readonly EuroclawPlugin[],
	});
	// The always-on governance FLOOR — the assembly's ONE internal Cedar engine (SYSTEM_POSTURE + every
	// plugin's `policies` sources), wired into the runtime chokepoint UNCONDITIONALLY. Sources are read
	// STATICALLY off the raw plugin list (like secrets.providers); the model is built from the static
	// tools that declare an access class. It is a runtime GATE only — invisible to the api/routes/cron
	// surfaces below — so a zero-config claw is governed by the floor without any policy plugin.
	const floorPlugin = buildFloorPolicyPlugin({
		...(config.tools ? { tools: config.tools } : {}),
		plugins: pluginList,
		...(config.warn ? { warn: config.warn } : {}),
	});
	const runtime = createRuntime({
		...config,
		plugins: [floorPlugin, ...configuredPlugins],
		...(adapter ? { database: adapter } : {}),
		...(effectsStore ? { effectStore: effectsStore } : {}),
		// Explicit, AFTER the spread: overrides `config.events` with the merged host+plugin observer
		// list so the runtime's own fan-out fires the SAME sink instances as the plugin emit door.
		events: observerSinks,
		...(recordingSink ? { recording: recordingSink } : {}),
		...(resolveTools ? { resolveTools } : {}),
		...(redaction.redactor ? { redactor: redaction.redactor } : {}),
		...(system !== undefined ? { system } : {}),
	} as ResolvedConfig<Config>);
	const engine = config.engine?.create(runtime);
	const newId = config.environment?.newId ?? defaultRuntimeNewId;
	const plugins: EuroclawPlugin<EuroclawCronFlag>[] = [
		...configuredPlugins,
		...(engine?.plugins ?? []),
	];
	assertCronHandler({ cronHandler: config.cronHandler, plugins });
	assertUniquePluginRoutes(plugins);
	// The required-secret names plugins declare — always-on (needs no table), feeds boot coverage.
	const secretDeclarations = collectSecretDeclarations(plugins);
	const context: Claw<ResolvedConfig<Config>>["$context"] = {
		audit: runtime.audit,
		approvals: runtime.approvals,
		clawsStore,
		redaction: redaction.handle,
		cronHandler: config.cronHandler,
		effects: effectsStore,
		engine: engine?.engine,
		plugins,
		registry: registryStores,
		runs: engine?.runs,
		runtime,
		secrets,
		secretDeclarations,
	};
	const baseApi = createClawApi({ context, newId });
	const api = {
		...baseApi,
		...createPluginApi({ baseApi, context, plugins }),
	} as Claw<ResolvedConfig<Config>>["api"];

	// Boot validation — warn-only, fired fire-and-forget (createClaw is sync so it cannot await; the
	// probe walks the provider chain). It NEVER fails boot: a rejected promise is caught and warned.
	// Only runs when there's a declaration to cover, so the common no-declarations path stays cost-free.
	if (secretDeclarations.length > 0) {
		void validateSecretsAtBoot({
			declarations: secretDeclarations,
			secrets,
			warn: (warning) => warn(`euroclaw secrets: ${warning.message}`),
		}).catch((err) => {
			warn(`euroclaw secrets: boot validation failed — ${errorMessage(err)}`);
		});
	}

	return {
		$context: context,
		api,
	};
}

export type {
	Runtime,
	RuntimeConfig,
	RuntimeEvent,
	RuntimeEventSink,
	RuntimeResult,
} from "@euroclaw/runtime";
export { govern } from "@euroclaw/runtime";
export type { MessageView } from "./api";
export type { ClawDatabase } from "./database";
export { createClawRuntimeEventSink } from "./events";
export { logEvents } from "./log-events";
export type {
	ClawRedactionHandle,
	PerClawRedactionConfig,
	RawRedactionConfig,
	RedactionConfig,
	StrictRedactionConfig,
} from "./redaction";
export {
	clawRedactionFields,
	REDACTION_POSTURES,
	REDACTION_SYSTEM_FRAGMENT,
} from "./redaction";
export type { ActionView } from "./registry";
export {
	assembleOrgActions,
	registerOpenApiSpecTool,
	serverForActionFromRegisteredTools,
} from "./registry";
export type {
	SecretBootWarning,
	ValidateSecretsAtBootInput,
} from "./secrets";
export { collectSecretDeclarations, validateSecretsAtBoot } from "./secrets";
export { getEuroclawModels, getEuroclawTables } from "./tables";
