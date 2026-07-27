# Redaction coherence — deterministic placeholders, redact-at-ingress, and the model contract

Status: **designed, ready to build**. Three slices, buildable in order; slice 1 is the load-bearing one.
Layer: `@busyclaw/contracts` (schema + port), `@busyclaw/core` (redactor), `@busyclaw/storage-durable` (store), `@busyclaw/runtime` (loop/middleware), `busyclaw` (system fragment). No new packages.

## Problem

Placeholders are minted **random per span occurrence** (`packages/foundation/core/src/redact.ts:31-33`, minted in the span loop at `:148-160` with no lookup by value), and redaction runs **repeatedly over the same content**:

- the model middleware re-redacts the FULL prompt on every step (`packages/runtime/src/model-middleware.ts:17-23`),
- the loop re-redacts the full transcript for events each step (`packages/runtime/src/ai-sdk-loop.ts:124`),
- the yield checkpoint redacts the transcript again (`ai-sdk-loop.ts:263-267`),
- each event payload redacts independently (`packages/runtime/src/runtime.ts:519-524`),

while the in-memory transcript keeps RAW content (user prompt at `ai-sdk-loop.ts:93-95`, tool outputs pushed raw at `:244-246`). Four consequences:

1. **Coreference breaks** — the same email in the user message and in a tool result gets two different opaque placeholders; the model cannot know they are the same entity. This is a correctness hazard, not a style tax.
2. **Artifacts disagree** — the model prompt, the audit event, and the checkpoint each mint their own placeholder for one value. A reviewer cannot line them up.
3. **Provider prompt cache is busted** — past messages change text between steps (fresh placeholders each re-redaction).
4. **Mapping-store bloat** — O(steps × values × artifacts) rows for what is one (value, container) fact.

Separately, the model is never TOLD the placeholder contract; nothing says the tokens are stable, opaque, and to be passed to tools verbatim.

## Design

### Slice 1 — deterministic placeholders (dedup at mint)

One (value, kind, container) → one placeholder, forever (until erased).

**Chosen mechanism: store lookup-or-mint, NOT hash-derived placeholders.** The placeholder stays random (`randomBytes`); determinism comes from finding the existing mapping before minting. Rationale: rehydration correctness must never depend on key lifecycle. With lookup-or-mint, losing/rotating the index key degrades only dedup (new placeholders start fresh); a placeholder that IS a keyed hash would tie coherence and auditability to key custody and make rotation a semantic break.

- **Schema**: add `originalHash` to `piiMappingFields` (`packages/foundation/contracts/src/governance/redact.ts:50-61`) — `field.string({ required: true, index: true })`. Value = HMAC-SHA256(`kind + "\0" + original`) with a host-supplied index key. Keyed, because an unkeyed hash of low-entropy PII (phone numbers) in the DB is an offline dictionary attack. `@noble/hashes` is already a core dep.
- **Key**: `createStoredRedactor({ indexKey?: string })` — plain option, host sources it (env / one-door; suggest `BUSYCLAW_PII_INDEX_KEY`). **No key → no dedup**: mint random exactly as today and `console.warn` once at construction. Fail-soft and honest; never fail rehydration over the key.
- **Port**: `PiiMappingStore` gains `findByHash(originalHash: string, ctx?: RehydrationContext) => PiiMapping | null | Promise<...>` (`contracts/src/governance/redact.ts:87-101`). Container-scoped like `resolve` — cross-container lookups must miss, preserving unlinkability across containers.
- **Redactor** (`core/src/redact.ts:133-165`): per span → hash → `findByHash` in container → hit: reuse `placeholder`, `save` only to append missing subject rows; miss: mint random, save with hash. Placeholder format gains the kind: `{{pii:<kind>:<hex>}}` — widen `PLACEHOLDER` (`redact.ts:22`) and `newPlaceholder(kind)`.
- **Durable store** (`packages/storage/durable/src/pii.ts:60+`): implement `findByHash` (indexed read + `sameContainer` filter, same shape as `resolve`); dedup subject-junction rows in `save` (today `db.create` unconditional → duplicates). Memory store (`core/src/redact.ts:35-79`) mirrors with a `hash→placeholder` map per container.
- **Erasure invariant** (test it): `deleteForSubject` removes the row incl. its hash → the value REAPPEARING after erasure misses the lookup and gets a fresh placeholder; old placeholders stay permanently inert. Dedup must never resurrect erased mappings. Multi-subject stays existing semantics: one row, junction rows per subject; erasing one subject kills the value for all (documented "multi-subject safe").
- **Privacy note**: within-container placeholder equality is the goal (that's coreference); cross-container linkage stays broken (scoped lookup + random tokens). Keyed hashing is pseudonymization in the GDPR Art. 4(5) sense.
- **Format consumers** (grep `\{\{pii` — this list is the checklist): `core/src/redact.ts` (regex + mint), tests with literal fixtures — `storage/durable/tests/durable.test.ts`, `claws.test.ts`, `run-checkpoint.test.ts`, `plugins/sandboxes/tests/pii-through-sandbox.test.ts` (note `:118` references a runtime-side placeholder scan — audit that scanner for the widened format). Pre-alpha: no data migration, schema lands via the generate CLI.

### Slice 2 — redact at transcript ingress (delete the re-redaction)

Content is redacted ONCE, when it enters the transcript; everything downstream reads placeholder-clean text.

- Redact the user prompt before `messages` init (`ai-sdk-loop.ts:93-95`; reuse for the `run.started` event, `runtime.ts:856`).
- Redact tool output before the `toolResultMessage` push (`ai-sdk-loop.ts:244-246`). Assistant messages are already placeholder-clean (the model only ever saw placeholders).
- Delete the per-step full-transcript re-redaction (`ai-sdk-loop.ts:124`) and the checkpoint-time re-redaction (`:263-267` persists as-is) — pre- and post-yield transcripts become identical by construction.
- Keep redacting tool ARGS (model output can contain novel raw PII it composed); with slice 1 this is idempotent with governance's own edge redaction (`governance.ts:461-464`), so double-redaction is harmless.
- **Keep the model-middleware redact as a fail-closed backstop** (`model-middleware.ts:17-23`): it catches any raw string a future bug slips into the transcript, and with slices 1+2 it is idempotent (placeholders don't re-fire; stragglers dedup to stable tokens). Cost = a detector scan per step; dirty-tracking optimization deferred until measured.

Net: model prompt = events = audit = checkpoint = sandbox-visible messages, all with the same placeholder text; per-step redaction cost drops from O(transcript) to O(new content); provider prompt cache stops being invalidated.

### Slice 3 — the model contract

When redaction is armed (a detector is present), the assembly appends one fixed system fragment: placeholders are opaque stable tokens of the form `{{pii:<kind>:<id>}}`; the same token always denotes the same value; pass tokens to tools verbatim; never invent or alter one. A constant in the `busyclaw` assembly — no config knob until a real consumer needs to override (lean-config). Tools need nothing: boundary rehydration is already automatic (`governance.ts:348-350`).

## Non-goals / standing decisions

- **No per-message posture.** A mixed raw/placeholder transcript for the same entity is the incoherence this plan removes. Posture stays per claw row, immutable at creation (see busyclaw routing-redactor design, 2026-07-12); this plan composes — strict rows gain coherence, raw rows are untouched.
- **No hash-derived placeholders** (decided above). No detector changes; detector policy (per-kind, precision) is orthogonal.

## Tests (minimum)

Same value twice in one text → one placeholder; across steps → same; across artifacts (prompt vs event vs checkpoint) → byte-same transcript text; cross-container → distinct placeholder, inert on travel; post-erasure reappearance → NEW placeholder, old resolves null; shared value, two subjects → one mapping + two junction rows, no junction dupes; no `indexKey` → warns once, behaves as today; kind appears in token, widened regex round-trips; sandbox leak test passes on new format; yield → resume transcript byte-identical; middleware backstop redacts an artificially injected raw string.

## Verification gate

The port + schema change touches contracts: run FULL `turbo typecheck` + full test suite + repo-wide consumer grep **including tests/** (typecheck skips them). Consumer list as of 2026-07-12: contracts, core, storage-durable, and tests in runtime (`runtime`, `yield`, `subinvoke`), channels (`integration`), sandboxes (`pii-through-sandbox`), busyclaw (`fixtures`), core (`governance`, `model-boundary`), durable (`durable`, `claws`, `run-checkpoint`).
