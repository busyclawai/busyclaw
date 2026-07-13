# Third-Party Notices

euroclaw includes, adapts, or derives from third-party open-source software. The
licenses and copyright notices below are reproduced as required by those
licenses. This file is the canonical attribution record; per-file headers point
back here.

> **How we use this file.** When you copy or adapt *code* from a project listed
> here, add a header comment to the file (see `docs/architecture/12-conventions.md`)
> and, if the project isn't already listed, add an entry below with its verbatim
> copyright line and full license text. Reusing only a project's *design or
> patterns* (not its code) needs no entry — ideas and APIs aren't copyrightable.

---

## Better Auth

- **Project:** Better Auth — https://github.com/better-auth/better-auth
- **License:** MIT
- **Used in euroclaw:** portions of the type-level and plugin machinery are
  *adapted from* Better Auth's **patterns/API** (not verbatim code). Files:
  - `packages/foundation/contracts/src/governance/plugin.ts` — the plugin-as-data-object shape with phantom
    type carriers (`$Infer`, `$InferContext`, `$REASON_CODES`) and the tuple-fold that
    intersects a field across all plugins (cf. `InferPluginFieldFromTuple` /
    `InferPluginTypes`). The `UnionToIntersection` / `IsAny` helpers are ubiquitous
    community TS idioms, not Better Auth's.
  - `packages/foundation/contracts/src/governance/reason-codes.ts` — the `defineReasonCodes` catalog pattern adapted
    from Better Auth's `defineErrorCodes`.
  - `packages/foundation/core/src/governance.ts` — the generic-config factory shape
	    `createGovernance<const Config>(config): Governance<Config>` and folding plugin types
	    onto the instance (cf. `betterAuth<Options>(options)`).
  - `packages/foundation/contracts/src/storage.ts` (the protocol; implementations in
    `packages/storage/core/src/`) — the `Adapter` CRUD port (incl. the atomic
    `consumeOne` single-use primitive), the `Where` shape, and the declarative table-schema
	format, based on Better Auth's database adapter (`packages/core/src/db`, `DBAdapter`) and
    its plugin schema files (`packages/better-auth/src/plugins/*/schema.ts`). euroclaw's port is
    a leaner subset.
  - `packages/client/src/` — the client machinery adapted from Better Auth's client
    **patterns**: the recursive function-path proxy (`client/proxy.ts`), the lazy query atom
    (`useAuthQuery`, `session-atom.ts`), and the react binding (`client/react/index.ts`'s
    `use${Capitalize(key)}` hook renaming plus `react-store.ts`'s `useSyncExternalStore`
    snapshot-ref store binding, which Better Auth itself mirrors from `@nanostores/react`).
  - `packages/storage/kysely/src/index.ts` / `packages/storage/drizzle/src/index.ts` — the SQL
    storage adapters, modeled on Better Auth's `packages/kysely-adapter` /
    `packages/drizzle-adapter` (the CRUD/where translation reimplemented against each ORM's
    public API). `kyselyAdapter`'s raw-driver intake (duck-typing a better-sqlite3 `Database` /
     `pg` `Pool` / Kysely `Dialect` and wrapping it in Kysely) follows the approach of Better Auth's
     `packages/kysely-adapter/src/dialect.ts` (`createKyselyAdapter` / `getKyselyDatabaseType`).
  > Note: under MIT, reusing patterns/APIs (as here) requires **no** attribution —
  > ideas and APIs aren't copyrightable. These files are listed as a courtesy. If we
  > later copy *verbatim* code, switch the header to "copied from" and say so here.

### License (verbatim)

```
The MIT License (MIT)
Copyright (c) 2024 - present, Bereket Engida

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

---

## NullTickets

- **Project:** NullTickets — local source reviewed at `/Users/konstantinponomarev/Downloads/nulltickets-main`
- **License:** MIT
- **Used in euroclaw:** the lease/claim/heartbeat/idempotency engine kernel is
  *adapted from* NullTickets' **patterns/architecture** (not copied code). Files:
  - `packages/engines/sql/src/store.ts` — task/run/lease/idempotency store shape,
    hashed one-time lease tokens, heartbeat, complete/fail, reaping, and response replay.
  - `packages/engines/sql/src/worker.ts` — claim/execute/complete/fail worker loop shape.
  - `packages/engines/sql/src/schema.ts` — SQL engine schema shape for tasks, runs, leases,
    runtime events, and idempotency records.

  > Note: this is listed as a provenance courtesy. The implementation is independent TypeScript
  > over euroclaw's storage Adapter. If we later copy verbatim code, update this notice accordingly.

### License (verbatim)

```
MIT License

Copyright (c) 2026 nullclaw contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## NullBoiler

- **Project:** NullBoiler — local source reviewed at `/Users/konstantinponomarev/Downloads/nullboiler-main`
- **License:** MIT
- **Used in euroclaw:** the SQL orchestrator/run-event/checkpoint engine shape is
  *adapted from* NullBoiler's **patterns/architecture** (not copied code). Files:
  - `packages/engines/sql/src/store.ts` — run/event engine-store shape and operational runtime-state framing.
  - `packages/engines/sql/src/worker.ts` — explicit orchestrator/executor boundary.
  - `packages/engines/sql/src/schema.ts` — engine schema shape for run/event/task records.

  > Note: this is listed as a provenance courtesy. The implementation is independent TypeScript
  > over euroclaw's storage Adapter. If we later copy verbatim code, update this notice accordingly.

### License (verbatim)

```
MIT License

Copyright (c) 2026 nullclaw contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Elysia

- **Project:** Elysia — https://github.com/elysiajs/elysia (local source reviewed at `/Users/konstantinponomarev/Downloads/elysia-main`)
- **License:** MIT
- **Used in euroclaw:** the multi-schema-library acceptance mechanism is *adapted
  from* Elysia's **patterns** (not copied code) — the minimal structural
  `StandardSchemaV1Like` marker interface (reduced to what inference/validation
  need, cf. `src/types.ts:58-84`) and the UnwrapSchema-style approach of capturing
  the schema as its own generic and computing the value type from it
  (cf. `UnwrapSchema`/`UnwrapBodySchema`, `src/types.ts`). Files:
  - `packages/foundation/contracts/src/standard-schema.ts` — the marker interface and detection guards.
  - `packages/foundation/vendors/src/ai-sdk/index.ts` — the captured-generic `ToolInput<S>` unwrap.

  euroclaw diverges where Elysia stops: Elysia keeps standard schemas as opaque
  validators; euroclaw's tool schemas must also emit provider-facing JSON Schema,
  so bridging is capability-based (`toJsonSchema()` presence) — that part is
  euroclaw's own.

  > Note: this is listed as a provenance courtesy. The implementation is independent
  > TypeScript. If we later copy verbatim code, update this notice accordingly.

### License (verbatim)

```
Copyright 2022 saltyAom

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## Executor

- **Project:** Executor — local source reviewed at `/Users/konstantinponomarev/Downloads/executor-main` (study: `docs/research/executor/`)
- **License:** MIT
- **Used in euroclaw:** the OpenAPI → tool extraction flow is *adapted from* Executor's
  openapi plugin (`packages/plugins/openapi/src/sdk/extract.ts` and `definitions.ts`) —
  specifically the shape of the walk: path-level + operation-level parameter merge keyed by
  `(in, name)` with operation override, path parameters forced required, JSON media type
  selection in the spec author's declared order, and style/explode serialization capture.
  Rewritten without Effect and reduced to euroclaw's scope (local-$ref-only inlining, the
  governance-facts stamping, and the skipped/warnings reporting are euroclaw's own). File:
  - `packages/runtime/src/tools/sources/openapi/extractor.ts`

  > Note: this is listed as a provenance courtesy. The implementation is independent
  > TypeScript. If we later copy verbatim code (e.g. the invoker), update this notice.

### License (verbatim)

```
MIT License

Copyright (c) 2026 Rhys Sullivan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

<!--
To add another dependency you copy/adapt CODE from, duplicate the block above:

## <Project name>

- **Project:** <name> — <url>
- **License:** <SPDX id, e.g. MIT / Apache-2.0>
- **Used in euroclaw:** <what / which files>

### License (verbatim)

```
<paste the project's exact copyright line + full license text>
```
-->
