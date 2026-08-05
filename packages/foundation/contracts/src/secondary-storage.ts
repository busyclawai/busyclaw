// SECONDARY STORAGE — the fast, expiring, key-value seam beside the durable `Adapter`.
//
// Adapted from better-auth's `SecondaryStorage` (packages/core/src/db/type.ts), whose shape this
// deliberately matches so a host that already has a Redis adapter for one can hand the same object to
// the other.
//
// THE DIVISION OF LABOUR, because "we have two stores now" is the kind of thing that rots:
//
//   Adapter            the RECORD. Rows somebody may need to read back, audit, or erase. Migrated,
//                      typed per model, transactional. Losing it loses data.
//   SecondaryStorage   the BUFFER. Values with a lifetime, that a later reader may want and nobody
//                      will miss. No schema, no migration, no transaction. Losing it loses speed.
//
// Nothing durable may live here alone. The test is not "is it important" but "if this store were
// wiped mid-flight, would anything be unrecoverable" — and the answer has to be no.
//
// ITS FIRST CONSUMER IS THE RUN STREAM (docs/plans/one-run.md D17): live deltas of a run in flight,
// which several people may watch and which are worthless the moment the turn lands in the transcript.
// Three members make it fit that job better than a plain KV would:
//   - `increment` allocates a stream offset atomically, which is what `Last-Event-ID` resolves against
//   - `set(…, ttl)` makes cleanup a property of the write rather than a sweep somebody has to fund
//   - `getAndDelete` is a consume nobody else can double-read
//
// Optional members are optional because a host may bring an implementation that predates them, not
// because they are decorative. A consumer that needs one must check for it and say what it does
// without it — never silently degrade into a race.

/** A value a port may return synchronously or not. */
export type Awaitable<T> = T | Promise<T>;

export type SecondaryStorage = {
	/** The value at `key`, or null/undefined when absent. Implementations return whatever their
	 *  client returns — the caller parses; this layer stores opaque strings. */
	get: (key: string) => Awaitable<unknown>;
	/**
	 * Read and remove in ONE operation, so two readers cannot both consume the same value.
	 *
	 * Optional for the same reason better-auth keeps it optional — implementations exist that predate
	 * it. A consumer that needs single-use semantics must check for it and refuse rather than fall
	 * back to get-then-delete, which is the race it exists to close.
	 */
	getAndDelete?: (key: string) => Awaitable<unknown>;
	/**
	 * Atomically add one to the counter at `key` and return the value AFTER the increment.
	 *
	 * Absent key ⇒ created at `1` with `ttl` SECONDS. The ttl applies only at creation and later
	 * increments never extend it, so the counter expires a fixed window after it first appeared —
	 * which is what makes it usable as a bounded sequence rather than an immortal one.
	 */
	increment?: (key: string, ttl: number) => Awaitable<number>;
	/** Store `value` at `key`, expiring after `ttl` SECONDS when given. No ttl means no expiry, which
	 *  in a store defined as a buffer should be rare and deliberate. */
	set: (
		key: string,
		value: string,
		ttl?: number | undefined,
	) => Awaitable<void | null | unknown>;
	delete: (key: string) => Awaitable<void | null | string>;
};
