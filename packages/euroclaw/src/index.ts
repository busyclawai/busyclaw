import type { ClawEngineFactory, ClawEngineHandle } from "@euroclaw/contracts";
import {
	ACTOR_CONTEXT_KEY,
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
import { schemaAdapter } from "@euroclaw/storage-core";
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
import { type ClawDatabase, resolveDatabase } from "./database";
import { createClawRuntimeEventSink } from "./events";
import type { ClawModelsConfig, RequireNoCoreColumnCollision } from "./models";
import { collectSecretDeclarations, validateSecretsAtBoot } from "./secrets";
import { collectModelFields, getEuroclawTables } from "./tables";

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
	"database" | "effectStore" | "events" | "resolveTools"
> & {
	cronHandler?: ClawCronHandlerConfig;
	database?: ClawDatabase;
	engine?: ClawEngineFactory<
		Runtime<Config>,
		ClawEngineHandle,
		EuroclawCronFlag
	>;
	events?: RuntimeEventSink | readonly RuntimeEventSink[];
	models?: ClawModelsConfig;
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
 * invoker-backed tools, with org/actor read from the RESOLVED turn context and closure-captured at
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
		const actor = ctx[ACTOR_CONTEXT_KEY];
		return provider(rows, {
			organizationId,
			actor: typeof actor === "string" ? actor : undefined,
		});
	};
}

export function createClaw<const Config extends ClawConfig<RuntimeConfig>>(
	config: Config &
		RequireCronHandler<Config> &
		RequireUniquePluginRoutePaths<Config> &
		RequireNoCoreColumnCollision<Config> &
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
	// tables also drive the schema-aware adapter handed to plugins below.
	const tables = getEuroclawTables({
		models: config.models,
		plugins: pluginList,
	});
	const modelFields = collectModelFields(pluginList, config.models);
	const clawAdditionalFields = modelFields.claw;
	const clawsStore =
		config.stores?.claws ??
		(adapter
			? createClawsStore(
					adapter,
					clawAdditionalFields
						? { additionalFields: { claw: clawAdditionalFields } }
						: {},
				)
			: undefined);
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
	const eventSinks = [
		...(clawsStore ? [createClawRuntimeEventSink(clawsStore)] : []),
		...eventSinksFrom(config.events),
	];
	const configuredPlugins = configurePlugins({
		context: {
			// The resolved adapter, wrapped ONCE with the merged tables (better-auth builds its adapter
			// with the full getAuthTables schema the same way) and passed through the configure context's
			// index signature. Plugins that own tables build their stores on it directly — they speak
			// logical model/field names and never wrap adapters themselves. The storage-durable stores
			// above deliberately take the RAW adapter instead and wrap internally: they ARE the storage
			// layer (schemaAdapter is theirs to use), and their constructors are public host API — the
			// wrap-once rule exists to keep PLUGINS free of the storage implementation, not to move
			// every wrap to the assembly.
			adapter: adapter ? schemaAdapter(adapter, tables) : undefined,
			clawsStore,
			effects: effectsStore,
			events: pluginEventSink(eventSinks),
			secrets,
		},
		plugins: (config.plugins ?? []) as readonly EuroclawPlugin[],
	});
	const runtime = createRuntime({
		...config,
		plugins: configuredPlugins,
		...(adapter ? { database: adapter } : {}),
		...(effectsStore ? { effectStore: effectsStore } : {}),
		...(eventSinks.length > 0 ? { events: eventSinks } : {}),
		...(resolveTools ? { resolveTools } : {}),
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
			warn: (warning) => console.warn(`euroclaw secrets: ${warning.message}`),
		}).catch((err) => {
			console.warn(
				`euroclaw secrets: boot validation failed — ${errorMessage(err)}`,
			);
		});
	}

	return {
		$context: context,
		api,
	};
}

export type { Runtime, RuntimeConfig, RuntimeResult } from "@euroclaw/runtime";
export { govern } from "@euroclaw/runtime";
export type { ClawDatabase } from "./database";
export { createClawRuntimeEventSink } from "./events";
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
export { getEuroclawTables } from "./tables";
