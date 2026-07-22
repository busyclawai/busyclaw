// The protocol shape of a streamed run: reader-facing text deltas plus an optional promise that
// settles when the producing run is fully done. Vendor-agnostic on purpose — any producer (the
// euroclaw runtime's `RuntimeStream`, a test fake, another loop) matches it structurally, and any
// consumer (the AI SDK response bridges in @euroclaw/vendors, an SSE adapter) accepts it. Kept here,
// near-zero-dep, so a bridge never has to import a whole engine just to name what it streams.

/**
 * Any producer of reader-facing text deltas. `result`, when present, resolves once the producing run
 * has fully finished (governance / tool loop / persistence) — a consumer that awaits it can close its
 * transport only after the run truly completes, not merely when the last delta arrives.
 */
export type TextDeltaStream = {
	readonly textStream: AsyncIterable<string>;
	readonly result?: Promise<unknown>;
};
