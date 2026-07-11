import {
	configurationError,
	type EuroclawPluginConfigureContext,
	type EuroclawPluginRuntime,
	type ResolveContext,
	type SecretMaterial,
	type SecretProvider,
	type SecretProviderPlugin,
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

export type SecretStoreOptions = {
	/** Plugin id override — the channels/skills convention. */
	id?: string;
	/** The at-rest master key: 32 bytes hex-encoded (64 chars), validated loud at construction.
	 *  Absent ⇒ the plugin resolves `EUROCLAW_SECRET_STORE_KEY` through the one-door reader captured
	 *  at configure — lazily, on first seal/open — so the key itself lives in env/vault and the
	 *  plugin stays a one-door citizen. */
	key?: string;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

/** The plugin `secretStore()` returns — a SecretProviderPlugin (non-empty `secrets.providers`)
 *  narrowed for createClaw's folds: contributes no cron, and its table needs a database. */
export type SecretStorePlugin = SecretProviderPlugin & {
	$HasCron: "no-cron";
	$RequiresDatabase: true;
};

/** The provider key rows resolve under — what an audit records for a store-resolved credential. */
export const SECRET_STORE_PROVIDER_NAME = "store";

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
 * The secret-store plugin — a plugin that IS a secret backend (the composed-integration case the
 * `secrets.providers` push field exists for): ONE plugin contributing the `stored_secret` table
 * (`schema`) and the `"store"` provider (`secrets.providers`), atomically. Users paste token values
 * into rows — AES-256-GCM-encrypted at rest ({@link createSecretCipher}) — and every consumer
 * resolves them through the one door like any other provider; nothing is special-cased.
 *
 * `get(name, ctx)` walks the context's OWN boundaries nearest-first, one exact single-scope lookup
 * per rung (the skills-resolution shape — never a membership-expanding union):
 * `(personal, ctx.actor)` → miss → `(organization, ctx.organizationId)` → miss → `null`
 * (fall-through to the deployment chain). Org-less contexts simply have fewer rungs — personal
 * still resolves. `tier: "data"` puts the store BEFORE env/vault in the chain (data beats config —
 * the precedence the deleted per-org DB-alias layer had, now a provider property).
 *
 * The plugin is BOTH provider and consumer: it serves rows through `secrets.providers` AND resolves
 * its own master key through the `context.secrets` reader captured at configure (lazily, at first
 * use). The bootstrap guard that makes that safe: `get` short-circuits the master-key NAME to a
 * miss, so key resolution falls through to env/vault and can never re-enter this table.
 *
 * Two-phase wiring, deliberately: the provider OBJECT is created here (the assembly reads
 * `secrets.providers` STATICALLY off the raw plugin list, before any `configure` runs), while the
 * store and reader it uses arrive at `configure` — so `get` resolves through slots `configure`
 * fills. A rebuilt-plugin configure (the channels pattern) would NOT work here: the rebuilt
 * object's providers are never re-read.
 */
export function secretStore(
	options: SecretStoreOptions = {},
): SecretStorePlugin {
	let store: StoredSecretsStore | undefined;
	let reader: Secrets | undefined;

	// A config key fails loud HERE (bad config surfaces at construction, the channels validate
	// posture); the reader path stays lazy — the one-door reader only exists once configure ran.
	const configKey =
		options.key !== undefined ? parseSecretStoreKey(options.key) : undefined;
	const resolveKey = async (): Promise<Uint8Array> => {
		if (configKey) return configKey;
		if (!reader) {
			throw configurationError("secret store has no master key source", {
				reason:
					"pass secretStore({ key }) or connect the plugin through createClaw so it can resolve EUROCLAW_SECRET_STORE_KEY via the one-door reader",
			});
		}
		// require packages the null+kind dance: fail loud naming the key if nothing resolves it, and
		// assert token material (the return narrows, so `.value` is reachable). parseSecretStoreKey
		// still validates the hex shape below — a resolved-but-malformed key fails there.
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
					"pass a database to createClaw so secretStore() can keep its stored_secret table",
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
			// but nothing threads it into secret resolution) — insert `(team, ctx.team)` here when it
			// does.
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

	// THE deliberate two-role exception (docs/plans/secrets-provider-registry.md (g)): this plugin's
	// PROVIDER object is STATIC — the assembly reads `secrets.providers` off the raw plugin before any
	// configure runs — yet the store + master-key reader it needs only arrive at configure. A provider
	// can't take a per-call surface, so `configure` fills the closure slots the provider reads. It adds
	// no routes/cron/api, so it returns `undefined` (the runtime half is empty).
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

	return {
		id: options.id ?? "euroclaw.secret-store",
		$HasCron: "no-cron",
		$RequiresDatabase: true,
		schema: storedSecretModels,
		// The "store" backend this plugin OFFERS — read statically off the raw plugin, before configure.
		secrets: { providers: [provider] },
		configure,
	};
}
