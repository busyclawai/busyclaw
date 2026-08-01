# busyclaw

**An open-source claw built around a permissions engine.**

> 🚧 **Pre-alpha.** Nothing is published to npm, the APIs change without notice, and there has
> been no external security review. This README says what is built and what is not. It is not
> something you can integrate today.

busyclaw is an AI agent runtime you embed in your own app, running on *your* auth, *your*
database and *your* policy. Every model call and every tool call passes a permissions gate, PII
redaction and a tamper-evident audit log on the way through — by construction, so the agent
cannot act around your rules.

The permissions engine is the core. Everything else was built outward from it. Compliance
regimes (GDPR, the EU AI Act, HIPAA) are meant to be opt-in plugins on top, never the product.

## Why

A system prompt is advice, and advice does not stop an API call. Agents have deleted production
databases while holding a token scoped for something else entirely, with a rule in the prompt
telling them not to. Enforcement has to live where the call is made — in the token, in the gate,
in the handler — not in a paragraph the model is asked to obey.

So busyclaw puts three things in the hot path and leaves them on by default.

- **It can't leak.** Personal data is replaced with stable placeholders before anything reaches a
  model, and rehydrated on the way back. Real values live in a vault, so erasing a person is one
  key delete. Streamed deltas are rehydrated too, with a boundary buffer so a placeholder can
  never be split across two chunks.
- **It can't destroy.** Every tool call is authorized against Cedar policies before it runs, under
  a floor no plugin can remove. Point the runtime at an OpenAPI spec and it imports the tools with
  policies attached, so a call is decided per tool and per argument. The token could delete it; the
  principal cannot.
- **It can't spend.** A run can suspend and wait for a human, holding the exact arguments it is
  about to execute. The approval is bound to those arguments and that tool version, is single-use,
  and cannot be replayed against a different action.

## What it looks like

```ts
import { createClaw } from "busyclaw"
import { regexDetector } from "@busyclaw/detectors/regex"

const claw = createClaw({
  model,                                  // any Vercel AI SDK model
  database: pool,                         // pg Pool, Kysely, Drizzle, Prisma or a Mongo client
  redaction: { detectors: [regexDetector] },
})
```

Mount the whole API surface in one route — base methods, every plugin namespace, plugin and
channel routes, the cron trigger, and `openapi.json`:

```ts
import { toNextJsHandler } from "@busyclaw/adapter-nextjs"

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(claw, {
  basePath: "/api/busyclaw",
  openApi: true,
  resolveCaller,   // your verified session → a principal
})
```

`resolveCaller` is not optional in practice. Without it the policy enforcement point has no
authenticated identity and every governed call fails closed with a 403. The handler itself is
framework-agnostic; the Next.js binding is a thin wrapper over it.

Streaming is the one method with no mounted route, because SSE is a different transport and
busyclaw declines to guess one for you. It is a few lines in your own handler:

```ts
import { toUIMessageStreamResponse } from "@busyclaw/vendors/ai-sdk"

const stream = await claw.api.stream({ prompt }, { principal })
return toUIMessageStreamResponse(stream)
```

What the reader sees is not what the model saw.

## What's built

Implemented and green internally. Still not a consumable product.

- **Permissions engine** — Cedar policies evaluated on every tool call and on the product API
  itself, generic over owner, scope and grant, ordered `read < use < manage`, fail-closed. Grants
  are data, so sharing is an insert rather than a policy rebuild. Identity fields are stamped from
  the caller and cannot be set from a request body.
- **PII redaction** — a detector port with two implementations: regex with checksum validation
  (Luhn, mod-97) and a Presidio-backed recognizer. Placeholders are stable per container, with a
  keyed dedup index so two mentions of one person stay one person, and a recoverer that repairs a
  placeholder a model has mangled.
- **Durable execution** — a SQL engine with leases, heartbeats, retries, dead-lettering, lease
  recovery and approval park/resume. A run survives a crash without losing or repeating work. No
  Temporal required.
- **Tamper-evident audit** — hash-chained and fail-closed, kept separate from operational logs.
- **Approvals** — bound to the tool version and the arguments shown to the approver, single-use,
  with an explicit choice of whether an approval attests to the requester's action or lends the
  approver's own authority to it.
- **Storage** — an adapter port with Kysely, Drizzle, Prisma and MongoDB implementations, a typed
  entity layer where the model name drives the row type, and schema generators tested against the
  real upstream libraries rather than fixtures. `busyclaw db generate` and `busyclaw db migrate`
  ship in the CLI.
- **Egress and sandboxing** — governed outbound calls, and a QuickJS/WASM sandbox for agent-run
  code with host resource limits.
- **Secrets** — one resolver path, an encrypted store, and a keyring so a compromised master key
  rotates without re-encrypting everything.
- **Channels** — Telegram, with crash-safe delivery: the reply is persisted before it is sent, so
  a crash mid-send neither loses nor duplicates a message.
- **Multi-model routing** — a named model pool selected per call, with per-model trust, so a model
  you host yourself can see raw values while everything else sees placeholders.
- **Observability** — typed lifecycle events, usage and durations, plugin event sinks, and an
  OpenTelemetry exporter.

## What's not built

- **The cloud.** Fleet management and the admin plane do not exist in this repository.
- **Organizations and multi-tenancy.** The seam is there and deliberately empty; scope-anchored
  decisions fall back to owner and grants until a plugin supplies memberships.
- **`@busyclaw/eu`** — the GDPR and EU AI Act plugin, the flagship regime.
- **Memory across turns.** Messages are stored, but earlier turns are not fed back to the model
  yet, so it is effectively single-turn.
- **Skills.** Built, found to have a live authorization hole, and deleted rather than patched
  around. The rewrite goes on top of the permissions engine instead of beside it.
- **MCP**, **sub-agents with capability attenuation**, **channels beyond Telegram**, **signed
  plugins**, and **retrieval treated as an inbound redaction boundary**.
- **Anything on npm.** Every package name here 404s today.

## Packages

| | |
|---|---|
| `busyclaw` | the assembly: `createClaw`, the API, the enforcement point |
| `@busyclaw/runtime` | the governed agent loop |
| `@busyclaw/contracts` | the protocol layer everyone imports |
| `@busyclaw/core` | the governance and privacy engine |
| `@busyclaw/authz` | the decision engine and Cedar evaluation |
| `@busyclaw/detectors` | `/regex` and `/presidio` |
| `@busyclaw/engine-sql` | durable execution |
| `@busyclaw/storage-*` | `kysely`, `drizzle`, `prisma`, `mongodb`, `durable`, `core` |
| `@busyclaw/adapter-core`, `@busyclaw/adapter-nextjs` | the HTTP surface |
| `@busyclaw/client`, `@busyclaw/cli`, `@busyclaw/vendors` | typed client, CLI, AI SDK bridge |
| `@busyclaw/channels`, `@busyclaw/secrets-plugin`, `@busyclaw/sandboxes`, `@busyclaw/escalations` | plugins |
| `@busyclaw/policy-cedar` | policy sources |
| `@busyclaw/egress`, `@busyclaw/otel`, `@busyclaw/errors` | supporting |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

`examples/nextjs-demo` shows the whole server-side integration: one config, one mounted route,
one hand-written streaming route.

## Security

Findings get triaged, fixed, and locked down with a regression test verified to fail without the
fix. The reviews so far have been self-run rather than third-party, and that distinction is worth
keeping straight. If you find something, please open an issue.

## License

MIT — see [LICENSE](LICENSE).
