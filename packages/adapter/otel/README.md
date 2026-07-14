# @euroclaw/otel

Maps euroclaw's operational event stream onto OpenTelemetry spans. The bridge is just an
event sink — no runtime or contracts changes, no SDK dependency; the host owns provider
and exporter setup and hands in a `Tracer`.

```ts
import { otelEvents } from "@euroclaw/otel"
import { trace } from "@opentelemetry/api"

const claw = createClaw({
  events: otelEvents({ tracer: trace.getTracer("euroclaw") }),
})
```

Span mapping:

- one `invoke_agent <clawId>` root span per `runId`, closed by the terminal `run.*` event
  (a continuation gets a new root span; `euroclaw.run.id` is the cross-trace link)
- a retrospective `chat` child per `model.completed`/`model.failed` (token usage and
  finish reason as attributes)
- an `execute_tool <name>` child per tool call; denials close it with
  `euroclaw.reason_code`, approvals close it with `euroclaw.tool.outcome` (approvals can
  take days — a span never stays open)

Peer dependency: `@opentelemetry/api` only. Attribute names are pinned string constants —
the GenAI semantic conventions are incubating, so no `@opentelemetry/semantic-conventions`
dependency.
