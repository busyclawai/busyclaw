# @busyclaw/vendors

Vendor-coupled authoring glue, one subpath per vendor — the foundation-tier home for the small
pieces that must import a third-party SDK. Feather-light by design: each subpath depends on
`@busyclaw/contracts` and its vendor SDK only — no runtime, no engine — so a host's shared tools
library (or a busyclaw plugin, under the plugins-import-foundation-only rule) can use it without
dragging the execution stack. There is deliberately no root export.

## `@busyclaw/vendors/ai-sdk`

`tool()` defines a governed tool in one place, and what it returns is the canonical
`ToolDescriptor` — not an AI-SDK tool. One call carries the model-facing definition
(description/inputSchema, input inference preserved), the executable (a `local` invocation), and
governance as a FIRST-CLASS field (`gate`/`effect`/`invoker` and the authz-model facts
`access`/`groups`/`resource`/`audit` — what the OpenAPI/MCP generators derive from specs, an
author declares here). `govern()` (re-exported from contracts) is the adoption path for tools you
didn't author; both produce the identical descriptor.

This subpath is a schema BRIDGE, not the definition of what a tool is: the AI-SDK `ToolSet` the
model sees is DERIVED from descriptors downstream, in the runtime. That is why the runtime no
longer re-validates a governance stamp on every call — there is no type-erased field left to
launder back into a trusted one.

Schemas: `inputSchema` takes the AI SDK's own schemas (zod / `jsonSchema()` / lazy) **or any
standard-schema library directly**, following the Elysia multi-schema pattern (a minimal
structural `~standard` marker; the input type computed from the captured schema generic). The
bridge is **capability-based, not vendor-based**: a standard schema that can emit JSON Schema
(arktype's native `toJsonSchema()`) is bridged automatically — provider-facing JSON Schema from
the library, validation incl. morphs through `~standard.validate`, inference preserved; one that
can't fails loud, because bare standard-schema defines validation only and a tool schema must
produce the JSON Schema sent to the provider. `standardSchema()` is exported for direct use with
plain `aiTool`. busyclaw tools are always executable (the chokepoint requires an
executable invocation), so `tool()` has one signature and returns an `AuthoredTool` — the
canonical descriptor narrowed to this vendor. A `description` is REQUIRED: it is the tool's only
interface to the model, and catalog search has nothing else to match on. Vendor-exotic AI-SDK
fields (streaming hooks, provider-defined tools) are not carried onto a descriptor — it is
vendor-neutral, and nothing consumes them yet.
