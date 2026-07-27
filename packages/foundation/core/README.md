# @busyclaw/core

The core product contracts and neutral governance primitives. `createGovernance({})` is a **true inert pass-through** —
no redaction, no audit, no gates. Everything is **opt-in** (a horizontal governance
framework, not an EU-only one). One governed call is:

```
validate → redact (edge, if configured) → before-gates (decide) → tool → after-gates (observe)
```

A capability is turned on by providing its **port** — give a `redactor` and redaction is on;
give an `audit` sink and audit is on. Omit them and nothing happens.

```ts
import { createGovernance, createMemoryRedactor, createMemoryAudit } from "@busyclaw/core"

// You bring the PII detector (regex, Presidio, an NER model). Governance ships only the noop.
const emails = (t) => [...t.matchAll(/\S+@\S+/g)].map((m) => ({
  start: m.index, end: m.index + m[0].length, value: m[0],
}))

const ec = createGovernance({
  redactor: createMemoryRedactor(emails), // opt in to redaction (omit → none)
  audit: createMemoryAudit(),             // opt in to audit (omit → none)
  runTool: async (call, ctx, { rehydrate }) => {
    const args = await rehydrate(call.args) // PII only exists inside this boundary
    return send(args)
  },
})

ec.registerGate({
  // before-gate — decides
  id: "amount-cap",
  matcher: (c) => c.name === "send_invoice",
  handler: (c) => (Number(c.args.amount) > 10_000
    ? { decision: "deny", reason: "over cap" }
    : { decision: "permit" }),
})

await ec.handleToolCall({ name: "send_invoice", args: { to: "a@b.com", amount: 500 } })
```

The governance slice is the redaction substrate (Redactor port), an opt-in
hash-chained audit after-gate (AuditSink port), and the before/after gate pipeline
with the `sealed` guarantee. A non-EU user takes only what they want; `@busyclaw/eu`
brings redaction + a *sealed* audit gate + policy. Temporal/SQLite hosts, the storage
adapter (doc 13), and plugins build on this — they don't change it.

`@busyclaw/core` also owns durable Claw domain contracts such as `ClawRecord`,
`ThreadRecord`, `MessageRecord`, `ToolCallRecord`, `ToolResultRecord`, and their
store ports. Storage implementations live outside this package.

Run the proof: `pnpm --filter @busyclaw/core test`

See `docs/architecture/` — especially 02a (governance + sealed gates), 03 (PII), 04
(the pipeline), 07 (audit).
