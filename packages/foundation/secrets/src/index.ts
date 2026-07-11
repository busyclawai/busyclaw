// The secret resolver — euroclaw's ONE door for credential material. Every subsystem (the tool
// invoker, sandbox egress, channels) resolves through `Secrets.get(name)`, so an org's alias is
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
// The per-org DB-alias layer sits ABOVE this and is OPT-IN: pass `buildSecrets(providers, { aliases })`
// and a per-org pointer WINS over the inline chain. Absent it, resolution is exactly as before —
// buildSecrets stays back-compatible. See docs/plans/secrets-per-org-aliases.md.

import {
	configurationError,
	type ResolveContext,
	type SecretAliasPointer,
	type SecretMaterial,
	type SecretProvider,
	type Secrets,
} from "@euroclaw/contracts";

export type EnvOptions = {
	/** Provider key. Defaults to `"env"`; set it only for a 2nd env-like provider or a clearer key. */
	name?: string;
	/** The environment map to read. Defaults to the env GLOBAL (`globalThis.process?.env`) — no
	 *  `node:process` import, so foundation-safe. An edge runtime without `process.env` reads `{}`. */
	source?: Record<string, string | undefined>;
	/** Per-provider remap of euroclaw's canonical name → this backend's key; pass-through if absent. */
	aliases?: Record<string, string>;
};

/** The environment-variable secret provider: reads a plain token out of the env map. Get-only
 *  (`capability.manage: false`) — euroclaw never writes env vars. `source` is captured at call time
 *  from the env global unless one is passed, so no `node:*` is imported. */
export function env(options: EnvOptions = {}): SecretProvider {
	const source =
		options.source ??
		(globalThis as { process?: { env?: Record<string, string | undefined> } })
			.process?.env ??
		{};
	return {
		name: options.name ?? "env",
		aliases: options.aliases,
		capability: { manage: false },
		get: async (ref: string): Promise<SecretMaterial | null> => {
			const value = source[ref];
			return value == null ? null : { kind: "token", value };
		},
	};
}

/** A per-org DB-alias lookup the resolver consults BEFORE the inline chain — a plain closure so
 *  @euroclaw/secrets stays storage-agnostic (the alias store lives in @euroclaw/storage-durable).
 *  Returns the pointer for `(organizationId, name)`, or `null` when the org has no alias for it.
 *  THROWS for infrastructure failure (e.g. the `secret_alias` table isn't migrated) — the resolver
 *  propagates that loud rather than falling through to a possibly-WRONG credential. */
export type SecretAliasLookup = (
	organizationId: string,
	name: string,
) => Promise<SecretAliasPointer | null>;

export type BuildSecretsOptions = {
	/** Opt-in per-org DB-alias layer. When present, `get(name, { organizationId })` first asks it for
	 *  a pointer; a hit WINS (routes `registry[pointer.provider].get(pointer.ref)`), no fall-through.
	 *  Absent org ⇒ the layer is skipped (deployment default only). */
	aliases?: SecretAliasLookup;
};

/**
 * Build the one-door resolver over an ordered provider chain. The default `[env()]` IS the "absent
 * `secretProviders` → read env" default: `buildSecrets()` returns an env-backed resolver with zero
 * config.
 *
 * `get(name, ctx)`:
 *   0. **per-org DB alias** (only with `options.aliases` AND `ctx.organizationId`): look up a pointer;
 *      a hit is resolved through `registry[pointer.provider].get(pointer.ref)` and WINS — its material
 *      (or `null`) is returned, never falling through to the chain. The org pointed here explicitly.
 *   1. else **inline chain**: for each provider IN ORDER remap the canonical `name` through that
 *      provider's own `aliases` (pass-through when absent), then `await provider.get(key, ctx)`; the
 *      FIRST non-null material wins.
 * `null` when nothing resolves it — the caller fails loud if it required it.
 *
 * Provider `name`s must be DISTINCT across the chain — a duplicate is a `configurationError` thrown
 * loud at build time (the connection/audit key must be unambiguous).
 */
export function buildSecrets(
	providers: SecretProvider[] = [env()],
	options: BuildSecretsOptions = {},
): Secrets {
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
	const providerByName = new Map(providers.map((p) => [p.name, p]));
	const { aliases } = options;

	const get = async (
		name: string,
		ctx: ResolveContext = {},
	): Promise<SecretMaterial | null> => {
		// Layer 0 — DB-wins. Only with the per-org layer AND an org in context. A missing table throws
		// out of `aliases` (fail loud); a real pointer is resolved through its provider and returned as
		// the answer, hit or miss — we do NOT fall through, or a stale/wrong direct value could win.
		if (aliases && ctx.organizationId !== undefined) {
			const pointer = await aliases(ctx.organizationId, name);
			if (pointer) {
				const provider = providerByName.get(pointer.provider);
				// A dangling pointer (provider not in the chain) resolves to null — the caller fails loud
				// with a configure-your-credential error rather than silently using another provider.
				if (!provider) return null;
				// pointer.ref is already the backend key — the provider's own alias remap does NOT apply.
				return provider.get(pointer.ref, ctx);
			}
		}
		for (const provider of providers) {
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
