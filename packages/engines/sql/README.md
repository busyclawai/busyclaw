# @busyclaw/engine-sql

SQL-backed durable execution engine for busyclaw.

This package is one concrete implementation of the engine contract from `@busyclaw/engine-core`. It provides SQL run/task/event/lease storage, worker ticking, continuation tasks, and idempotent runtime-run enqueueing over `@busyclaw/storage-core` adapters that support transactions.

Use it by passing `sqlEngine(...)` into the branded `createClaw(...)` composition point:

```ts
import { sqlEngine } from "@busyclaw/engine-sql"
import { createClaw } from "busyclaw"

const claw = createClaw({
  model,
  engine: sqlEngine({ store, workerId: "worker-1" }),
})

const run = await claw.api.startRun({ prompt: "Send Alice the update" })

const status = await claw.api.getRun({ id: run.id })
const events = await claw.api.listRunEvents({ runId: run.id })
```

The underlying engine intentionally exposes only the generic execution surface: `kind`, `startRun`, `continueRun`, and optional `work`. Product/framework code should call `claw.api.startRun`, `claw.api.continueEngineRun`, `claw.api.getRun`, and `claw.api.listRunEvents` so it does not import SQL internals. Worker pumping is internal host wiring, not a public product API.

## Cron Or Serverless Worker

`work()` processes one due task. In cron/serverless environments, enable the SQL engine cron task and let the framework adapter expose the built-in `/cron` route:

```ts
const claw = createClaw({
  model,
  cronHandler: {
    secret: process.env.BUSYCLAW_CRON_SECRET,
  },
  engine: sqlEngine({
    store,
    cron: { limit: 10 },
  }),
})
```

The SQL engine contributes an `engine-sql:work` cron task. `createClaw({ cronHandler })` enables and protects the composed cron handler; adapter packages expose `POST /cron` and run all connected cron tasks. The SQL task drains the internal engine handle with `drainWork(...)` until idle or the configured bound. Multiple cron invocations or workers can run it concurrently because tasks are claimed with SQL leases and lease tokens.

## Long-Lived Worker

A daemon can loop continuously, but it should still back off while idle and respect shutdown:

```ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

while (!stopping) {
  const result = await claw.$context.engine?.work?.()

  if (result.status === "idle") {
    await sleep(1000)
  }
}
```

Do not use a tight `while (;;)` loop without idle backoff or shutdown handling.

The SQL engine requires a storage adapter with transactional state transitions. SQLite memory/local adapters are useful for local tests; Postgres/MySQL provider integration tests are tracked separately.
