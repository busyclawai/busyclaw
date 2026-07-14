// A neutral port for OPERATIONAL lifecycle events that plugins (skills, channels, future)
// emit while running. Of euroclaw's three planes this is the OPERATIONAL one: best-effort
// delivery (a lost event loses telemetry, never state), payloads redacted at ingress. It is
// NOT the compliance audit — that lands on `AuditSink` (audit.ts): sealed, hash-chained
// evidence records. And it is NOT durable execution state — claws rows and engine-sql
// `run_event` are load-bearing history that a run cannot proceed without. Keep the three
// planes separate — see docs/architecture/08 and 15, docs/plans/observability-plan.md.
//
// Core owns only the PORT plus a minimal base event shape. The concrete event schemas and the
// sink implementation live in @euroclaw/runtime (RuntimeEvent / RuntimeEventSink); core does NOT
// enumerate skill/channel event types.

import { type } from "arktype";

/**
 * The base contract every plugin-emitted event satisfies: a discriminating `type` string plus
 * arbitrary additional fields (arktype allows undeclared keys, so concrete events in runtime add
 * their own). Kept open on purpose — core never hardcodes skill/channel event types.
 */
export const event = type({ type: "string" });
export type Event = typeof event.infer;

/**
 * The port plugins receive (via `EuroclawPluginConfigureContext.events`) to emit operational
 * events. Generic over the concrete event type so the runtime can specialise it
 * (`RuntimeEventSink = EventSink<RuntimeEvent>`); plugins see the neutral `EventSink<Event>`.
 */
export type EventSink<E extends Event = Event> = {
	emit: (event: E) => void | Promise<void>;
};
