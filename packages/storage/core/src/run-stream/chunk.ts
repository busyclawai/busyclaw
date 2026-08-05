// How a chunk becomes bytes and back — the one place either direction is decided.
//
// Every `RunStreamPort` implementation stores the same thing (one chunk, one JSON document) and
// faces the same question on the way back: what to do with an entry it cannot read. Both had their
// own answer before this file existed, which is one divergence away from a backend that throws where
// its sibling skips.

import type { RunStreamChunk } from "@busyclaw/contracts";

/** The chunk kinds this codec will hand back. Anything else is treated as unreadable rather than
 *  passed through — a chunk written by a newer version is not a chunk this reader understands. */
const KINDS = new Set(["text", "lifecycle", "run.started"]);

export function encodeChunk(chunk: RunStreamChunk): string {
	return JSON.stringify(chunk);
}

/**
 * Decode one stored entry, or `null` if it cannot be read.
 *
 * NULL RATHER THAN THROW, and the reason is what this store is: a transport buffer, not a record. One
 * unreadable entry — a truncated write, a document from a future version, something another process
 * put in the same key — must not take down the live view of everything around it. Callers skip a
 * null and advance past it, so a bad entry cannot strand a reader on a cursor either.
 */
export function decodeChunk(raw: unknown): RunStreamChunk | null {
	if (typeof raw !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const kind = (parsed as { kind?: unknown }).kind;
		return typeof kind === "string" && KINDS.has(kind)
			? (parsed as RunStreamChunk)
			: null;
	} catch {
		return null;
	}
}
