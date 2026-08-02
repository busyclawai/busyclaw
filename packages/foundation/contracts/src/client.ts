// The CLIENT-PLUGIN protocol — the vocabulary a plugin author needs to declare a client half,
// without depending on the client implementation.
//
// It lived in the client, which made the arrow point the wrong way: a plugin shipping its own client
// half had to depend on the client package, and the client depended (for its tests) on the assembly,
// which depends on the plugins. Turbo named it — "Circular package dependency detected:
// @busyclaw/adapter-core, @busyclaw/client, @busyclaw/secrets-plugin, busyclaw" — and the workaround
// was worse than the cycle: the plugin's client half was kept INSIDE the client package, so the
// client imported a plugin it has no business knowing about, and that import leaked into its
// published .d.ts.
//
// So the contract moves to the package both halves already depend on. This is the same split
// better-auth makes: `BetterAuthClientPlugin` is defined in @better-auth/core, the shared package,
// and merely RE-EXPORTED from better-auth/client — which is why an out-of-tree plugin like
// @better-auth/stripe can ship `./client` without the core client ever hearing about it.
//
// It stays here now that the client is a `busyclaw/client` subpath, and for the same reason: a
// plugin cannot depend on `busyclaw` (busyclaw depends on the plugins), so the shared vocabulary
// has to live below both.
//
// Protocol, not implementation: no fetch runs here, no atom is created. @busyclaw/client re-exports
// every name below, so `busyclaw/client`'s public surface is unchanged.

import type { ReadableAtom } from "nanostores";
import type { AbortLifetime } from "./governance/boundary";
import type { EndpointHttpMethod } from "./governance/endpoints";

/** What a failed call resolves with. `status` is the HTTP status — `0` when the transport itself
 *  failed (fetch threw: DNS, abort, a broken stub). `code` is the server's stable BusyclawErrorCode
 *  when the envelope carried one. */
export type ClawClientError = {
	status: number;
	message: string;
	code?: string;
};

/** Every remote call resolves this — never throws for HTTP/envelope errors. */
export type ClawResult<T> =
	| { data: T; error: null }
	| { data: null; error: ClawClientError };

export type ClawFetchOptions = {
	/** Wire verb; defaults to GET. GET sends `?input=<json>`, POST sends a JSON body. */
	method?: EndpointHttpMethod;
	/** The call input. */
	input?: unknown;
	/** {@link AbortLifetime}, not `AbortSignal`: contracts builds without the DOM lib on purpose — it
	 *  is the protocol every tier shares, including ones with no browser globals. A real
	 *  `AbortSignal` satisfies it, so callers pass one and nothing casts. */
	signal?: AbortLifetime;
};

/** The envelope-parsed fetch handed to client plugins (`getActions`/`getAtoms`): path-relative,
 *  base-url/headers/hooks already applied, resolves `{ data, error }`. Calls through it do NOT
 *  trigger atom signals (query refetches must never re-signal themselves). */
export type ClawClientFetch = <T = unknown>(
	path: string,
	options?: ClawFetchOptions,
) => Promise<ClawResult<T>>;

export type ClawClientStore = {
	notify: (signal: string) => void;
	listen: (signal: string, listener: (value: boolean) => void) => () => void;
	atoms: Readonly<Record<string, ReadableAtom<unknown>>>;
};

export type ClawClientAtomListener = {
	/** Matches the route path of a successful MUTATING (POST) call, e.g. `"/grant-approval"`. */
	matcher: (path: string) => boolean;
	/** Name of a boolean signal atom some plugin's `getAtoms` contributed. A name no plugin
	 *  contributed fails loud at client CONSTRUCTION, not silently at call time. */
	signal: string;
};

export type ClawClientPlugin = {
	id: string;
	/** TYPE-ONLY phantom carrying the server plugin's type (`{} as ServerPlugin`) so its `$Api`
	 *  namespaces type the client even without `typeof claw`. `{}` at runtime — never read. */
	$InferServerPlugin?: unknown;
	/** Client-side methods merged onto the client root. Key collisions (base api methods, other
	 *  plugins' actions/atoms, `$fetch`/`$store`) fail loud at construction. */
	getActions?: (
		$fetch: ClawClientFetch,
		$store: ClawClientStore,
	) => Record<string, unknown>;
	/** State atoms merged onto the client root under their own names (framework bindings rename to
	 *  hooks later). `$`-prefixed boolean atoms are signals by convention. */
	getAtoms?: ($fetch: ClawClientFetch) => Record<string, ReadableAtom<unknown>>;
	/** Verb overrides for proxy-routed paths whose server endpoint declared a `method` the
	 *  `get*`/`list*` name rule cannot derive. */
	pathMethods?: Readonly<Record<string, EndpointHttpMethod>>;
	/** Refetch wiring: after a successful mutating call whose path matches, the named signal atom
	 *  toggles (10ms deferred, deduped per call) and subscribed query atoms refetch. */
	atomListeners?: readonly ClawClientAtomListener[];
};
