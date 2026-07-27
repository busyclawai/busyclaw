# Observability — finish the events plane

> Status: **BUILT (2026-07-14)** — slices 1–6: `fe38037` (fan-out split + catalog),
> `7bdc3a0` (plugin.eventSinks), `9b8260d` (logEvents + @busyclaw/otel), `c49d38f`
> (warn seam + plane-boundary notes), `23924a7` (door redaction), slice 6 (plugin
> redaction handles) = this commit. Grounded
> in the docs/research corpus (mastra,
> junior, nullclaw, picoclaw, hermes, zeroclaw, executor) + a full repo surface survey
> (same date).
> Scope: make the operational event stream the standardized observability plane — typed
> catalog with timing/usage, honest best-effort delivery, plugin subscription
> (docs/plans/plugin-event-sinks.md, unbuilt), and the first consumers (dev log sink, OTel
> bridge). Audit and execution-state are explicitly NOT this plane.

## The model — three planes, two already exist

Every studied claw separates operational observability from compliance audit; mastra makes
it three structurally separate planes, which is exactly busyclaw's shape already:

1. **Execution state (durable)** — claws rows (`tool_call`, `tool_result`, `checkpoint`,
   `message`) + engine-sql `run`/`task`/`run_event`. Load-bearing; never telemetry.
2. **Compliance audit (sealed)** — hash-chained `AuditSink`, boundary
   `tool | model | privacy`, redacted payloads, fires in the sealed after-gate. Never
   collapsed into OTel (mastra rule: auditors need queryable retained records, not sampled
   spans). Not touched by this plan.
3. **Operational events (best-effort)** — `EventSink` + `RuntimeEvent`. **This is the
   observability plane**, and it's the one to finish.

Standing invariants the plan preserves:

- **Events are redacted at ingress** — payloads carry placeholders, never raw PII. The
  wire is leak-free by construction (the deliberate inverse of junior's
  store-raw/redact-on-read). New event fields are counters/durations/enums only.
- **Correlation spine = `runId`** (+ `clawId`/`threadId` via the recording context) —
  junior's `gen_ai.conversation.id` lesson: one id ties events, rows, and spans together.
- **Metrics derive from events; nothing emits direct metrics** (junior rule). A cost
  ledger, a latency histogram, a Prometheus endpoint — all are sinks, not core features.

## Survey findings this plan closes (verified 2026-07-14)

1. **"Best-effort" is false today**: `emitRuntimeEvent` awaits every sink with no
   try/catch (`runtime/src/events.ts:216`, `runtime.ts:442-455`) — a throwing sink FAILS
   the run, a slow sink blocks it. The plugin-event-sinks plan's core guard was assumed,
   never built.
2. **The model boundary is invisible to events**: no `model.*` kinds exist; `res.usage`,
   `finishReason`, `providerMetadata`, `warnings` from every `generateText` call are
   dropped unread (`ai-sdk-loop.ts:105-122`). Token usage appears nowhere — no event, no
   row.
3. **No durations anywhere**: zero timing capture around model or tool calls repo-wide;
   only `createdAt`/`updatedAt` wall-clock stamps.
4. **`plugin.eventSinks` unbuilt**: plugins have the emit door
   (`plugin.ts:104`, assembly `index.ts:518`) but no subscribe surface; the contract field
   and the assembly flatMap from the plan are absent.
5. **Three error encodings**: tool throw → `{name?, message}`; denial →
   `{reason, reasonCode, decidedBy}`; model failure → thrown `stateError` → engine
   `task.lastError` string. No shared shape; model errors reach neither events nor claws
   rows.
6. **Warn chaos**: 5 scattered `console.warn|error` sites + 2 ad-hoc injectable warn sinks
   with different signatures (`core/redact.ts:110`, `busyclaw/secrets.ts:41`).
7. **Two overlapping event streams**: runtime `EventSink` (10 kinds, in-memory) vs
   engine-sql `run_event` (5 kinds, durable, engine payloads) — same names, different
   planes, boundary undocumented. (`.posthog-events.json` at the repo root is a third,
   stale intent: it references deleted files and no code emits it.)

## Design

### 1. Recording vs observers — make best-effort true by construction

Today the assembly puts persistence and telemetry in one array:
`[createClawRuntimeEventSink(clawsStore), ...eventSinksFrom(config.events)]`
(`index.ts:500-503`). But the claws sink WRITES `tool_call`/`tool_result`/`message` rows —
that's plane 1 riding the plane-3 bus. Splitting them makes the failure posture honest
instead of configured:

- **The recording sink** (internal, at most one): execution-state persistence. Awaited;
  failures PROPAGATE — a run that cannot persist its transcript must fail, same as any
  store write.
- **Observer sinks** (`config.events` + future `plugin.eventSinks`): per-sink
  try/catch in the fan-out; a throw is swallowed and reported through the warn seam (§5).
  Awaited-but-isolated (keeps ordering deterministic for tests; a pathologically slow
  observer is a host bug, not a governance hole — no timeout machinery v1).

Runtime signature: `events` config splits internally into `{ recording?, observers }`;
the public `createClaw({ events })` surface is unchanged — user sinks are observers by
definition.

### 2. Catalog completion — model events, durations, usage, one error shape

New kinds (same envelope, same redaction rules — payloads are numbers/enums only):

- `model.completed` — `{ step, durationMs, usage, finishReason }` where `usage` is the
  AI SDK v7 usage object (input/output/total tokens; reasoning/cache fields when present)
  and `finishReason` is the unified value.
- `model.failed` — `{ step, durationMs, error }`. Closes the "model errors are invisible"
  hole; emitted before the error propagates (run still fails as today).

No `model.called` v1 — nothing consumes a start marker until token streaming (slice B of
the ai-sdk bridge); add it when a consumer exists, not before.

Enriched kinds:

- `tool.completed` / `tool.failed` gain `durationMs` (clock wraps the execute call in the
  loop — the one place tools run).
- `run.completed` / `run.waiting_approval` / `run.yielded` gain `usage` — the per-step
  aggregate, so cost accounting needs only terminal events.

One error object everywhere events carry errors: `{ message, name?, reasonCode? }` —
`reasonCode` present exactly when the outcome is a governed decision, so telemetry can
always distinguish "governed no" from "infra broke" (executor lesson). `tool.denied`
keeps its richer decision fields; this normalizes `tool.failed`/`model.failed`.

Timing source: `Date.now()` deltas at the call sites in `ai-sdk-loop.ts` (model + tool)
and the resume paths in `runtime.ts`. No clock port — durations are advisory telemetry,
not ordering.

### 3. Build plugin.eventSinks — as already specced

docs/plans/plugin-event-sinks.md is settled; build it verbatim:
`eventSinks?: readonly EventSink[]` on `BusyclawPlugin`, collected statically off
`pluginList` into the observers array, re-entrancy documented (a sink must not emit).
They land AFTER §1 so plugin sinks are born isolated.

### 4. First consumers

- **`logEvents()`** in the product package — zero-dep pretty dev sink:
  `createClaw({ events: logEvents() })` prints one line per event (kind, runId short,
  tool/step, durationMs, usage). The instant-DX answer to "what is my claw doing".
- **`@busyclaw/otel`** (new leaf package, `packages/adapter/otel`) — an `EventSink` that
  maps the stream onto OTel spans using GenAI semantic conventions: one
  `gen_ai.invoke_agent` root span per `runId` (opened on `run.started`, closed on the
  terminal `run.*`), a `gen_ai.chat` child per `model.completed` (usage/finishReason as
  attributes), a `gen_ai.execute_tool` child per tool pair; denials/failures set span
  status with `reasonCode`. Peer dep: `@opentelemetry/api` only (semconv attribute names
  are string constants). No core/runtime/contracts change — proof the plane is complete:
  the bridge is JUST a sink. Waiting-approval runs end their root span on
  `run.waiting_approval` with a `waiting_approval` status attribute; the continuation is a
  new trace linked by `runId` attribute (approvals can take days — a span can't stay open).
- **Cost ledger = an example, not a package**: a ~15-line sink over `run.completed.usage`
  in the otel/logEvents test or docs. If a real consumer appears, it's still just a sink.

### 5. One warn seam

`createClaw({ warn?: (message: string) => void })`, default `console.warn`. Threaded as
the default into every existing seam: redaction's `StoredRedactorOptions.warn`, secrets'
boot-warning sink (its structured `SecretBootWarning` stays; the default formatter routes
here), the runtime tool-collision warn (`runtime.ts:421`), and the new observer-sink
failure reports (§1). Not a logger — no levels, no structure, no transport; it's the one
injectable door for "busyclaw wants to tell the operator something outside the event
stream". Existing per-surface options keep working (they win over the default).

### Slice 5 (added 2026-07-14) — door redaction

The plugin emit door (`ctx.events.emit`) redacts the plugin-authored payload BEFORE fan-out,
but only under redacted postures:

- No detector/custom redactor (the raw recipe) or posture `raw` → passthrough, byte-identical
  (the door never even walks the payload).
- `strict` → every door event: with `recording` present → into that claw's
  (`"claw"`, clawId) container — the same container the transcript write uses; claw-less
  (boot/cron/webhook) → into the emitting plugin's (`"plugin"`, id) container.
- `per-claw` → with `recording`, the claw's birth posture decides via the ONE routing
  redactor transcript writes use; claw-less FAILS CLOSED into the per-plugin container.

Each plugin gets its OWN door (the assembly binds `plugin.id` per configure context) — per-
plugin containers need attribution, never a shared bucket. The envelope (`type`, `id`,
`createdAt`, `runId`, `recording`) stays verbatim. The runtime's own kinds are unaffected
(redacted at their source boundaries; `emitRuntimeEvent` never routes through the door).

### Slice 6 (added 2026-07-14) — plugin redaction handles

Two assembly-provided methods on every plugin's configure context, bound per plugin in the same
context clone as the emit door, over the same slice-5 machinery (the ONE resolved redactor, the
same containers):

- `redact?: (value: unknown, opts?: { clawId?: string; subjectIds?: readonly string[] }) =>
  Promise<unknown>` — tokenize plugin-held data, the safe direction. No `clawId` → the plugin's
  own (`"plugin"`, id) container (exactly the slice-5 door container); with `clawId` → the claw's
  (`"claw"`, clawId) container — the SAME container transcript writes use, so the same value wears
  the same token, and per-claw birth posture decides via the one routing redactor (never a second
  posture path). `subjectIds` joins the mappings to the erasure index, so `forgetSubject` reaches
  plugin-held rows.
- `rehydrate?: (value: unknown) => Promise<unknown>` — resolves ONLY within the plugin's own
  (`"plugin"`, id) container; deliberately no `clawId` option. A claw/transcript token is INERT
  here by containment (the mapping store resolves a placeholder only within its minting container
  — structural, no token filtering). Every call against an armed redactor appends one audit record
  (boundary `privacy`, name `pii.reidentification`, status `ok`, the plugin container in the
  payload) when audit is configured; no audit → skip silently, same as the api's read-side views.

Unarmed (no detector/custom redactor, or posture `raw`) both methods are the identity function —
always present on the context, so plugin code runs unchanged in both modes.

## Non-goals

- **Unifying with engine-sql `run_event`** — that's plane 1 (durable execution state,
  engine payloads, transactional with status flips). The fix is documentation: a boundary
  note in both `events.ts` files. Same for channels' `received` persist-sink (dispatch
  state machine, not telemetry).
- **Sampling / filtering / backpressure / topic routing** — sinks see the whole stream and
  filter themselves. Mastra's NoOp-span sampling is elegant and premature here.
- **A `run` entity in the claws schema** — run-level cost/timing persistence is a sink
  concern until a product feature needs to QUERY it; revisit with that consumer.
- **Feeding plugins the audit stream** — audit ≠ events, permanent (plan rule).
- **A metrics port** — derive from events, always.
- **Event `schemaVersion`** — pre-alpha; the arktype union is the contract (hermes
  versions theirs; we adopt that only at first external consumer).

## Slices

1. **Harden + complete the catalog** (runtime + assembly): recording/observers split,
   per-observer isolation → warn seam stub, `model.completed`/`model.failed`,
   `durationMs`, `usage` on terminal run events, normalized error shape. Touches runtime
   protocol → full turbo gate + consumer grep.
   Tests: throwing observer doesn't fail the run (and warns); recording failure still
   fails it; usage/durations present on events; model failure emits then propagates;
   aggregate usage sums steps.
2. **plugin.eventSinks** (contracts + assembly): the field, the flatMap, the plan's three
   tests (receives runtime + plugin-emitted events; throwing plugin sink harmless;
   configure-closure pattern works).
3. **Consumers**: `logEvents()` + `@busyclaw/otel` + ledger example. New leaf package;
   no protocol changes.
4. **Warn seam + boundary docs**: `warn` config threaded through the 5 sites + 2 sinks;
   plane-boundary notes in `contracts/src/events.ts`, `runtime/src/events.ts`, engine
   docs; note that `.posthog-events.json` is unwired.

Order matters only for 1→2 (sinks born isolated). 3 and 4 are independent after 1.
