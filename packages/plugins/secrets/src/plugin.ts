import {
	configurationError,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	type EuroclawPluginRuntime,
	type ResolveContext,
	type SecretMaterial,
	type SecretProvider,
	type Secrets,
	stateError,
} from "@euroclaw/contracts";
import {
	createSecretCipher,
	parseSecretStoreKey,
	SECRET_STORE_KEY_NAME,
	type SecretCipher,
} from "./crypto";
import { storedSecretModels } from "./schema";
import {
	createStoredSecretsStore,
	type StoredSecretRecord,
	type StoredSecretsStore,
} from "./store";

/** The provider key store rows resolve under — what an audit records for a store-resolved credential. */
export const SECRET_STORE_PROVIDER_NAME = "store";

/** The in-app store the `{ store }` option turns on. */
export type SecretStoreOptions = {
	/** The at-rest master key: 32 bytes hex-encoded (64 chars), validated loud at construction.
	 *  Absent ⇒ the plugin resolves `EUROCLAW_SECRET_STORE_KEY` through the one-door reader captured at
	 *  configure — lazily, on first seal/open — so the key itself lives in env/vault. */
	key?: string;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

export type SecretsPluginOptions = {
	/** Plugin id override (default "euroclaw.secrets"). */
	id?: string;
	/** Turn on the in-app secret store: `true` for defaults, or {@link SecretStoreOptions} to configure
	 *  the master key / time source. Adds the `stored_secret` table + the `"store"` data-tier provider,
	 *  and requires a database (runtime backstop in createClaw). Absent/false ⇒ no store — just the
	 *  provider chain. */
	store?: boolean | SecretStoreOptions;
};

async function materialOf(
	row: StoredSecretRecord,
	cipher: SecretCipher,
): Promise<SecretMaterial> {
	// Pointer rows have no write surface yet (they land WITH their target-gate, a later slice) — one
	// in the table can only mean out-of-band tampering or a version skew. Refuse loud, never guess.
	if (row.kind === "pointer") {
		throw configurationError(
			"stored secret pointers are not supported yet — this row cannot be resolved",
			{ name: row.name, scope: row.scope, scopeId: row.scopeId },
		);
	}
	// A value-kind row without material is corrupt — fail loud rather than coerce it into a miss.
	if (row.value === undefined) {
		throw stateError("stored secret row has no value", {
			name: row.name,
			scope: row.scope,
			scopeId: row.scopeId,
		});
	}
	// Rows hold the SEALED form only; an unresolvable key or failed decrypt propagates loud out of
	// `open` (configurationError) — never ciphertext, never a miss.
	return { kind: "token", value: await cipher.open(row.value) };
}

/**
 * The in-app secret STORE the `{ store }` option folds in — a secret backend the composed-integration
 * push field exists for: the `stored_secret` table (`schema`), the `"store"` data-tier provider, and
 * the configure that wires them. Users paste token values into rows — AES-256-GCM-encrypted at rest
 * ({@link createSecretCipher}) — and every consumer resolves them through the one door like any other
 * provider.
 *
 * `get(name, ctx)` walks the context's OWN boundaries nearest-first, one exact single-scope lookup per
 * rung: `(personal, ctx.actor)` → miss → `(organization, ctx.organizationId)` → miss → `null`
 * (fall-through to the deployment chain). `tier: "data"` puts it BEFORE env/vault in the chain (data
 * beats config). The plugin is BOTH provider and consumer: it serves rows AND resolves its own master
 * key through the `context.secrets` reader captured at configure (lazily, at first use) — the bootstrap
 * guard short-circuits the master-key NAME to a miss so key resolution can never re-enter this table.
 *
 * THE deliberate two-role exception (docs/plans/secrets-provider-registry.md (g)): the PROVIDER object
 * is static (the assembly reads `secrets.providers` off the raw plugin before any configure runs), yet
 * the store + reader it needs only arrive at configure — a provider cannot take a per-call surface, so
 * configure fills the closure slots the provider reads.
 */
function buildStore(options: SecretStoreOptions): {
	provider: SecretProvider;
	configure: (
		context: EuroclawPluginConfigureContext,
	) => EuroclawPluginRuntime | undefined;
} {
	let store: StoredSecretsStore | undefined;
	let reader: Secrets | undefined;

	// A config key fails loud HERE (bad config surfaces at construction); the reader path stays lazy —
	// the one-door reader only exists once configure ran.
	const configKey =
		options.key !== undefined ? parseSecretStoreKey(options.key) : undefined;
	const resolveKey = async (): Promise<Uint8Array> => {
		if (configKey) return configKey;
		if (!reader) {
			throw configurationError("secret store has no master key source", {
				reason:
					"pass secrets([], { store: { key } }) or connect the plugin through createClaw so it can resolve EUROCLAW_SECRET_STORE_KEY via the one-door reader",
			});
		}
		// require packages the null+kind dance: fail loud naming the key, and assert token material
		// (the return narrows). parseSecretStoreKey still validates the hex shape below.
		const material = await reader.require(SECRET_STORE_KEY_NAME, {
			kind: "token",
		});
		return parseSecretStoreKey(material.value);
	};
	const cipher = createSecretCipher(resolveKey);

	const requireStore = (): StoredSecretsStore => {
		if (!store) {
			throw configurationError("secret store has no database", {
				reason:
					"pass a database to createClaw so the secrets() store can keep its stored_secret table",
			});
		}
		return store;
	};

	const provider: SecretProvider = {
		name: SECRET_STORE_PROVIDER_NAME,
		tier: "data",
		// The first manage-capable provider: rows are set/deleted at runtime (the management api is a
		// later slice; the store port is the write surface until then).
		capability: { manage: true },
		get: async (
			name: string,
			ctx: ResolveContext,
		): Promise<SecretMaterial | null> => {
			// Bootstrap short-circuit — CRITICAL because data-tier means this provider is consulted
			// FIRST for every name: the store's own master key must never resolve FROM the store
			// (get → decrypt → resolve key → get …). Immediately a miss; env/vault/config own it.
			if (name === SECRET_STORE_KEY_NAME) return null;
			const rows = requireStore();
			if (ctx.actor !== undefined) {
				const personal = await rows.get("personal", ctx.actor, name);
				if (personal) return materialOf(personal, cipher);
			}
			// team rung: ResolveContext carries no team fact yet (the runtime stamps TEAM_CONTEXT_KEY,
			// but nothing threads it into secret resolution) — insert `(team, ctx.team)` here when it does.
			if (ctx.organizationId !== undefined) {
				const orgWide = await rows.get(
					"organization",
					ctx.organizationId,
					name,
				);
				if (orgWide) return materialOf(orgWide, cipher);
			}
			return null;
		},
	};

	// Fills the slots the static provider reads (the two-role capture); adds no routes/cron/api.
	const configure = (
		context: EuroclawPluginConfigureContext,
	): EuroclawPluginRuntime | undefined => {
		if (context.adapter) {
			store = createStoredSecretsStore(context.adapter, {
				cipher,
				now: options.now,
			});
		}
		reader = context.secrets;
		return undefined;
	};

	return { provider, configure };
}

/**
 * `secrets(providers?, { store? })` — contributes secret providers (and the optional in-app store),
 * the channels() shape: `secrets([vault()], { store })`. Providers ADD to the chain; the assembly's
 * `env()` fallback floor stays unless you contribute your own `env`-named provider (`secrets([env({
 * vars })])`). `{ store }` folds in the `stored_secret` table + the `"store"` data-tier provider,
 * which (being data-tier) resolves BEFORE config-tier providers regardless of listing order.
 */
export function secrets(
	providers?: readonly SecretProvider[],
	options: SecretsPluginOptions = {},
): EuroclawPlugin {
	const base = providers ?? [];
	// `store: true` ⇒ default store options; an object ⇒ those options; absent/false ⇒ no store.
	const storeOptions: SecretStoreOptions | undefined =
		options.store === true
			? {}
			: options.store === undefined || options.store === false
				? undefined
				: options.store;

	if (!storeOptions) {
		return {
			id: options.id ?? "euroclaw.secrets",
			secrets: { providers: [...base] },
		};
	}

	const { provider, configure } = buildStore(storeOptions);
	return {
		id: options.id ?? "euroclaw.secrets",
		$HasCron: "no-cron",
		$RequiresDatabase: true,
		schema: storedSecretModels,
		// Base first, then the data-tier store (buildSecrets reorders data-tier ahead of config-tier).
		secrets: { providers: [...base, provider] },
		configure,
	};
}
