# AI SDK UI bridge — `useChat` against a claw

Status: **designed for ai@7 (verified 2026-07-13), SEQUENCED AFTER docs/plans/claw-client-plan.md**
(Konstantin, 2026-07-13: the better-auth-shaped client comes first; this bridge's transport then
rides the client's fetch/auth seam instead of a bare DefaultChatTransport). Slice A otherwise
ready to build. Goal: a claw
endpoint the AI-SDK client hooks (`useChat`, `@ai-sdk/react`) consume natively — the standard
fullstack chat DX over a governed runtime. The repo is on `ai@7.0.22`, fixtures on the V4 model
spec, and the slice-2 redaction read path (`view`, `$context.redaction`) is on main — this plan
assumes all three.

## Verified v7 surfaces (ai-sdk.dev, 2026-07-13)

- **Server**: `createUIMessageStream` (exported from `"ai"`) — `execute({ writer })` with
  `writer.write(part: UIMessageChunk)` (typed parts: `text-start/delta/end`, tool parts, data
  parts) and `writer.merge(stream)`; `createUIMessageStreamResponse` /
  `pipeUIMessageStreamToResponse` wrap it with the correct SSE headers. The bridge hand-rolls
  NO wire format — it writes typed chunks and lets the SDK own the protocol.
- **Client**: `useChat({ transport: new DefaultChatTransport({ api }) })`, `sendMessage({ text })`.
  Tool parts render as `tool-${toolName}` with states; an approval renders as
  `state: 'approval-requested'` carrying `part.approval.id`, answered by
  `addToolApprovalResponse({ id, approved })`. Client-executed tools use `addToolOutput`.
- **The approval id is ours to choose** → carry the busyclaw `approvalId` verbatim, and the
  native client flow round-trips it with zero custom UI plumbing.

## Slice A — event-driven bridge (no runtime/core changes)

Home: **new package `packages/adapter/ai-sdk` (`@busyclaw/adapter-ai-sdk`)** — mirrors
adapter-nextjs's posture (depends on the product package + peer `ai ^7`). adapter-core stays
`ai`-free; vendors stays authoring-only.

Existing surfaces it composes (all on main today): `api.sendMessage({ runId })` accepts a
pre-allocated runId; every event envelope carries `runId`; event payloads are redacted;
approvals park durably; `api.continueRun` resumes with recording; `listMessages({ view })` and
`$context.redaction` for the original view.

### API (settled 2026-07-13) — three exports

```ts
const chat = clawChat();                       // BEFORE createClaw (the ordering cycle is real:
const claw = createClaw({ events: [chat.events], … });   // sink before claw, claw before handler)
export const POST = chat.handler(claw, {
  authorize: async (request, hint /* client body values — UNTRUSTED */) => {
    // return authorized coordinates, or a Response (401/403) to short-circuit
    return { clawId, threadId, principal, view? };
  },
});
const initial = toUIMessages(records);         // pure mapper: MessageRecord[] → UIMessage[]
```

- `clawChat(): { events: RuntimeEventSink; handler(claw, options): (req: Request) => Promise<Response> }`
- **`authorize` is REQUIRED** — mounting an unauthenticated user-facing endpoint is
  unrepresentable. It owns `clawId`/`threadId` (client body is a `hint` to validate, never
  trusted), `principal` (feeds `grantApproval.by`, the reidentification audit, later the PEP),
  and `view` (server-decided; a client can never request `"original"`).
- Approvals need zero host code: the handler detects the tool-approval-response part, maps
  approved → `grantApproval({ by: principal })` + `continueRun` (streamed), denied →
  `denyApproval`.
- Deliberately NOT a plugin yet: plugin routes sit outside host auth today; after app-authz a
  plugin form can wrap this same handler.

Mechanics behind that surface:

1. **The broker** (`chat.events`) — a `RuntimeEventSink` fanning events out per `runId`;
   the handler subscribes BEFORE `sendMessage` — no missed events.
2. **The handler** → `(request: Request) => Promise<Response>`:
   - POST body: `useChat`'s message payload plus host fields (`clawId`, `threadId`) via the
     transport's request preparation; the handler takes the LAST user message's text.
   - If the last message carries a **tool-approval-response part** → `api.grantApproval` /
     `denyApproval` (by = the authenticated principal the HOST resolves) + `api.continueRun`,
     and stream the continuation. Otherwise → new `runId`, subscribe, `api.sendMessage`.
   - Translation inside `createUIMessageStream`'s `execute`:
     `run.started` → `start`/`start-step`; `tool.called` → tool input part (redacted args
     verbatim); `tool.completed` → tool output part (redacted output verbatim);
     `tool.waiting_approval` → the approval-requested part with `approval.id = approvalId`;
     `tool.denied`/`tool.failed` → `data-governance` part (a denial is a governed outcome, not
     a transport error); awaited `sendMessage` result → one `text-start`+`text-delta`+`text-end`
     block, `finish-step`, `finish`. Step-granular by design; tools and approvals appear live.
3. **Views**: default wire = redacted (leak-free by construction — the bridge only rebroadcasts
   already-governed events; a `streamText`-direct backend cannot make this claim). Host opts
   into `view: "original"` per request (same trust model as slice 2): rehydrate COMPLETE parts
   via `$context.redaction.original` before writing — part granularity has no split-token
   problem — and land ONE `pii.reidentification` audit record per stream.
4. **History**: `toUIMessages(records)` mapper (`listMessages({ view })` → `UIMessage[]`) so
   `useChat` hydrates persisted transcripts; tool-call/result records map to their part types.
5. **Verify at build (the one open detail)**: the exact POST body shape `DefaultChatTransport`
   sends when `addToolApprovalResponse` fires (which message/part carries the response) —
   documented flow, but pin the field names against the installed `@ai-sdk/react` types, not
   the docs prose.

Tests: broker isolates concurrent runs; golden stream (part order, headers via
`createUIMessageStreamResponse`, `[DONE]`); raw email never on the default wire; original view
rehydrates + audits once; approval part carries the busyclaw approvalId and the grant path
streams the continuation; denial → `data-governance`, stream still finishes cleanly.

## Slice B — true token streaming (runtime work, wire unchanged)

The loop is `generateText`-per-step; token deltas need: a `doStream` path in the loop emitting
`LanguageModelV4StreamPart`s, middleware `wrapStream` (prompt redaction via `transformParams`
already applies to both), a stream-aware governance model boundary (gates BEFORE the first
token, audit on finish), and — for original-view streaming only — a placeholder-boundary
rehydration buffer (a `{{pii:…}}` token can split across chunks; hold back the longest suffix
matching a token prefix). Strictly after A: the client contract never changes, B swaps
one-delta-per-step for token deltas under the same parts.

## Non-goals

- No client-side governance, ever — the client is untrusted; sealed gates stay server-side
  (mercury rule). The bridge only rebroadcasts governed events.
- No parallel event schema — the bridge TRANSLATES runtime events; it never grows a lifecycle
  the runtime doesn't emit.
- No `@ai-sdk/react` dependency server-side — the client hook is the consumer's dependency;
  the bridge speaks the wire via `ai`'s stream helpers only.
