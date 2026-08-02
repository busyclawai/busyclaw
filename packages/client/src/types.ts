// The client's public vocabulary and type inference. The wire rule everywhere: every call resolves
// `{ data, error }` and never throws — HTTP/envelope failures land in `error`, transport-level
// throws are wrapped too. Server types cross as TYPES ONLY: the `ClawLike` generic (`typeof claw`)
// and the `$InferServerPlugin` phantom are erased `import type` surfaces — no server package is
// ever imported at runtime.

import type {
	ClawClientAtomListener,
	ClawClientError,
	ClawClientFetch,
	ClawClientPlugin,
	ClawClientStore,
	ClawFetchOptions,
	ClawResult,
	EndpointHttpMethod,
	UnionToIntersection,
} from "@busyclaw/contracts";
import type { Claw } from "busyclaw";
import type { ReadableAtom } from "nanostores";

// The client-plugin PROTOCOL lives in @busyclaw/contracts — the package both a plugin author and
// this client already depend on — and is re-exported here so `@busyclaw/client`'s surface is
// unchanged. It used to be defined here, which forced a plugin shipping its own client half to
// depend on the client package, and the client already depends (for its tests) on the assembly that
// depends on the plugins: turbo names that cycle outright. The same split better-auth makes, where
// `BetterAuthClientPlugin` is defined in @better-auth/core and re-exported from better-auth/client.
export type {
	ClawClientAtomListener,
	ClawClientError,
	ClawClientFetch,
	ClawClientPlugin,
	ClawClientStore,
	ClawFetchOptions,
	ClawResult,
};

/** The injectable transport: any WHATWG-compatible fetch. This is the load-bearing seam — a
 *  native-app host bridge or a test stub slots in here; the client never touches globals when one
 *  is supplied. */
export type ClawFetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/** The per-request context the `onRequest`/`onResponse` hooks see. `url` and `init` are the live
 *  values — `onRequest` may mutate them (extra headers, a rewritten target) before send. */
export type ClawClientRequest = {
	/** Route path relative to `baseUrl` (e.g. `/secrets/set`). */
	path: string;
	method: EndpointHttpMethod;
	url: string;
	init: RequestInit;
};

export type ClawClientOptions = {
	/** Where the claw request handler is mounted (default `/api/busyclaw`). Relative paths are fine
	 *  in browser contexts; node/native hosts pass an absolute origin. */
	baseUrl?: string | URL;
	fetch?: ClawFetchLike;
	/** Static headers or a (possibly async) producer resolved per call — session tokens live here. */
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
	plugins?: readonly ClawClientPlugin[];
	/** Runs before each request goes out; may mutate `url`/`init`. */
	onRequest?: (context: ClawClientRequest) => void | Promise<void>;
	/** Runs after each response arrives, before envelope parsing. */
	onResponse?: (
		context: ClawClientRequest & { response: Response },
	) => void | Promise<void>;
};

/** Anything shaped like an assembled claw. Structural, so `typeof claw` from the host's server
 *  module drives inference via `import type` — zero server runtime crosses. */
export type ClawShape = { api: object };

/** The default `ClawLike` when no generic is passed: busyclaw's base god-type, so a bare
 *  `createClawClient()` still types every base api method (config-shaped widening needs the real
 *  `typeof claw`). */
export type DefaultClawShape = Claw;

// ── type inference: server api → client surface ─────────────────────────────

/** Wrap one server api VALUE for the wire: async methods resolve `{ data, error }`, nested
 *  namespaces recurse, and anything else (in-process-only members — plain values, atoms a server
 *  api might hold) is unreachable remotely, so it maps to `never`. Exotic shapes (arrays,
 *  interfaces hiding callables) land on the honest `never` arm rather than pretending to be
 *  routable. */
type InferClientApiValue<V> = V extends (...args: infer Args) => infer R
	? (...args: Args) => Promise<ClawResult<Awaited<R>>>
	: V extends object
		? InferClientApi<V>
		: never;

export type InferClientApi<Api> = {
	[K in keyof Api]: InferClientApiValue<Api[K]>;
};

/** Shared with the framework bindings (`./react`) — intentionally not re-exported at the root. */
export type EmptyObject = Record<never, never>;

/** The `plugins` tuple carried by a concrete options type; `readonly []` when the options are the
 *  wide contract (no generic inference happened — e.g. an explicit `<typeof claw>` call, where the
 *  second type argument falls back to its default). */
export type PluginsOf<Options> = Options extends {
	plugins: infer P;
}
	? P extends readonly ClawClientPlugin[]
		? P
		: readonly []
	: readonly [];

type ServerPluginApiOf<P> = P extends { $InferServerPlugin: infer S }
	? S extends { $Api: infer Api }
		? InferClientApi<Api>
		: EmptyObject
	: EmptyObject;

type ActionsOf<P> = P extends {
	getActions: (...args: never[]) => infer Actions;
}
	? Actions
	: EmptyObject;

type AtomsOf<P> = P extends { getAtoms: (...args: never[]) => infer Atoms }
	? Atoms
	: EmptyObject;

// `UnionToIntersection<never>` is `never` and would poison the whole client type, so every fold
// guards the empty-plugins case first. Exported for the framework bindings' own folds (`./react`).
export type FoldPlugins<Plugins extends readonly ClawClientPlugin[], Folded> = [
	Plugins[number],
] extends [never]
	? EmptyObject
	: UnionToIntersection<Folded>;

/** Server plugin namespaces the client plugins carry as phantoms, wrapped for the wire. */
export type InferServerPluginApi<Plugins extends readonly ClawClientPlugin[]> =
	FoldPlugins<Plugins, ServerPluginApiOf<Plugins[number]>>;

export type InferClientActions<Plugins extends readonly ClawClientPlugin[]> =
	FoldPlugins<Plugins, ActionsOf<Plugins[number]>>;

export type InferClientAtoms<Plugins extends readonly ClawClientPlugin[]> =
	FoldPlugins<Plugins, AtomsOf<Plugins[number]>>;

/**
 * The client: the claw's api wrapped for the wire (base methods table-driven, plugin namespaces
 * proxy-routed — one call shape either way), plus what client plugins contribute. HONEST TYPING
 * LIMIT: TypeScript cannot infer the second generic when the first is explicit, so a
 * `createClawClient<typeof claw>(…)` call types the api surface fully but sees plugin
 * actions/atoms only through `$store.atoms` (untyped); a no-generic call infers plugins precisely
 * but types the base api against the DEFAULT claw config. Pick per call site.
 */
export type ClawClient<
	ClawLike extends ClawShape,
	Options extends ClawClientOptions,
> = InferClientApi<ClawLike["api"]> &
	InferServerPluginApi<PluginsOf<Options>> &
	InferClientActions<PluginsOf<Options>> &
	InferClientAtoms<PluginsOf<Options>> & {
		$fetch: ClawClientFetch;
		$store: ClawClientStore;
	};
