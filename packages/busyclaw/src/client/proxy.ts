// The recursive FUNCTION proxy behind plugin namespaces (adapted from better-auth's
// createDynamicPathProxy — see THIRD_PARTY_NOTICES.md): every node is both navigable and callable,
// so `client.secrets.set(...)` needs no per-namespace registration. EVERY known value (the base
// method table, plugin actions, atoms, `$fetch`/`$store`) is returned verbatim — functions,
// atoms, and plain objects alike, so `client.$store` IS the concrete registry (enumerable,
// identity-stable) rather than a proxy node; only unresolved names deepen the path, and calling
// an unresolved node dispatches by convention. Corollary: an unknown member under a KNOWN
// object-valued key is a natural `undefined`, never a route — a name a plugin owns cannot also
// silently address the server.
//
// The thenable guard is load-bearing: without `then`/`catch`/`finally` → `undefined`, an
// `await client.secrets` would treat the proxy as a promise and hang the await forever.

const proxyTarget = () => undefined;

export function createRouteProxy(input: {
	known: Readonly<Record<string, unknown>>;
	call: (
		segments: readonly string[],
		args: readonly unknown[],
	) => Promise<unknown>;
}): unknown {
	const resolveKnown = (segments: readonly string[]): unknown => {
		let current: unknown = input.known;
		for (const segment of segments) {
			if (current === null || typeof current !== "object") return undefined;
			if (!(segment in current)) return undefined;
			current = (current as Record<string, unknown>)[segment];
		}
		return current;
	};

	const createNode = (segments: readonly string[]): unknown =>
		new Proxy(proxyTarget, {
			get(_target, prop) {
				if (typeof prop !== "string") return undefined;
				if (prop === "then" || prop === "catch" || prop === "finally") {
					return undefined;
				}
				const path = [...segments, prop];
				const resolved = resolveKnown(path);
				if (resolved !== undefined) return resolved;
				return createNode(path);
			},
			apply(_target, _thisArg, args) {
				return input.call(segments, args);
			},
		});

	return createNode([]);
}
