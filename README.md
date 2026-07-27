# busyclaw

**An embeddable, governed AI agent runtime.**

> 🚧 **Pre-alpha — not usable yet.** Nothing here is published or stable, APIs change
> without notice, and there's no security review or support. This README describes where
> busyclaw is going and what's built so far — **not** something you can integrate today.

busyclaw is the agent layer you'd otherwise be nervous to build yourself: an autonomous AI
runtime that embeds inside your app and acts through *your* auth, *your* database, and *your*
policy engine. The aim is that every model call and tool call passes through redaction, policy
gates, optional human approval, and a tamper-evident audit trail — **by construction**, so the
agent can't act around your rules.

Governance is the core; compliance regimes (EU GDPR + AI Act, HIPAA, …) are meant to be opt-in
**plugins**, not the product.

## The idea

Shipping an agent that touches real user data is a minefield — PII leaking to the model, tools
doing things nobody approved, no record when something goes wrong, and "delete my data" being a
nightmare. busyclaw's bet is that those controls belong in the runtime's hot path, not in prompt
instructions or config you can forget to set:

- **Redact at the edge.** PII is replaced with placeholders the moment it arrives; real values
  live in a vault and reattach only inside the tool that needs them — the model provider never
  sees them. Erasing a person is one key delete.
- **Gate every action.** Policy gates can permit/deny model and tool calls; tool calls can also
  pause for durable human approval. Your rules, your policy engine.
- **Audit, tamper-evident.** Governed calls land in a hash-chained, fail-closed audit log, kept
  separate from operational logs.
- **Provable, not claimed.** A compliance plugin can mark a gate *sealed*: the core runs sealed
  gates ahead of ordinary ones and prevents replacing them, so nothing can short-circuit the
  floor.

## What's built so far

Working, tested building blocks — implemented and green internally, **not** a consumable product:

- **Governance core** — redact-at-edge + PII vault, ordered and sealed policy gates, durable
  approvals, hash-chained audit, one-key subject erasure.
- **Runtime** — a governed agent loop: model and tool calls through the fail-closed boundary,
  approval park/resume, typed lifecycle events.
- **Durable SQL engine** — leases, heartbeats, retry/dead-letter, lease recovery, and approval
  park/resume; no Temporal required.
- **Storage** — an adapter port + durable stores, with Drizzle / Kysely / Prisma / MongoDB /
  SQLite adapters (SQLite is the tested path).
- **Policy & identity** — pluggable authz (Cedar, better-auth) and identity resolution
  (actor + team/role).
- **API & adapter surface** — a typed API, a framework-agnostic request handler, a Next.js
  binding, and a typed client.

The workspace typechecks and the test suite is green (200+ tests), including end-to-end
integration tests of the real stack — only the LLM is mocked.

## How it'll work (target API — will change)

```ts
const claw = createClaw({
  model,                 // any Vercel AI SDK model
  database: db,          // your database
  policy: cedarPolicy(), // your authz
  redactor,              // PII handling
})

// mount it (Next.js shown; the handler is framework-agnostic)
export const { GET, POST } = toNextJsHandler(claw)
```

The pieces above exist and pass tests — but wiring them up as a real integrator isn't done yet
(see below).

## What's missing (the gap to a usable alpha)

- **No auth at the HTTP edge** — the mounted routes have no authN/Z yet. Not safe to expose.
  *(Deferred on purpose.)*
- **The agent is single-shot** — no memory across runs; multi-turn + compaction is the active
  build.
- **No streaming** — responses come back whole, so no token-by-token UIs.
- **Unsettled APIs** — expect breaking changes.

### PII detection is weak right now

The redaction *machinery* is solid (vault, deterministic placeholders, subject erasure) — but the
actual PII **detection is poor today**. The default detector is effectively a no-op, so for now
you have to bring your own. The plan is real ML-based detection (e.g. a
[Presidio](https://github.com/microsoft/presidio)-style recognizer) and/or a clean
bring-your-own-detector seam. Until then, don't rely on the built-in redaction to catch sensitive
data.

## Not started yet

- **`@busyclaw/eu`** — the GDPR / EU AI-Act compliance plugin (the flagship regime).
- **`@busyclaw/memory`** — governed recall / write / erase.
- **`@busyclaw/skills`** — manifest-declared capabilities where `allowed_tools` is enforced
  mechanically, not by prompt text.
- **More framework adapters** — beyond Next.js (Express, Hono, …).
- **Risky capabilities** — filesystem, shell, browser, MCP, WASM, each reporting its real
  isolation posture.
- **A self-firing scheduler** — today's cron is pull/drain only.
- **A Temporal-based durable engine** (`@busyclaw/engine-temporal`) — for long-running
  enterprise workflows, alongside the default SQL engine.

## License

MIT — see [LICENSE](LICENSE).
