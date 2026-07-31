// Ask an adapter, once, whether the database can enforce what the declaration requires — before it
// is allowed to write anything.
//
// The check itself belongs to the adapter (only it knows what its backend can be asked), but WHEN to
// run it does not. Construction is synchronous, so the assembly cannot await there; and a process
// that never touches the database should not pay for a round-trip it will never need. So the answer
// is: lazily, on the first operation, once.
//
// An adapter with no `verifySchema` is returned UNCHANGED — not wrapped, not proxied. There is
// nothing to ask, so adding a layer would only put a function call in front of every operation for
// the backends that already enforce their schema by migrating it.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";

/**
 * Wrap an adapter so its first operation verifies the schema and everything after inherits the
 * answer.
 *
 * Memoized on the PROMISE rather than the result, so concurrent first operations share one
 * verification instead of racing several round-trips at exactly the moment a process is busiest.
 *
 * A FAILED check is deliberately not memoized. The failure it reports is one an operator fixes by
 * doing something to the database — creating an index — and having to bounce the process to be
 * believed turns a clear message into a confusing one. The next operation asks again.
 */
export function verifiedAdapter(
	adapter: Adapter,
	schema: SchemaDeclaration,
): Adapter {
	const verify = adapter.verifySchema;
	if (!verify) return adapter;

	let pending: Promise<void> | undefined;
	const ensure = async (): Promise<void> => {
		const attempt = pending ?? verify(schema);
		pending = attempt;
		try {
			await attempt;
		} catch (error) {
			pending = undefined;
			throw error;
		}
	};

	// Every method, and the reason to be exhaustive rather than clever: a READ against an
	// unconstrained database is not the problem, but a read is also how most callers touch the
	// adapter first — so verifying only on writes would report the failure late, in the middle of a
	// request, rather than the first time the process spoke to the database at all.
	const gate = <A extends unknown[], R>(
		fn: ((...args: A) => Promise<R>) | undefined,
	): ((...args: A) => Promise<R>) | undefined =>
		fn &&
		(async (...args: A) => {
			await ensure();
			return fn(...args);
		});

	return {
		...adapter,
		create: gate(adapter.create) as Adapter["create"],
		findOne: gate(adapter.findOne) as Adapter["findOne"],
		findMany: gate(adapter.findMany) as Adapter["findMany"],
		count: gate(adapter.count) as Adapter["count"],
		update: gate(adapter.update) as Adapter["update"],
		updateMany: gate(adapter.updateMany) as Adapter["updateMany"],
		delete: gate(adapter.delete) as Adapter["delete"],
		deleteMany: gate(adapter.deleteMany) as Adapter["deleteMany"],
		...(adapter.consumeOne
			? { consumeOne: gate(adapter.consumeOne) as Adapter["consumeOne"] }
			: {}),
		...(adapter.transaction ? { transaction: adapter.transaction } : {}),
	};
}
