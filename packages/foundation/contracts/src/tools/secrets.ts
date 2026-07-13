// The one-door secret resolver — `secrets.get(name)` (docs/plans/secrets-provider-registry.md). Every
// subsystem (the tool invoker, sandbox egress, channels) resolves credentials through a single
// canonical NAME, so an org's alias/provider is respected once, not remembered per-subsystem. euroclaw
// stores NO secret values: a `SecretProvider` resolves each on demand from where it actually lives
// (env / vault / SSM …). These are plain-TS ports (behaviour, not boundary data — no schema); the
// providers + reader impl live in @euroclaw/secrets. The reader returns secret MATERIAL only; HOW to
// apply it (apiKey-in-header-named-X, bearer, basic) is read from the registered spec's own
// `securitySchemes`, never from the reader. Token-minting flows (OAuth client-credentials, refresh)
// live INSIDE a provider's `get` — it returns a fresh token like any other material.

import type { Principal } from "../governance/principal";

/** Secret material, shaped by what schemes need — never how to apply it (the spec knows that). */
export type SecretMaterial =
	| { kind: "token"; value: string }
	| { kind: "basic"; username: string; password: string };

/** Context a resolution may narrow on — the org whose binding to use, the acting principal for a
 *  per-user credential. Optional and extensible on purpose: a new fact must never be a breaking
 *  signature change. */
export type ResolveContext = { organizationId?: string; principal?: Principal };

/** A secret backend (Executor's `CredentialProvider`): where values actually live. euroclaw lists
 *  these as deployment infra and resolves through them — it never holds the value itself. */
export type SecretProvider = {
	/** The provider KEY — what a connection references and an audit records. The factory defaults it
	 *  (env → "env"); `buildSecrets` asserts these are DISTINCT across the chain (fails loud on a
	 *  duplicate — the connection/audit key must be unambiguous). */
	name: string;
	/** Resolve `ref` (the backend key, AFTER alias remap) to material, or `null` when this provider
	 *  has no value for it. THROW for infrastructure failure — never coerce an outage into a miss. */
	get: (ref: string, ctx: ResolveContext) => Promise<SecretMaterial | null>;
	/** Per-provider remap of euroclaw's canonical name → this backend's key
	 *  (`{ CANONICAL_NAME: backendKey }`). Pass-through when absent (zero config in the happy path). */
	aliases?: Record<string, string>;
	/** get-only vs set/delete/list — declared, not assumed. `env` is get-only (`manage: false`). */
	capability: { manage: boolean };
	/** Chain tier. `"data"` = rows a user/org manages at runtime (the secret-store plugin); `"config"`
	 *  (the default when absent) = deployment infra (env/vault/ssm). `buildSecrets` resolves data-tier
	 *  providers BEFORE config-tier regardless of listing order (stable within a tier) — the
	 *  data-beats-config precedence, declared as a provider property, not special-cased. */
	tier?: "data" | "config";
};

/** The ONE door every subsystem resolves credentials through — built once from the provider chain
 *  and injected into the invoker, egress, and channels. `get` returns `null` when no provider
 *  resolves the name (the caller fails loud if it required it); `has` is the boot-coverage probe. */
export type Secrets = {
	get: (name: string, ctx?: ResolveContext) => Promise<SecretMaterial | null>;
	has: (name: string, ctx?: ResolveContext) => Promise<boolean>;
	/** Like {@link get} but FAILS LOUD (`configurationError` naming the secret) when nothing resolves
	 *  it — the mandatory-credential branch, packaged so callers stop hand-rolling the null check.
	 *  Pass `kind` to also require a material kind (token|basic): a wrong-kind result throws too, and
	 *  the return type NARROWS to that variant (so `.value` is reachable without a second check). */
	require: <K extends SecretMaterial["kind"] = SecretMaterial["kind"]>(
		name: string,
		options?: ResolveContext & { kind?: K },
	) => Promise<Extract<SecretMaterial, { kind: K }>>;
	/** A reader with `ctx` pre-bound onto get/has/require — the invoker's per-turn shape and channels'
	 *  endpoint threading, generalized. A later explicit ctx MERGES over the bound one (last-wins per
	 *  field), and `.with` chains (each call merges onto the accumulated ctx). */
	with: (ctx: ResolveContext) => Secrets;
};

/** A `{ provider, ref }` pointer into the provider registry — the reusable ref vocabulary store
 *  implementations share (a stored row that REDIRECTS resolution instead of holding a value).
 *  `provider` names a `SecretProvider` in the chain; `ref` is the key WITHIN that backend, passed
 *  straight to `provider.get(ref)` (already the backend key — the provider's own `aliases` remap
 *  does NOT apply on top). */
export type SecretPointer = { provider: string; ref: string };

/** A secret NAME a plugin needs — the enumerable half of the runtime `secrets.get(name)`. Plugins
 *  declare these on `plugin.secrets`; the assembly collects them across plugins into the required-
 *  names set the boot coverage warning walks. Declaration only — a declared name may still be
 *  configured later at runtime (never fails boot). */
export type SecretDeclaration = { name: string; description?: string };
