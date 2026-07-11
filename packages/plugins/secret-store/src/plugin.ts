import {
	configurationError,
	type EuroclawPlugin,
	type EuroclawPluginConfigureContext,
	type ResolveContext,
	type SecretMaterial,
	type SecretProvider,
	type SecretProviderPlugin,
	stateError,
} from "@euroclaw/contracts";
import { storedSecretModels } from "./schema";
import {
	createStoredSecretsStore,
	type StoredSecretRecord,
	type StoredSecretsStore,
} from "./store";

export type SecretStoreOptions = {
	/** Plugin id override — the channels/skills convention. */
	id?: string;
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

/** The plugin `secretStore()` returns — a SecretProviderPlugin (non-empty `secretProviders`)
 *  narrowed for createClaw's folds: contributes no cron, and its table needs a database. */
export type SecretStorePlugin = SecretProviderPlugin & {
	$HasCron: "no-cron";
	$RequiresDatabase: true;
};

/** The provider key rows resolve under — what an audit records for a store-resolved credential. */
export const SECRET_STORE_PROVIDER_NAME = "store";

function materialOf(row: StoredSecretRecord): SecretMaterial {
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
	return { kind: "token", value: row.value };
}

/**
 * The secret-store plugin — a plugin that IS a secret backend (the composed-integration case the
 * `secretProviders` push field exists for): ONE plugin contributing the `stored_secret` table
 * (`schema`) and the `"store"` provider (`secretProviders`), atomically. Users paste token values
 * into rows; every consumer resolves them through the one door like any other provider — nothing is
 * special-cased.
 *
 * `get(name, ctx)` walks the context's OWN boundaries nearest-first, one exact single-scope lookup
 * per rung (the skills-resolution shape — never a membership-expanding union):
 * `(personal, ctx.actor)` → miss → `(organization, ctx.organizationId)` → miss → `null`
 * (fall-through to the deployment chain). Org-less contexts simply have fewer rungs — personal
 * still resolves. `tier: "data"` puts the store BEFORE env/vault in the chain (data beats config —
 * the precedence the deleted per-org DB-alias layer had, now a provider property).
 *
 * Two-phase wiring, deliberately: the provider OBJECT is created here (the assembly reads
 * `secretProviders` STATICALLY off the raw plugin list, before any `configure` runs), while the
 * store it reads arrives at `configure` (the adapter is only in scope there) — so `get` resolves
 * through a slot `configure` fills. A rebuilt-plugin configure (the channels pattern) would NOT
 * work here: the rebuilt object's providers are never re-read.
 */
export function secretStore(
	options: SecretStoreOptions = {},
): SecretStorePlugin {
	let store: StoredSecretsStore | undefined;

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
			const rows = requireStore();
			if (ctx.actor !== undefined) {
				const personal = await rows.get("personal", ctx.actor, name);
				if (personal) return materialOf(personal);
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
				if (orgWide) return materialOf(orgWide);
			}
			return null;
		},
	};

	const configure = (
		context: EuroclawPluginConfigureContext,
	): EuroclawPlugin | undefined => {
		if (context.adapter) {
			store = createStoredSecretsStore(context.adapter, { now: options.now });
		}
		return undefined;
	};

	return {
		id: options.id ?? "euroclaw.secret-store",
		$HasCron: "no-cron",
		$RequiresDatabase: true,
		schema: storedSecretModels,
		secretProviders: [provider],
		configure,
	};
}
