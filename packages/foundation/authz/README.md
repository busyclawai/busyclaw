# @busyclaw/authz

The busyclaw authz toolkit. The protocol (the `PolicyEngine` port, the PARC request contracts, the
authorization-model types) lives in `@busyclaw/contracts`; the hot-path enforcement lives in
`@busyclaw/core`; the engines live in `@busyclaw/policy-*`. This package is the machinery between
them:

- `createPolicyPlugin` — adapt any `PolicyEngine` into a busyclaw plugin: a cross-cutting,
  deny-by-default before-gate (`mapCall → engine.authorize → GateDecision`).
- `buildAuthzModel` — assemble the canonical authorization model (actions, groups, entity types,
  a content-pinned version) from stamped tool definitions and hand-authored domain verbs.
- `projectArgs` — the JSON-Schema → Cedar projection, lossy-but-safe: one walker renders the
  policy-visible `context.args` type AND filters the runtime request to it, so schema and reality
  never disagree. Floats/unions/refs are opaque to policy (declare policy-visible amounts as
  integers — cents).
- `modelToCedarSchema` / `entitiesToCedarJson` / `actionEntitiesFromModel` — the Cedar renderings
  of the model (pure string/data generation — Cedar *validation* stays in `@busyclaw/policy-cedar`,
  which consumes these via `cedar({ model, policies })`).

Planned here (the blueprint pipeline): verb/hint → access helpers for the OpenAPI/MCP extractors,
starter-policy seeding, and the coverage checks behind the validate CLI.
