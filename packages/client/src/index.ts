// @euroclaw/client — the vanilla euroclaw client (docs/plans/claw-client-plan.md, slice 2).
// Base api methods are TABLE-driven off the shared contracts name list (no heuristic, no proxy);
// plugin namespaces ride the recursive function proxy with the one camelCase→kebab convention and
// the `get*`/`list*` → GET verb rule — the SAME `toKebabCase`/`endpointHttpMethod` pair the server
// mounts routes with, so client and server cannot disagree on a path. Zero server runtime in the
// bundle: `euroclaw` types cross via `import type` only, and contracts VALUES cross only through
// the docless wire subpaths (the contracts BARREL is import-type-only here — the structural
// guarantee tests/contracts-wire.test.ts enforces); runtime deps are those subpaths,
// @euroclaw/errors, and nanostores.

import { CLAW_API_METHOD_NAMES } from "@euroclaw/contracts/claw-api";
import type { EndpointHttpMethod } from "@euroclaw/contracts/governance/endpoints";
import {
	endpointHttpMethod,
	toKebabCase,
} from "@euroclaw/contracts/governance/endpoints";
import { configurationError } from "@euroclaw/errors";
import type { ReadableAtom, WritableAtom } from "nanostores";
import { createRouteProxy } from "./proxy";
import { createTransport } from "./transport";
import type {
	ClawClient,
	ClawClientAtomListener,
	ClawClientFetch,
	ClawClientOptions,
	ClawClientStore,
	ClawShape,
	DefaultClawShape,
} from "./types";

export type {
	ClawQueryAtomConfig,
	ClawQueryState,
} from "./query";
export { createQueryAtom } from "./query";
export type {
	ClawClient,
	ClawClientAtomListener,
	ClawClientError,
	ClawClientFetch,
	ClawClientOptions,
	ClawClientPlugin,
	ClawClientRequest,
	ClawClientStore,
	ClawFetchLike,
	ClawFetchOptions,
	ClawResult,
	ClawShape,
	InferClientApi,
} from "./types";

// A signal is a WRITABLE BOOLEAN atom by contract — listeners toggle it. Anything else under the
// referenced name (a query atom, an action) is a wiring bug surfaced at construction.
function requireSignalAtom(
	atoms: Readonly<Record<string, ReadableAtom<unknown>>>,
	signal: string,
	referencedBy: string,
): WritableAtom<boolean> {
	const candidate = atoms[signal] as Partial<WritableAtom<unknown>> | undefined;
	if (
		candidate === undefined ||
		typeof candidate.get !== "function" ||
		typeof candidate.set !== "function" ||
		typeof candidate.get() !== "boolean"
	) {
		throw configurationError(
			"euroclaw client signal is not a known boolean signal atom",
			{ referencedBy, signal },
		);
	}
	return candidate as WritableAtom<boolean>;
}

export function createClawClient<
	ClawLike extends ClawShape = DefaultClawShape,
	const Options extends ClawClientOptions = ClawClientOptions,
>(options?: Options): ClawClient<ClawLike, Options> {
	const resolved: ClawClientOptions = options ?? {};
	const plugins = resolved.plugins ?? [];
	const transport = createTransport(resolved);

	// The plugin-facing fetch: envelope-parsed, hook-threaded, but NEVER signal-dispatching — a
	// query atom's refetch must not re-toggle the signal that triggered it. Implemented over
	// `unknown` and asserted to the generic signature (the caller's `<T>` is a trust, not a parse).
	const clientFetch = (
		path: string,
		fetchOptions?: Parameters<ClawClientFetch>[1],
	) =>
		transport({
			input: fetchOptions?.input,
			method: fetchOptions?.method ?? "GET",
			path,
			...(fetchOptions?.signal ? { signal: fetchOptions.signal } : {}),
		});
	const $fetch = clientFetch as ClawClientFetch;

	// One flat client namespace — every key has exactly one owner, and a duplicate fails loud at
	// construction (deviation from better-auth's silent first-wins merge).
	const owners = new Map<string, string>();
	const claim = (key: string, owner: string): void => {
		const previous = owners.get(key);
		if (previous !== undefined) {
			throw configurationError("duplicate euroclaw client key", {
				key,
				owner,
				previous,
			});
		}
		owners.set(key, owner);
	};
	claim("$fetch", "client");
	claim("$store", "client");
	for (const name of CLAW_API_METHOD_NAMES) claim(name, "claw.api");

	const atoms: Record<string, ReadableAtom<unknown>> = {};
	for (const plugin of plugins) {
		for (const [key, value] of Object.entries(
			plugin.getAtoms?.($fetch) ?? {},
		)) {
			claim(key, `${plugin.id} atoms`);
			atoms[key] = value;
		}
	}

	const $store: ClawClientStore = {
		atoms,
		notify: (signal) => {
			const target = requireSignalAtom(atoms, signal, "$store.notify");
			target.set(!target.get());
		},
		listen: (signal, listener) =>
			requireSignalAtom(atoms, signal, "$store.listen").listen((value) => {
				listener(value === true);
			}),
	};

	// Listener wiring is validated NOW: a typo'd signal name is a construction error, never a
	// silently-dead refetch (better-auth returns early at call time — their gotcha, our deviation).
	const atomListeners: ClawClientAtomListener[] = [];
	for (const plugin of plugins) {
		for (const listener of plugin.atomListeners ?? []) {
			requireSignalAtom(atoms, listener.signal, `${plugin.id} atomListeners`);
			atomListeners.push(listener);
		}
	}

	// Verb overrides for proxy-routed paths; duplicates across plugins fail loud like every key.
	const pathMethods: Record<string, EndpointHttpMethod> = {};
	const pathMethodOwners = new Map<string, string>();
	for (const plugin of plugins) {
		for (const [path, method] of Object.entries(plugin.pathMethods ?? {})) {
			const previous = pathMethodOwners.get(path);
			if (previous !== undefined) {
				throw configurationError("duplicate euroclaw client pathMethods path", {
					owner: plugin.id,
					path,
					previous,
				});
			}
			pathMethodOwners.set(path, plugin.id);
			pathMethods[path] = method;
		}
	}

	// After a successful MUTATING call, matching listeners toggle their signal atoms — deferred
	// 10ms (the better-auth race-avoidance) and deduped per call so two matchers sharing a signal
	// toggle it once.
	const dispatchSignals = (routePath: string): void => {
		const toggled = new Set<string>();
		for (const listener of atomListeners) {
			if (!listener.matcher(routePath) || toggled.has(listener.signal)) {
				continue;
			}
			toggled.add(listener.signal);
			const signal = requireSignalAtom(atoms, listener.signal, "dispatch");
			const value = signal.get();
			setTimeout(() => {
				signal.set(!value);
			}, 10);
		}
	};

	const callApi = async (
		routePath: string,
		method: EndpointHttpMethod,
		input: unknown,
	): Promise<unknown> => {
		const result = await transport({ input, method, path: routePath });
		if (result.error === null && method === "POST") dispatchSignals(routePath);
		return result;
	};

	// The base api table: every flat method is a plain function over its derived route. Same list,
	// same splitter, same verb rule as the server's `clawApiRouteList`.
	const baseMethods = Object.fromEntries(
		CLAW_API_METHOD_NAMES.map((name) => [
			name,
			(input: unknown) =>
				callApi(`/${toKebabCase(name)}`, endpointHttpMethod(name), input),
		]),
	);

	const known: Record<string, unknown> = { ...baseMethods, ...atoms };
	for (const plugin of plugins) {
		for (const [key, value] of Object.entries(
			plugin.getActions?.($fetch, $store) ?? {},
		)) {
			claim(key, `${plugin.id} actions`);
			known[key] = value;
		}
	}
	known.$fetch = $fetch;
	known.$store = $store;

	// Everything unresolved routes by convention: `client.secrets.set(...)` →
	// `POST /secrets/set`, nested groups deepen the path, a plugin `pathMethods` entry overrides
	// the verb, and the LAST camelCase segment (not the kebab path) feeds the name rule — exactly
	// how the server derives the mounted route.
	const client = createRouteProxy({
		call: (segments, args) => {
			const routePath = `/${segments.map(toKebabCase).join("/")}`;
			const last = segments[segments.length - 1] ?? "";
			const method = pathMethods[routePath] ?? endpointHttpMethod(last);
			return callApi(routePath, method, args[0]);
		},
		known,
	});
	return client as ClawClient<ClawLike, Options>;
}
