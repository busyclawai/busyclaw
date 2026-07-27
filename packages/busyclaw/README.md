# busyclaw

Branded assembly package for composing busyclaw runtime, governance, and durable engines.

The current entrypoint is `createClaw(config)`. It is intentionally HTTP-free; framework adapters should wrap the returned `claw` object later.

## Direct Runtime Use

Use `claw.api.run(...)` when the host wants an immediate in-process run:

```ts
import { createClaw } from "busyclaw"

const claw = createClaw({
  model,
  tools,
  plugins,
})

const result = await claw.api.run({ prompt: "Send Alice the update" })
```

The direct runtime path is useful for tests, local apps, CLIs, and hosts that do not need durable queue/worker execution.

## Durable Claw Use

Pass `database` when you want busyclaw to persist Claws, threads, channel endpoint state, external conversation bindings, transcript messages, tool calls, tool results, checkpoints, approvals, and effects in your app database:

```ts
import { memoryAdapter } from "@busyclaw/storage-core"
import { createClaw } from "busyclaw"

const claw = createClaw({
  model,
  tools,
  database: memoryAdapter(),
  redactor,
})

const agent = await claw.api.createClaw({
  organizationId: "organization-1",
  name: "Recruiting assistant",
})

const thread = await claw.api.createThread({
  clawId: agent.id,
  organizationId: agent.organizationId,
})

await claw.api.sendMessage({
  clawId: agent.id,
  threadId: thread.id,
  message: "Summarize this CV",
})
```

`api.sendMessage(...)` is the current server-side vertical slice: it appends the user message, runs the governed runtime, and records runtime events into the Claw domain model through a typed event sink. Completed runs append an assistant message. Tool calls/results populate `tool_call` and `tool_result`. Approval waits create checkpoints.

The API object is protocol-agnostic: it is a flat set of async functions with object inputs. HTTP, WebSocket, gRPC, Telegram, Teams, email, or future orpc adapters should translate their protocol/platform messages into calls on `claw.api.*`.

`busyclaw` also exports `clawApiRoutes`, `clawApiRouteList`, and `parseClawApiInput(...)` so adapters and clients share one route/input contract instead of duplicating HTTP paths or validation rules.

## External Conversations

Channel adapters should bind a platform conversation to a durable Claw thread before sending messages:

```ts
const binding = await claw.api.bindConversation({
  provider: "telegram",
  organizationId: "organization-1",
  externalConversationId: "chat-123",
  externalActorId: "user-456",
  claw: { name: "Recruiting assistant" },
  thread: { title: "Telegram chat" },
})

await claw.api.sendMessage({
  clawId: binding.claw.id,
  threadId: binding.thread.id,
  message: "Summarize this CV",
})
```

`api.bindConversation(...)` is idempotent for `{ provider, organizationId, externalConversationId }`. If a binding exists, it returns the existing Claw and thread; otherwise it creates the missing Claw/thread and stores the binding.

Channel integrations should also track endpoint/poller state with the channel endpoint APIs:

```ts
await claw.api.upsertChannelEndpoint({
  provider: "telegram",
  organizationId: "organization-1",
  endpointKey: "default",
  mode: "poll",
  cursor: { offset: 100 },
})

await claw.api.updateChannelEndpoint({
  provider: "telegram",
  organizationId: "organization-1",
  endpointKey: "default",
  patch: {
    status: "validated",
    cursor: { offset: 101 },
    lastPolledAt: new Date().toISOString(),
  },
})
```

Endpoint state is separate from conversation bindings: one endpoint represents a connected bot/webhook/inbox/poller, while conversation bindings map individual external conversations to Claw threads.

## Approval Continuation

When a tool gate pauses a run, grant or deny the approval, then call `api.continueRun(...)`:

```ts
const result = await claw.api.sendMessage({ clawId, threadId, message, runId: "run-1" })

if (result.result.status === "waiting_approval") {
  const approvalId = result.result.approvalIds![0]

  await claw.api.grantApproval({ approvalId, by: "alice" })
  await claw.api.continueRun({ approvalId })
}
```

`api.continueRun(...)` restores the original Claw/thread/run recording context from the approval checkpoint metadata. Approved continuations execute the stored tool call and record the tool result plus assistant message. Denied continuations emit a typed denied result, mark the recorded tool call as denied, and create a failed tool result without appending an assistant message.

## Durable Engine Use

Durable execution engines are passed through `engine`, for example:

```ts
import { sqlEngine } from "@busyclaw/engine-sql"
import { createClaw } from "busyclaw"

const claw = createClaw({
  model,
  cronHandler: {
    secret: process.env.BUSYCLAW_CRON_SECRET,
  },
  engine: sqlEngine({ store, workerId: "worker-1" }),
})

const run = await claw.api.startRun({
  prompt: "Send Alice the update",
  ctx: { team: "acme" },
})

const status = await claw.api.getRun({ id: run.id })
const events = await claw.api.listRunEvents({ runId: run.id })
```

The underlying engine is deliberately engine-neutral. Framework adapters and host apps should rely on public API methods for queueing and reading runs:

```ts
claw.api.startRun(...)
claw.api.continueEngineRun(...)
claw.api.getRun(...)
claw.api.listRunEvents(...)
```

Worker pumping is not a public product API. SQL cron/serverless drains are contributed by the SQL engine as a plugin route, while long-lived workers can call the internal `$context.engine.work` handle directly from host wiring.

SQL is the first engine implementation, configured with `sqlEngine(...)`. Future engines such as Temporal, Vercel Workflow, or other durable workflow systems should implement the same generic engine contract without changing framework adapters.

Run status and runtime events are exposed separately through:

```ts
claw.api.getRun({ id })
claw.api.listRunEvents({ runId: id })
```

The generic engine contract lives in `@busyclaw/engine-core` as `ClawEngineFactory`, `ClawEngineHandle`, and `ClawRunReadModel`. `@busyclaw/engine-sql` is only one implementation of that contract; framework adapters should depend on `claw.api`, not SQL-specific package internals.

## Object Shape

The current `claw` object exposes:

```ts
claw.api
claw.$context
```

`claw.api` is the public server-side operation surface. `$context` is an internal escape hatch for advanced host wiring and tests; protocol/channel adapters should prefer `claw.api.*`.

## Adapter Boundary

This package owns the API route manifest and input parsing, but does not expose framework handlers.

Adapters should wrap `claw`, for example:

```ts
toNextJsHandler(claw)
toHonoHandler(claw)
toExpressHandler(claw)
```

Those adapters should translate framework requests into calls on the stable `claw` object. They should not reach into `@busyclaw/engine-sql` internals.
