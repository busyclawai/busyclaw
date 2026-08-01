// The one-door secret resolver — `secrets.get(name)` (docs/plans/secrets-provider-registry.md). Every
// subsystem (the tool invoker, sandbox egress, channels) resolves credentials through a single
// canonical NAME, so an org's alias/provider is respected once, not remembered per-subsystem. busyclaw
// stores NO secret values: a `SecretProvider` resolves each on demand from where it actually lives
// (env / vault / SSM …). These are plain-TS ports (behaviour, not boundary data — no schema); the
// providers + reader impl live in @busyclaw/secrets. The reader returns secret MATERIAL only; HOW to
// apply it (apiKey-in-header-named-X, bearer, basic) is read from the registered spec's own
// `securitySchemes`, never from the reader. Token-minting flows (OAuth client-credentials, refresh)
// live INSIDE a provider's `get` — it returns a fresh token like any other material.

import type { Principal } from "../governance/principal";
import type { ScopeRef } from "../scope";

/** Secret material, shaped by what schemes need — never how to apply it (the spec knows that). */
export type SecretMaterial =
	| { kind: "token"; value: string }
	| { kind: "basic"; username: string; password: string };

/**
 * What a caller BINDS or PASSES — the facts a resolution may narrow on. Optional and extensible on
 * purpose: a binding is partial by definition (`.with({ principal })` knows the principal and not yet the
 * boundary), and a new fact must never be a breaking signature change.
 *
 * The boundary is ONE field holding the whole pair, not two independent halves. As two, a bound
 * `{ scope, scopeId }` merged with a later `{ scopeId }` produced a boundary neither side named — the
 * merge is per-field, so half of one key survived beside half of another. A `ScopeRef` replaces
 * atomically, which makes that unrepresentable rather than merely unlikely.
 */
export type ResolveContext = {
	/** The run's CONFIG SCOPE — the opaque `(scope, scopeId)` boundary, not an organization id: an
	 *  organization is a plugin, so core cannot name one kind of boundary in a resolution key. Omitted
	 *  means the resolution names no tenant, which {@link Secrets} reads as `UNSCOPED`. */
	configScope?: ScopeRef;
	principal?: Principal;
};

/**
 * What a PROVIDER is asked — the same facts, resolved.
 *
 * `configScope` is total here. `buildSecrets` collapses an omitted boundary to `UNSCOPED` at the one
 * door before any provider is consulted, so a provider never writes its own absent-case rule — which
 * is exactly how the deployment's credentials came to answer a tenant's miss: each layer decided for
 * itself what "no scope" meant, and one of them decided it meant "anything goes".
 *
 * The same split {@link RehydrationContext} has against `piiContainer`: partial at the caller, whole
 * at the store.
 */
export type SecretResolution = {
	configScope: ScopeRef;
	principal?: Principal;
};

/** A secret backend (Executor's `CredentialProvider`): where values actually live. busyclaw lists
 *  these as deployment infra and resolves through them — it never holds the value itself. */
export type SecretProvider = {
	/** The provider KEY — what a connection references and an audit records. The factory defaults it
	 *  (env → "env"); `buildSecrets` asserts these are DISTINCT across the chain (fails loud on a
	 *  duplicate — the connection/audit key must be unambiguous). */
	name: string;
	/** Resolve `ref` (the backend key, AFTER alias remap) to material, or `null` when this provider
	 *  has no value for it. THROW for infrastructure failure — never coerce an outage into a miss. */
	get: (
		ref: string,
		resolution: SecretResolution,
	) => Promise<SecretMaterial | null>;
	/** Per-provider remap of busyclaw's canonical name → this backend's key
	 *  (`{ CANONICAL_NAME: backendKey }`). Pass-through when absent (zero config in the happy path). */
	aliases?: Record<string, string>;
	/** get-only vs set/delete/list — declared, not assumed. `env` is get-only (`manage: false`). */
	capability: { manage: boolean };
	/** Chain tier. `"data"` = rows a user/org manages at runtime (the secret-store plugin); `"config"`
	 *  (the default when absent) = deployment infra (env/vault/ssm). `buildSecrets` resolves data-tier
	 *  providers BEFORE config-tier regardless of listing order (stable within a tier) — the
	 *  data-beats-config precedence, declared as a provider property, not special-cased. */
	tier?: "data" | "config";
	/**
	 * Canonical names this CONFIG-tier provider may answer for a TENANT-SCOPED resolution — a request
	 * whose context names a `(scope, scopeId)`. Absent or empty means none, which is the default.
	 *
	 * Config-tier providers are deployment infrastructure: an env var is the DEPLOYMENT's credential,
	 * not a tenant's. A tenant-scoped lookup that missed every data-tier provider used to fall through
	 * to env and quietly hand that tenant the deployment's own authority — its quota, its billing, its
	 * data scope, under a name the tenant chose. Nothing in the chain marked the difference.
	 *
	 * So a config-tier provider now sits out scoped resolutions unless the name is listed here, and
	 * listing it is the deployment stating "this credential is genuinely shared by every tenant" (an
	 * app-owned API key, a partner integration billed centrally). Unscoped reads — an app bot's token,
	 * a sandbox credential — never consult this list at all: they carry no tenant, so there is no
	 * tenant to lend anything to.
	 */
	shared?: readonly string[];
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
