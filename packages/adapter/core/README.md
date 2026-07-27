# @busyclaw/adapter-core

Protocol-neutral `Request -> Response` handler for busyclaw adapters.

It exposes a small base route set around the `busyclaw` API route manifest:

- `GET /health`
- `POST /cron`, which runs cron tasks contributed by connected plugins/channels/engines
- method-name-derived API routes such as `POST /bind-conversation`, `POST /upsert-channel-endpoint`, `POST /run`, `POST /send-message`, and `GET /get-run?id=...`

Framework adapters should be thin wrappers around `toRequestHandler(...)`.
Plugins can add routes for channel/webhook integrations such as Telegram, Teams, or email. Plugins can also add cron tasks for polling or worker drains; adapter-core exposes them through the built-in `/cron` route.

## Server

```ts
import { toRequestHandler } from "@busyclaw/adapter-core"
import { claw } from "./claw"

const handler = toRequestHandler(claw)
```

Use `createClaw({ cronHandler })` to enable and protect scheduled invocations:

```ts
const claw = createClaw({
  cronHandler: {
    secret: process.env.BUSYCLAW_CRON_SECRET,
    limit: 10,
  },
  engine: sqlEngine({ store }),
  model,
})

const handler = toRequestHandler(claw)
```

The cron trigger returns one result per connected cron task:

```json
{
  "ok": true,
  "data": {
    "tasks": [{ "id": "engine-sql:work", "status": "idle", "processed": 1 }]
  }
}
```

The handler returns JSON envelopes:

```json
{ "ok": true, "data": {} }
```

Errors use the same envelope shape and validation failures return HTTP `400`:

```json
{ "ok": false, "error": { "message": "..." } }
```

GET routes accept simple query parameters, or a full JSON input object in `input`:

```txt
GET /api/busyclaw/get-claw?id=claw_123
GET /api/busyclaw/list-messages?input={"threadId":"thread_123","afterSequence":2}
```

POST routes accept the API input object as JSON body.

## Client

```ts
import { createClawClient } from "@busyclaw/adapter-core"

const client = createClawClient({ baseUrl: "/api/busyclaw" })

const binding = await client.bindConversation({
  provider: "telegram",
  organizationId: "organization-1",
  externalConversationId: "chat-123",
})
const run = await client.run({ prompt: "Summarize this thread" })
const status = await client.getRun({ id: "run_123" })
```

The client uses the same route manifest and input schemas as the server, so invalid inputs fail before `fetch`.
