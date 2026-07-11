// The egress enforcement PORT — the ONE abstraction every sandbox egress backend implements,
// GENERIC across all three tiers (blocked / allowlist / interceptor). It sits between euroclaw's
// Cedar policy (the *what's allowed*) and each backend's native egress mechanism (the *how it's
// enforced*). Modeled on the PolicyEngine port (authz/engine.ts): a behaviour port plus a declared
// `capability` the system reads to warn when an org's policy needs enforcement a tier structurally
// cannot apply — no silent over-claim. Ports are behaviour, not data — plain TS, no schema/arktype
// (like PolicyEngine and the Secrets reader, these are host-assembled, not values crossing a boundary).
//
// DOM-free on purpose: @euroclaw/contracts builds without the DOM lib and plugins import it, so the
// connection-level request / response / socket shapes are STRUCTURAL mirrors (the SandboxFetch
// convention), never DOM Request/Response/ReadableStream.
//
// See docs/plans/sandbox-egress-slice2-enforcement-port.md (this port + the compiler) and
// docs/plans/sandbox-egress-plan.md (the backend landscape + honest tiering).

/** How much of the network an interceptor sees — declared honestly by the backend. QuickJS is
 *  fetch-only (no sockets); a platform gateway (Cloudflare) or a transparent MITM proxy also governs
 *  raw sockets, so it declares `fetch+connect`. */
export type EgressTransport = "fetch" | "fetch+connect";

/** What a backend can enforce — mirrors PolicyEngineCapabilities. The IsolationPosture.network enum
 *  ("blocked" | "allowlist" | "interceptor") already names the same postures. `allowlist` is
 *  host-level via a native firewall (self-hosted Firecracker nftables/CIDR; Vercel SNI is a reference
 *  mechanism); `interceptor` puts euroclaw in the request path (QuickJS in-proc, a Cloudflare
 *  gateway, or a Firecracker transparent proxy). ONE backend may declare EITHER posture per how it is
 *  provisioned — the reason the port stays backend-agnostic. */
export type EgressCapability =
	| { posture: "blocked" }
	| { posture: "allowlist" }
	| { posture: "interceptor"; transport: EgressTransport };

/** A destination the guest wants to reach, at CONNECTION granularity (decision 1): an HTTP `fetch`
 *  or a raw `connect` (host:port). Both are typed now so a socket-capable backend needs no retrofit;
 *  slice 3 implements only the `fetch` surface (QuickJS has no sockets). */
export type OutboundRequest =
	| {
			kind: "fetch";
			url: string;
			method: string;
			headers: Record<string, string>;
			body?: unknown;
	  }
	| { kind: "connect"; host: string; port: number };

/** The response a governed `fetch` round-trip yields, at connection level. Structural (DOM-free): the
 *  interceptor adapter maps it onto its backend's response shape (e.g. the QuickJS wrapper's). `body`
 *  representation is the adapter's to fix in slice 3 — kept `unknown` here so typing it now forecloses
 *  nothing. */
export type OutboundResponse = {
	status: number;
	headers: Record<string, string>;
	body?: unknown;
};

/** A governed raw connection (the `connect` surface). TYPED now so `GovernedOutbound.connect` is
 *  expressible for a socket-capable backend; NOT implemented in this slice (QuickJS has no sockets).
 *  DOM-free byte channels — not DOM ReadableStream/WritableStream — refined by the backend that first
 *  implements `connect()` (Cloudflare). */
export type GovernedSocket = {
	/** Inbound bytes from the destination. */
	readable: AsyncIterable<Uint8Array>;
	/** Outbound sink to the destination. */
	writable: {
		write: (chunk: Uint8Array) => Promise<void>;
		close: () => Promise<void>;
	};
	/** Tear down the governed connection. */
	close: () => Promise<void>;
};

/** The in-path governed handler (interceptor tier). It PERFORMS the round-trip: authorize → floor →
 *  (slice 3) claim-check credential injection → perform → audit → response; a blocked request throws a
 *  governed error the guest reads as a denied fetch. `fetch` is required (every interceptor governs
 *  HTTP) and becomes ExecutionContext.fetchAdapter in slice 3; `connect` stays optional/undefined
 *  until a socket-capable backend (Cloudflare) implements it. Typed here, IMPLEMENTED in slice 3. */
export type GovernedOutbound = {
	fetch: (
		request: Extract<OutboundRequest, { kind: "fetch" }>,
	) => Promise<OutboundResponse>;
	connect?: (
		target: Extract<OutboundRequest, { kind: "connect" }>,
	) => Promise<GovernedSocket>;
};

/** What euroclaw computes for ONE execution, matched to the backend's declared capability: no egress;
 *  a static host allowlist the backend's firewall enforces; or an in-path governed outbound. One
 *  static plan per execution in v1 (decision 3) — a phased/lifecycle transition can be ADDED later
 *  without breaking this union. */
export type EgressPlan =
	| { mode: "blocked" }
	| { mode: "allowlist"; allow: readonly string[] }
	| { mode: "interceptor"; outbound: GovernedOutbound };

/** Honest-tiering (decision 4): a dimension of the org's policy a backend's tier structurally cannot
 *  enforce. Surfaced twice by the caller — a boot/config-time warning (this backend can't enforce
 *  your method/path policy) and a per-execution audit note (declared capability vs enforced plan). */
export type UnenforcedNote = {
	dimension:
		| "method"
		| "path"
		| "resource"
		| "conditions"
		| "credential-isolation";
	detail: string;
};

/** The plugin-side adapter contract: declare a `capability`, and `apply` a plan into the backend's
 *  native mechanism for one execution. The apply() BODY lives in the plugin (slice 3: QuickJS maps
 *  plan.outbound.fetch → ExecutionContext.fetchAdapter; slice 4: a firewall adapter maps plan.allow →
 *  nftables/CIDR) — contracts owns only the type. Generic over the execution HANDLE the plugin returns
 *  (its shape is the plugin's). One static plan per execution today; a phased transition (a Vercel
 *  `updateNetworkPolicy` analog) can be ADDED later — via the handle or an added method — without a
 *  breaking change; it is deliberately not modeled now (decision 3). */
export type SandboxEgressAdapter<Handle = unknown> = {
	readonly capability: EgressCapability;
	apply: (plan: EgressPlan) => Handle | Promise<Handle>;
};
