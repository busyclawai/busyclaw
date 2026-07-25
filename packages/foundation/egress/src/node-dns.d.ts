// Minimal ambient typing for the ONE node builtin the egress floor uses to resolve a host to its
// addresses. euroclaw packages deliberately avoid `@types/node` (they target any modern JS runtime
// and reach for `@noble/hashes` over `node:crypto`, web `fetch`/`URL` over node http). The egress
// floor is inherently a Node-side network control, so it types ONLY the single `lookup` signature
// it needs here, rather than adding the whole of `@types/node` as a dependency.
declare module "node:dns/promises" {
	export function lookup(
		hostname: string,
		options: { all: true },
	): Promise<{ address: string; family: number }[]>;
}
