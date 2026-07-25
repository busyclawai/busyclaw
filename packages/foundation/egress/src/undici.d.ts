// Minimal ambient typing for the ONE undici surface the egress floor needs: an Agent whose connect
// step resolves through a supplied `lookup`, so a request can be pinned to the address the floor
// already vetted. Same rule as node-dns.d.ts next door — euroclaw packages deliberately avoid
// `@types/node`, and undici's shipped types are written against it, so this types only what is used
// here rather than pulling the whole of `@types/node` in behind it.
//
// Internal to this package: `node.ts` hands callers an opaque `PinnedConnection`, so no undici type
// crosses a package boundary and no consumer inherits this declaration.
declare module "undici" {
	/** The node:dns `lookup` contract, narrowed to what the pinning resolver answers. */
	export type UndiciLookup = (
		hostname: string,
		options: { all?: boolean } | undefined,
		callback: (
			err: Error | null,
			address: string | { address: string; family: number }[],
			family?: number,
		) => void,
	) => void;

	export class Dispatcher {
		close(): Promise<void>;
	}

	export class Agent extends Dispatcher {
		constructor(options?: { connect?: { lookup?: UndiciLookup } });
	}
}
