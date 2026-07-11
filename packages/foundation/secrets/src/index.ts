// The secret resolver — euroclaw's ONE door for credential material. Every subsystem (the tool
// invoker, sandbox egress, channels) resolves through `Secrets.get(name)`, so an org's remap is
// respected once, not remembered per-subsystem. euroclaw stores NO secret values — a provider
// resolves each on demand from where it actually lives (env / vault / SSM …).
//
// This package ships the `env()` provider and the `[env()]` default only. `env()` reads the env
// GLOBAL (`globalThis.process?.env`) — it imports no `node:*`, so it is foundation-safe and a
// plugin (sandboxes) can apply it. On an edge runtime without `process.env` (Cloudflare Workers)
// it resolves nothing, so those deployments pass their own provider; the env default is
// Node-oriented and overridable.
//
// The alias + chain layers here ARE the "deployment alias" + "registry" precedence from the spec.
// The DYNAMIC tier (per-user/per-org rows) is not a resolver layer — it is a data-tier PROVIDER in
// this same chain (the secret-store plugin). See docs/plans/secrets-provider-registry.md.

import {
	configurationError,
	type ResolveContext,
	type SecretMaterial,
	type SecretProvider,
	type Secrets,
} from "@euroclaw/contracts";

export type EnvOptions = {
	/** Provider key. Defaults to `"env"`; set it only for a 2nd env-like provider or a clearer key. */
	name?: string;
	/** The environment variables to read — they ARE env vars, so the literal name (and it avoids the
	 *  codebase's other `source` meanings: spec source, `req.source`; wrangler calls this `vars` too).
	 *  Defaults to the env GLOBAL (`globalThis.process?.env`) — no `node:process` import, so
	 *  foundation-safe. An edge runtime without `process.env` reads `{}`. */
	vars?: Record<string, string | undefined>;
	/** Per-provider remap of euroclaw's canonical name → this backend's key; pass-through if absent. */
	aliases?: Record<string, string>;
};

/** The environment-variable secret provider: reads a plain token out of the env map. Get-only
 *  (`capability.manage: false`) — euroclaw never writes env vars. `vars` is captured at call time
 *  from the env global unless one is passed, so no `node:*` is imported. */
export function env(options: EnvOptions = {}): SecretProvider {
	const vars =
		options.vars ??
		(globalThis as { process?: { env?: Record<string, string | undefined> } })
			.process?.env ??
		{};
	return {
		name: options.name ?? "env",
		aliases: options.aliases,
		capability: { manage: false },
		get: async (ref: string): Promise<SecretMaterial | null> => {
			const value = vars[ref];
			return value == null ? null : { kind: "token", value };
		},
	};
}

/**
 * Build the one-door resolver over an ordered provider chain. The default `[env()]` IS the "absent
 * `secretProviders` → read env" default: `buildSecrets()` returns an env-backed resolver with zero
 * config.
 *
 * `get(name, ctx)`: for each provider IN ORDER remap the canonical `name` through that provider's
 * own `aliases` (pass-through when absent), then `await provider.get(key, ctx)`; the FIRST non-null
 * material wins. `null` when nothing resolves it — the caller fails loud if it required it.
 *
 * The order is the listing order WITHIN a tier, but `tier: "data"` providers (runtime-managed rows —
 * the secret-store plugin) always resolve BEFORE `"config"` ones (deployment infra: env/vault/ssm):
 * data beats config, as a provider property rather than a resolver special case.
 *
 * Provider `name`s must be DISTINCT across the chain — a duplicate is a `configurationError` thrown
 * loud at build time (the connection/audit key must be unambiguous).
 */
export function buildSecrets(providers: SecretProvider[] = [env()]): Secrets {
	const seen = new Set<string>();
	for (const provider of providers) {
		if (seen.has(provider.name)) {
			throw configurationError(
				"buildSecrets: duplicate secret provider name — each provider.name must be distinct",
				{ name: provider.name },
			);
		}
		seen.add(provider.name);
	}
	// A stable partition, not a sort — listing order is preserved within each tier.
	const ordered = [
		...providers.filter((provider) => provider.tier === "data"),
		...providers.filter((provider) => provider.tier !== "data"),
	];

	const get = async (
		name: string,
		ctx: ResolveContext = {},
	): Promise<SecretMaterial | null> => {
		for (const provider of ordered) {
			const key = provider.aliases?.[name] ?? name;
			const material = await provider.get(key, ctx);
			if (material !== null) return material;
		}
		return null;
	};

	return {
		get,
		has: async (name: string, ctx: ResolveContext = {}): Promise<boolean> =>
			(await get(name, ctx)) !== null,
	};
}
