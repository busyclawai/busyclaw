# @busyclaw/client — the better-auth-shaped client

Status: **designed 2026-07-13, sequenced BEFORE the ai-sdk-ui bridge** (Konstantin's call: no
chat DX before the client story exists). Grounded in better-auth source at
`~/coding/better-auth` (v1.6.18, commit 36f345b1b) — file:line refs below are into that repo.
The pattern: a types-only wire (`import type` phantoms), a convention-routed runtime, portable
nanostores reactivity, framework bindings as thin wrappers.

## What busyclaw already has vs what better-auth had to invent

- **Explicit route table.** better-auth derives paths by convention only (camelCase→kebab,
  `client/proxy.ts:71`) and infers GET-vs-POST from "has body" (`proxy.ts:30-33`) — a documented
  footgun they patch with a hard-coded `pathMethods` seed (`client/config.ts:103-108`). busyclaw
  already HAS the explicit table: `clawApiRouteList` + `clawApiInputSchemas` + the
  `get*/list* → GET` rule (`api.ts apiMethodPath/apiHttpMethod`). The base client stays
  TABLE-driven (no heuristic, no footgun); only plugin namespaces need the convention.
- **Type folding.** better-auth's `$InferServerPlugin` phantom (`{} as ReturnType<typeof plugin>`,
  magic-link/client.ts:5-11) carries server types across the boundary with zero runtime import.
  busyclaw already folds plugin api types server-side (`InferPluginApi<Config>`); the client
  reuses that same machinery from the other end.
- **The gap.** Plugin api namespaces (`claw.api.secrets.*`, `.skills.*`) are bare closures —
  `api: () => ({ secrets: … })` — with no routes and no input schemas. Nothing remote can reach
  them. This is the one server-side change the client REQUIRES.

## Slice 1 (server) — routable plugin endpoints

**BUILT 2026-07-13.** `endpoints()` lives in contracts (`governance/endpoints.ts`): the returned
namespace IS the callable api (handlers exposed as-is), the flattened route table rides
non-enumerably under `ENDPOINTS_METADATA` (`Symbol.for("busyclaw.endpoints")`, read via
`endpointRoutesOf`). Nested definition records are GROUPS (`skills.packages.create` →
`/packages/create`); compose by spreading DEFS records — spreading a built namespace drops the
metadata. `toRequestHandler` walks `claw.api` (plain-object wrappers recurse, so
`channels.registrations` mounts at its full key path) and validates at the boundary. All three
contributors migrated: secrets, skills (simple + governed, substores included), channels
registrations. One `toKebabCase` + `endpointHttpMethod` in contracts; the base api derives from
the same pair.

Evolve the plugin api contribution from bare closures to DECLARED endpoints:

```ts
api: (context) => ({
  secrets: endpoints({
    set:    { input: setSecretInput,  handler: (args) => store.set(args) },     // POST /secrets/set
    delete: { input: deleteSecretInput, handler: … },                            // POST /secrets/delete
    list:   { input: listSecretsInput, handler: …, method: "GET" },              // GET  /secrets/list
  }),
})
```

- `endpoints()` (contracts) wraps handlers with route metadata: path = `/<namespace>/<kebab(method)>`,
  HTTP verb from the SAME `get*/list* → GET` prefix rule as the base api, per-endpoint `method`
  override for the exceptions (better-auth's `pathMethods` lesson, made declarative). Input =
  arktype at the boundary (house rule) — the same schema validates the HTTP body AND types the
  client call.
- ONE shared `toKebabCase` in contracts, used by route derivation AND (type-level) by the client's
  path mapping — better-auth's gotcha #2: client and server disagreeing on the kebab splitter
  means silent 404s (`core/utils/string.ts:19-23` is theirs; ours must be the single source).
- `toRequestHandler` mounts them under the base path next to the flat routes; conflicts fail loud
  at assembly (existing `checkRouteConflicts`).
- Server-side DX unchanged: `claw.api.secrets.set(...)` still works in-process — `endpoints()`
  returns the callable namespace; the route metadata rides alongside.
- Touches the plugin protocol (contracts) → full-suite gate + repo-wide consumer grep.

## Slice 2 — `@busyclaw/client` (vanilla core, new package `packages/client`)

```ts
import { createClawClient } from "@busyclaw/client";
import type { claw } from "~/server/claw";           // TYPE-only — zero server runtime crosses

export const client = createClawClient<typeof claw>({
  baseUrl: "/api/busyclaw",
  fetch,                                              // injectable — the busyclaw HostBridge seam
  headers: () => authHeaders(),
  plugins: [secretsClient(), approvalsClient()],
});

await client.listMessages({ threadId });              // → { data, error }
await client.secrets.set({ name, value });            // plugin namespace, typed end-to-end
```

- **Typing**: `createClawClient<typeof claw>()` — the `Claw<Config>` type carries the whole api
  (base + folded plugin namespaces + config-shaped records incl. the redaction create param).
  better-auth's `$InferAuth` option (core/plugin-client.ts:90) is the same move; ours is the
  generic param since `Claw` is already the one exported god-type.
- **Runtime**: base methods table-driven off `clawApiRouteList` (exists today in adapter-core —
  MOVES to `@busyclaw/client`; adapter-core keeps a re-export for compat). Plugin namespaces via
  the recursive FUNCTION proxy (better-auth `proxy.ts:36-125`): proxy a `function` so every node
  is callable AND navigable, and return `undefined` for `then/catch/finally` or `await` hangs
  (their gotcha #1, `proxy.ts:49-51`).
- **Return shape**: `{ data, error }`, never throws by default (matches better-auth
  `BetterFetchResponse` and his safeEndpoint habit). Envelope parsing reuses
  `clawResponseEnvelope`.
- **No fetch library**: injectable `fetch` + tiny `onRequest/onResponse` hook pair instead of
  adopting @better-fetch/fetch — every dep counts for the busyclaw client-core (JSC/QuickJS
  embedding); better-auth itself had to firewall its client bundle from heavy imports
  (utils/url.ts:8-18 + their vite smoke test). We start with zero deps except nanostores.
- **Reactivity (nanostores — portable to JSC/QuickJS, already his plumbing layer)**:
  - Signal-toggle pattern adopted verbatim: mutations toggle boolean signal atoms via
    `atomListeners` path matchers; query atoms subscribe and refetch
    (better-auth `proxy.ts:91-119`, session-atom.ts:69-236). Adopt their hard-won details:
    lazy `onMount` fetch (no request until first subscriber, SSR-guarded), AbortController on
    refetch, equality gate so identical payloads don't re-render (equality.ts:48-57), stale data
    kept on non-401 errors.
  - Deviations from better-auth, deliberate: signal-name references FAIL LOUD at client
    construction (their silent-typo gotcha #4, `proxy.ts:102-103` returns early); action-key
    collisions FAIL LOUD (they use `defu` first-wins, config.ts:170-173 — gotcha #5; busyclaw
    house style is loud duplicates); cross-tab localStorage bus SKIPPED in v1 (gotcha #7 —
    revisit with busyclaw multi-device).
  - v1 atoms: ONE exemplar proving the machinery — `pendingApprovals` (refetch on
    grant/deny/sendMessage matchers). The chat surface itself stays with the ai-sdk bridge.
- **Client plugin contract** (`ClawClientPlugin`): `{ id, $InferServerPlugin (phantom, {} at
  runtime — never read it), getActions($fetch,$store), getAtoms($fetch), pathMethods,
  atomListeners }` — better-auth's contract (core/plugin-client.ts:94-143) minus `fetchPlugins`
  (no fetch lib). Exemplars in-repo: `secretsClient()` (type-only, the magic-link shape) and
  `approvalsClient()` (atoms + listeners, the organization shape, organization/client.ts:85-289).

## Slice 3 — `@busyclaw/client/react`

One framework binding (his stack): atoms → hooks by the `use${Capitalize(key)}` renaming
(react/index.ts:80-111), `useStore` on `useSyncExternalStore` with the snapshot guard
(react-store.ts:48-73). Vue/Svelte/native bindings deferred — but the CORE stays
framework-free, which is exactly the busyclaw Option B split: client-core (proxy + atoms) is the
shared-logic package; react hooks are the web app's leaf.

## Slice 4 (later, cheap once slice 1 exists) — generated OpenAPI

**BUILT 2026-07-13.** `endpoints()` gained the optional `output` schema (metadata-carried, pins the
handler return type via a `ValidateEndpointOutputs` intersection, NEVER runtime-validated);
`clawOpenApi(claw, options?)` in adapter-core walks `clawApiRouteList` + the shared
endpoints-namespace discovery into an OpenAPI 3.1 document (arktype `toJsonSchema` with the
`(ctx) => ctx.base` degrade-don't-throw fallback), served by the opt-in
`toRequestHandler({ openApi })` route `GET /openapi.json` (bare document, no envelope).

Konstantin's ask (2026-07-13): descriptions on the arktype schemas, OpenAPI exposed later — YES,
and the reference codebase proves the exact shape: better-auth's `open-api` plugin
(plugins/open-api/generator.ts) walks its endpoint definitions into an OpenAPI document and
serves it + a Scalar reference UI. busyclaw's version is cheaper because slice 1 already
declares everything the generator needs:

- **Schemas carry their own docs**: arktype 2.2 metadata (`.describe()` / `.configure({...})`)
  on input fields flows into `type.toJsonSchema()` output; `endpoints()` gains (per Konstantin 2026-07-13) an optional `output` arktype schema per endpoint — OpenAPI 200 becomes the envelope with `data = output.toJsonSchema()`, the handler return type is constrained by `output.infer` (schema and implementation cannot drift), and the client can infer `data` from it; NOT runtime-validated (outputs are trusted server code — arktype-at-boundaries). Plus the already-designed optional
  per-endpoint `description` (→ operation summary) and optional `output` schema (absent →
  the envelope with unspecified `data`). OpenAPI **3.1** target — natively JSON Schema, so
  `toJsonSchema()` output embeds without a 3.0 downcast. Exotic types (morphs/cyclic) use
  arktype's toJsonSchema fallback options; endpoint inputs are plain data shapes, so this is
  a corner, not a wall.
- **One generator covers the WHOLE surface**: `clawOpenApi(claw)` walks `clawApiRouteList`
  (base methods — input schemas exist today) + every plugin's `endpoints()` metadata. Tags from
  the first path segment; the uniform `clawResponseEnvelope` documents success/error once.
- **Serving**: opt-in route on `toRequestHandler` — `GET /openapi.json`; a reference UI is a
  later nicety (better-auth loads Scalar from a CDN — decide against busyclaw's self-contained
  posture then, not now).
- **The strategic loop**: `registerOpenApiSpec` already turns OpenAPI documents into governed
  tools — so one claw can register ANOTHER claw's generated spec and call it as governed,
  policy-addressable tools. Claw-to-claw federation falls out of slice 1 + this generator, and
  app-authz's action vocabulary can derive from the same endpoint metadata.

## Sequencing & relations

1. Slice 1 (server endpoints) → 2 (client core) → 3 (react) — each gated.
2. **ai-sdk-ui bridge AFTER this** — and its transport then rides `client.$fetch`-equivalent
   (auth headers/baseUrl in one place) instead of a bare `DefaultChatTransport`.
3. app-authz's PEP later gates the SAME routed endpoints — declaring plugin endpoints now is the
   prerequisite for policy-addressable plugin actions (action vocabulary per route).
4. busyclaw client-core: this package IS its seed — injectable fetch = HostBridge `net.fetch`,
   nanostores = the portable state layer, react entry = web-only leaf.

## Non-goals

- No client-side governance or secrets material — the client is untrusted; it carries session
  headers, never resolves credentials.
- No generated OpenAPI/codegen client — the type-flow IS the contract (better-auth proved the
  phantom pattern scales); codegen would re-introduce drift.
- No `view: "original"` from the client by default — server-side `authorize` decides (slice-2
  redaction rule).

**Rejected (2026-07-13): `openApi` on createClaw + flag-gated description stripping.** A runtime
config value cannot shrink a bundle (bundlers decide content at build time; `.describe()` calls are
side-effectful and not conditionally shakeable), the described schemas are SERVER-side only (the
client bundle is contracts+nanostores and never validates inputs), and `openApi` toggles a ROUTE —
transport semantics that belong on the adapter (the redaction-group layering rule: config lives
where the assembly acts on it). The zero-runtime shape already exists: standalone `clawOpenApi(claw)`
at build time → static openapi.json, no route mounted.

**Settled-deferred (2026-07-13): the `doc` meta channel.** `.describe()` is dual-use in arktype
(validation error text + doc fallback) — when a field wants doc prose that diverges from its error
message, the escape valve is a declared meta key, not a `.openapi()` method and not stripping:
`t.configure({ doc: "…" })` (ArkEnv meta extension in contracts), generator precedence
`meta.doc ?? description`. Named `doc`, not `openapi` — OpenAPI is one consumer of documentation,
not its definition; the same channel later carries `example`/`deprecated`. Build on first real
divergent-text need (endpoint-level `description` already covers per-operation prose).

**Re-decided (2026-07-13, supersedes the `doc` meta channel above): docs stay COLOCATED; the
reference UI joins the adapter option.** Grounded in better-auth plugins/open-api: their plugin
holds ZERO prose — it is generation + serving (GET /open-api/generate-schema + a Scalar
/reference page with theme/nonce/disable options, index.ts:102-139); doc text comes from zod
.describe() (generator.ts:161-169) and per-endpoint `metadata.openapi` blocks (generator.ts:215+),
both colocated with the endpoints. busyclaw mapping: `description`/`output` on endpoints() already
ARE those channels; richer per-endpoint OpenAPI later = an optional colocated `openapi?: {...}`
block on the endpoints() entry (their metadata.openapi analog) — NEVER centralized prose (drift
machine) and NEVER schema prose in contracts (client-bundle guarantee by structure, not by
tree-shaking). The `doc` ArkEnv meta channel is RETIRED unbuilt. Scalar reference page ships as
`toRequestHandler(claw, { openApi: { reference: { theme, nonce, path } } })` — adapter-homed
(busyclaw plugins are foundation-only and cannot import the generator; better-auth plugin-izes it
only because everything there is a plugin). CDN-vs-vendored Scalar: explicit decision at build
time against the self-contained posture.

**FINAL doc-channel decision (2026-07-13, supersedes both notes above — Konstantin: "we will
have not only openapi but cli too"):** docs are SCHEMA-NATIVE and consumer-agnostic. Multiple
readers (OpenAPI generator, future CLI help, tool catalog) kill per-consumer endpoint blocks
(drift BETWEEN consumers); the `doc` ArkEnv meta channel is UN-RETIRED as the rich-prose channel
(`.describe()` stays terse error+summary; every consumer reads `meta.doc ?? description`); the
endpoints() `openapi?:` block, if ever built, carries protocol mechanics only (responses, content
types) — never prose. "Never leaked to client" is STRUCTURAL (described schemas live in server
packages the client never imports; the only client-bundled schema is the docless envelope; the
CLI is a server-side reader like the generator) and becomes ENFORCED via the next micro-slice:
extend the slice-3 module-graph walk test with a contracts-import ALLOWLIST for @busyclaw/client
(wire modules only — envelope, method names, kebab) so a described schema entering the client
graph fails CI. Guarantee by test, not by tree-shaking behavior.

**Mechanics amendment (2026-07-13, Konstantin: global aug would contaminate users' arktype):**
NO `declare global` ships — a library-shipped ArkEnv augmentation merges into every downstream
compilation (their own arktype gains `doc`), and global interface merging is an ownerless shared
namespace (a second library or future arktype claiming `doc` breaks USER builds). Instead: a
blessed helper pair in contracts — `doc(t, text)` writing the NAMESPACED meta key
`{ busyclaw: { doc } }` (one cast inside the helper, the AI-SDK blessed-seam precedent; prefix
ownership like busyclaw__ context keys and the busyclaw tool stamp) and `docOf(t)` as the typed
reader. Consumers read `docOf(t) ?? t.description`. Zero ambient types, collision-proof,
user-invisible. Verify at build: arktype preserves unknown meta keys at runtime.

**Mechanics re-amended (2026-07-13, Konstantin: typed extension of the namespaced key, cosmetic
pollution accepted):** ship the global ArkEnv augmentation FOR THE NAMESPACED KEY —
`meta(): { busyclaw?: { doc?: string } }` — so authoring is plain typed
`.configure({ busyclaw: { doc } })` with zero casts; the write-side helper is dropped. The
collision hazard was the ownerless key, and `busyclaw` as the name removes it; the accepted
residue is one clearly-owned optional key in downstream autocomplete. Keep: `docOf(t)` as the ONE
reader with precedence built in (`meta.busyclaw?.doc ?? description`); the client
import-allowlist test unchanged. Standing rule: the augmented interface is ADDITIVE-ONLY across
versions (mixed-version node_modules must merge cleanly).

**BUILT 2026-07-13** — contracts `governance/doc.ts` (typed ArkEnv augmentation + `docOf`, barrel-only),
wire subpaths `./claw-api` + `./governance/endpoints` with the client's barrel-ban/allowlist/docless-source
test (`packages/client/tests/contracts-wire.test.ts`), and `clawOpenApi` consuming the channel into the
top-level request/response schema `description` (field-level surfacing deferred).

**Follow-up slice (2026-07-13, Konstantin: "field.* descriptors should be able to emit docs too"
— verified they cannot):** `EntityFieldMeta` has no doc surface, so entity-DERIVED boundary
schemas (createClawInput, clawEntity.updateSchema(), channels list filter) are undocumentable —
the doc-sweep correctly skips them. Fix = the field.json move applied to docs: `field.*` options
gain `description?` (→ derived schemas .describe()) and `doc?` (→ busyclaw.doc), attached where
each field materializes as an arktype Type in derivation; every derived record/create/patch
schema inherits them; docOf/toJsonSchema unchanged. One declaration → type + validator + storage
+ docs. Future note (not built): description as SQL column comments via the generate CLI.
Sequenced AFTER the doc-sweep commit (entity.ts must not race the writers), then a short second
pass over the entity field maps.

**BUILT 2026-07-13** — `field.*` meta gains the descriptor-only doc pair (`description`/`doc` on
`EntityFieldMeta`, stripped by `entity().storage` so migrations never move); doc-carrying fields
materialize in `shapeFor` (`describe` the INNER type before the `| undefined` union — required
errors read "must be <description>", optional unions keep their branch rendering — with
`busyclaw.doc` configured on the full property type for `docOf`), every derived
record/create/patch schema inherits them, and the create-input `toJsonSchema()` carries property
descriptions; second pass documented the claws entity field maps + channels registration fields.
