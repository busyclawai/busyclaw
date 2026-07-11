# @euroclaw/secrets

The secret resolver — euroclaw's ONE door for credential material. Every subsystem (the tool
invoker, sandbox egress, channels) resolves through `Secrets.get(name)`, so an org's alias is
respected once, not remembered per-subsystem. euroclaw stores NO secret values — a provider
resolves each on demand from where it actually lives (env / vault / SSM …).

This package ships the `env()` provider and the `[env()]` default only:

- `buildSecrets(providers = [env()])` — the one-door resolver over an ordered provider chain. The
  default `[env()]` IS the "absent `secretProviders` → read env" default: `buildSecrets()` returns an
  env-backed resolver with zero config. `get(name, ctx)` remaps the canonical `name` through each
  provider's own `aliases` (pass-through when absent), then returns the FIRST non-null material down
  the chain; `null` when unresolved (the caller fails loud if it required it). `has(name, ctx)` is
  the boot-coverage probe. Provider `name`s must be DISTINCT — a duplicate fails loud
  (`configurationError`).
- `env(opts?)` — the environment-variable provider. Reads a plain token out of an env map. Get-only
  (`capability.manage: false`) — euroclaw never writes env vars. `name` defaults to `"env"`;
  `aliases` remap a canonical name → backend key.

**Node-free by design.** `env()` reads the env GLOBAL (`globalThis.process?.env`) — it imports no
`node:*`, so it is foundation-safe and a plugin (sandboxes) can apply it. On an edge runtime without
`process.env` (Cloudflare Workers) it resolves nothing, so those deployments pass their own provider;
the env default is Node-oriented and overridable.

The alias + chain layers here are the deployment-alias + registry precedence. The per-org connection
layer sits ABOVE this (a later slice), as do SM adapters other than `env` (vault / SSM / 1Password).
See `docs/plans/secrets-provider-registry.md`.
