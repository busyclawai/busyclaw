// Discovery of endpoints() namespaces under a claw api — the ONE definition of "mounted", shared by
// the route table (index.ts) and the OpenAPI generator (openapi.ts) so the two can never disagree
// about which namespaces exist or where they prefix.

import type { EndpointRoute } from "@euroclaw/contracts";
import { endpointRoutesOf, toKebabCase } from "@euroclaw/contracts";

export type MountedEndpoints = {
	/** Dotted api keys as written (`channels.registrations`) — error messages speak the caller's names. */
	name: string;
	/** Kebab mount prefix (`/channels/registrations`) — same splitter as the routes it prefixes. */
	prefix: string;
	routes: readonly EndpointRoute[];
};

// Find every endpoints() namespace under an api value: a metadata carrier mounts (its own route table
// is already flattened — no recursion past it); a plain object recurses so wrappers like
// `{ channels: { registrations: <endpoints> } }` mount at their full key path; functions are flat api
// methods and plain values are in-process-only members — neither is walked. The WeakSet keeps a
// self-referential api object from hanging assembly.
function collectEndpointNamespaces(input: {
	value: unknown;
	name: string;
	prefix: string;
	seen: WeakSet<object>;
	out: MountedEndpoints[];
}): void {
	const { value } = input;
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return;
	if (input.seen.has(value)) return;
	input.seen.add(value);
	const routes = endpointRoutesOf(value);
	if (routes) {
		input.out.push({ name: input.name, prefix: input.prefix, routes });
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		collectEndpointNamespaces({
			value: child,
			name: `${input.name}.${key}`,
			prefix: `${input.prefix}/${toKebabCase(key)}`,
			seen: input.seen,
			out: input.out,
		});
	}
}

/** Every endpoints() namespace mounted under `api`, with its dotted name and kebab route prefix. */
export function mountedEndpointNamespaces(api: unknown): MountedEndpoints[] {
	const namespaces: MountedEndpoints[] = [];
	const seen = new WeakSet<object>();
	if (api === null || typeof api !== "object") return namespaces;
	for (const [key, value] of Object.entries(api as Record<string, unknown>)) {
		collectEndpointNamespaces({
			value,
			name: key,
			prefix: `/${toKebabCase(key)}`,
			seen,
			out: namespaces,
		});
	}
	return namespaces;
}
