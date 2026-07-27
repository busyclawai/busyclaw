# @busyclaw/adapter-nextjs

Thin Next.js route-handler adapter for busyclaw, inspired by Better Auth's `toNextJsHandler` shape.

```ts
import { toNextJsHandler } from "@busyclaw/adapter-nextjs"
import { claw } from "@/lib/busyclaw"

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(claw)
```

The heavy lifting lives in `@busyclaw/adapter-core`; this package only adapts the handler to Next.js' route export shape. The same handler exposes API routes, plugin/channel routes, and the built-in `POST /cron` trigger for connected cron tasks.

For browser/server clients, use `createClawClient(...)` from `@busyclaw/adapter-core` against the same base route:

```ts
import { createClawClient } from "@busyclaw/adapter-core"

const client = createClawClient({ baseUrl: "/api/busyclaw" })
```
