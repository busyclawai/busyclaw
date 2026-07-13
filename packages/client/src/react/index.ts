// @euroclaw/client/react — the react binding (docs/plans/claw-client-plan.md, slice 3). The
// ENTIRE vanilla runtime is reused as-is: this entry builds the vanilla client, then wraps it in
// ONE forwarding proxy that additionally answers `use${Capitalize(atomKey)}` for every atom in
// the runtime registry (`$store.atoms` — plugin `getAtoms` today, core atoms whenever they land)
// as a `useStore`-backed hook. React must never leak into the root entry: this subpath is the
// only module graph that imports it, which is what lets `react` stay an OPTIONAL peer.

import { configurationError } from "@euroclaw/errors";
import { createClawClient as createVanillaClawClient } from "../index";
import type {
	ClawClient,
	ClawClientOptions,
	ClawClientPlugin,
	ClawShape,
	DefaultClawShape,
	EmptyObject,
	FoldPlugins,
	PluginsOf,
} from "../types";
import { useStore } from "./use-store";

export { useStore } from "./use-store";

// Runtime twin of TS `Capitalize<K>`: uppercase the first char, keep the rest (a `$`-prefixed
// signal key survives unchanged in both worlds).
function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/** One plugin's atoms as hooks: `pendingApprovals` → `usePendingApprovals: () => <atom value>`.
 *  `$`-prefixed SIGNAL atoms are hidden from the type (renaming a refetch trigger helps nobody)
 *  while the runtime maps every atom uniformly — better-auth parity on both counts. */
type HooksOf<P> = P extends {
	getAtoms: (...args: never[]) => infer Atoms;
}
	? {
			[K in keyof Atoms as K extends `$${string}`
				? never
				: K extends string
					? `use${Capitalize<K>}`
					: never]: Atoms[K] extends { get: () => infer Value }
				? () => Value
				: never;
		}
	: EmptyObject;

export type InferResolvedHooks<Plugins extends readonly ClawClientPlugin[]> =
	FoldPlugins<Plugins, HooksOf<Plugins[number]>>;

/** The react client: the vanilla surface untouched, plus a hook per (non-signal) atom. The same
 *  honest typing limit as the vanilla client applies: an explicit `<typeof claw>` call defaults
 *  the options generic, so plugin atoms — and therefore their hooks — go untyped there. */
export type ReactClawClient<
	ClawLike extends ClawShape,
	Options extends ClawClientOptions,
> = ClawClient<ClawLike, Options> & InferResolvedHooks<PluginsOf<Options>>;

export function createClawClient<
	ClawLike extends ClawShape = DefaultClawShape,
	const Options extends ClawClientOptions = ClawClientOptions,
>(options?: Options): ReactClawClient<ClawLike, Options> {
	const vanilla = createVanillaClawClient<ClawLike, Options>(options);

	// A hook per atom off the one runtime registry. Distinct atom keys can still collide AFTER
	// capitalization ("fooBar"/"FooBar") — fail loud like every other client key claim.
	const hooks = new Map<string, () => unknown>();
	for (const [key, store] of Object.entries(vanilla.$store.atoms)) {
		const hookKey = `use${capitalize(key)}`;
		if (hooks.has(hookKey)) {
			throw configurationError("duplicate euroclaw client hook key", {
				atom: key,
				hook: hookKey,
			});
		}
		const useAtom = (): unknown => useStore(store);
		hooks.set(hookKey, useAtom);
	}

	// Hooks resolve FIRST (a `use*` name must be the hook, never a convention route); everything
	// else — base methods, actions, atoms, `$fetch`/`$store`, proxy namespaces — forwards to the
	// vanilla client untouched.
	const wrapped = new Proxy(vanilla as object, {
		get(target, prop, receiver) {
			if (typeof prop === "string") {
				const hook = hooks.get(prop);
				if (hook !== undefined) return hook;
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return wrapped as ReactClawClient<ClawLike, Options>;
}
