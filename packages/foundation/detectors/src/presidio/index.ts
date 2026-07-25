// @euroclaw/detectors/presidio — Microsoft Presidio's analyzer behind euroclaw's Detector port.
// Async (HTTP POST /analyze, the whole API is one route). ANALYZER ONLY: the euroclaw redactor
// already owns the pseudonymization map, overlap resolution, and dedup, so this detector only
// FINDS spans — building a second redaction mechanism (presidio-anonymizer) is pointless here.
//
// This file's one subtle job is the OFFSET BOUNDARY. Presidio is Python; its start/end are Unicode
// CODE POINTS. JavaScript strings are UTF-16, so our spans must be code-UNIT indices. For plain
// text they coincide — then one emoji or astral char shifts every following offset and silently
// corrupts the slice. Conversion happens HERE, at the vendor edge (codePointToUtf16).
//
// ENTITY MAPPING is CONSERVATIVE and CLOSED: unmapped Presidio types are DROPPED, and DATE_TIME is
// deliberately unmapped — a birth date and an employment year-range both come back as DATE_TIME at
// the same NER-grade score, so the type carries no signal to tell PII from noise. Names and
// locations are what this vendor is FOR: the categories regex cannot reach.
import type { Detector, PiiKind, PiiSpan } from "@euroclaw/contracts";

/** Below this a hit is noise, not PII — the one knob, client-side. Proven live: a spurious
 *  US_DRIVER_LICENSE fires at 0.01 over a phone number; a real recognizer scores ≥0.5. */
export const DEFAULT_SCORE_FLOOR = 0.35;

/**
 * The DEFAULT closed map: Presidio's stock vocabulary → euroclaw's PiiKind. Presence = mapped;
 * absence = dropped. DATE_TIME is intentionally absent (see header). Different Presidio deployments
 * emit different labels (a GLiNER model with custom entities, a medical de-id model with MRN/AGE),
 * so this is overridable per detector via `entityMap` — spread this to extend, or replace wholesale
 * for an exotic label set. Adding an entry stays a conscious, test-gated event either way.
 */
export const presidioDefaultEntityMap: Readonly<Record<string, PiiKind>> = {
	EMAIL_ADDRESS: "email",
	PHONE_NUMBER: "phone",
	PERSON: "name",
	LOCATION: "address",
	CREDIT_CARD: "card",
	IBAN_CODE: "id",
	US_SSN: "id",
	IP_ADDRESS: "id",
	CRYPTO: "id",
	URL: "url",
};

/** Presidio entity_type → euroclaw kind, or null for "drop this hit". */
export function presidioKindOf(
	entityType: string,
	entityMap: Readonly<Record<string, PiiKind>> = presidioDefaultEntityMap,
): PiiKind | null {
	return entityMap[entityType] ?? null;
}

/** Python str index (code point) → JavaScript string index (UTF-16 code unit). Clamps an index at
 *  or past the end to the string's length, rather than throwing. */
export function codePointToUtf16(text: string, codePointIndex: number): number {
	if (codePointIndex <= 0) return 0;
	let codePoints = 0;
	let units = 0;
	for (const char of text) {
		if (codePoints === codePointIndex) return units;
		units += char.length; // 1 for BMP, 2 for a surrogate pair
		codePoints += 1;
	}
	return units;
}

/**
 * The same conversion for MANY indices in ONE walk. Calling `codePointToUtf16` per offset rescans
 * the text from zero every time, so a long document with many hits costs O(rows × length) — the
 * analyzer's own recall turns into the redaction path's slowdown, on the synchronous-to-the-caller
 * ingress route. Sorting the wanted indices and walking once is O(length + rows log rows), with the
 * identical surrogate handling and the identical clamp at both ends.
 */
function utf16OffsetsFor(
	text: string,
	codePointIndices: readonly number[],
): ReadonlyMap<number, number> {
	const wanted = [...new Set(codePointIndices)].sort((a, b) => a - b);
	const out = new Map<number, number>();
	let i = 0;
	// Everything at or below zero clamps to the start.
	for (; i < wanted.length; i++) {
		const want = wanted[i];
		if (want === undefined || want > 0) break;
		out.set(want, 0);
	}
	let codePoints = 0;
	let units = 0;
	for (const char of text) {
		while (i < wanted.length && wanted[i] === codePoints) {
			out.set(codePoints, units);
			i++;
		}
		units += char.length;
		codePoints += 1;
	}
	// Anything still unresolved sits at or past the end — clamp to the full length.
	for (; i < wanted.length; i++) {
		const want = wanted[i];
		if (want !== undefined) out.set(want, units);
	}
	return out;
}

/** One row of Presidio's /analyze response (snake_case, as the service emits it). */
export type PresidioResult = {
	entity_type: string;
	start: number;
	end: number;
	score: number;
};

function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}

/** Tunables for {@link presidioSpans}: the noise floor and the entity→kind map (per model). */
export type PresidioSpanOptions = {
	scoreFloor?: number;
	entityMap?: Readonly<Record<string, PiiKind>>;
};

/**
 * The pure assembly: Presidio rows + the exact text analyzed → euroclaw spans. Drops unmapped
 * entities and sub-floor hits; converts offsets; fills `value` by slicing (euroclaw spans carry
 * the value — the redactor is what makes it die into a placeholder). Overlaps are left INTACT:
 * resolving them is the redactor's job (earliest start wins, ties to the longer span).
 */
export function presidioSpans(
	results: readonly PresidioResult[],
	text: string,
	options: PresidioSpanOptions = {},
): PiiSpan[] {
	const scoreFloor = options.scoreFloor ?? DEFAULT_SCORE_FLOOR;
	const entityMap = options.entityMap ?? presidioDefaultEntityMap;
	// Keep only the rows that will actually become spans, then convert every surviving offset in one
	// pass over the text (see utf16OffsetsFor).
	const kept: { row: PresidioResult; kind: PiiKind }[] = [];
	for (const row of results) {
		const kind = presidioKindOf(row.entity_type, entityMap);
		if (kind === null) continue; // unmapped (incl. DATE_TIME)
		// Written as "not at or above the floor" so a NaN score is DROPPED rather than kept: `NaN <
		// floor` is false, so the original comparison let a garbage score through and then reported it
		// as the span's confidence.
		if (!(row.score >= scoreFloor)) continue; // noise, or not a usable score
		kept.push({ row, kind });
	}
	const offsets = utf16OffsetsFor(
		text,
		kept.flatMap(({ row }) => [row.start, row.end]),
	);
	const spans: PiiSpan[] = [];
	for (const { row, kind } of kept) {
		const start = offsets.get(row.start);
		const end = offsets.get(row.end);
		if (start === undefined || end === undefined) continue;
		if (start >= end) continue; // defensive: a degenerate or reversed span
		spans.push({
			start,
			end,
			value: text.slice(start, end),
			kind,
			confidence: clamp01(row.score),
			source: "model",
		});
	}
	return spans;
}

/**
 * The analyzer's body is an untrusted NETWORK boundary and its shape is a version contract, so it is
 * checked rather than cast.
 *
 * The cast this replaces was the dangerous kind: a drifted or hostile body (a `{detail: …}` error
 * object, a rename of `entity_type`, an HTML error page parsed as JSON) produced rows nothing could
 * read, every one was skipped, and the detector returned `[]` — indistinguishable downstream from a
 * clean "no PII in this text". The redaction then passes the text through untouched. A detector must
 * fail CLOSED, which for a shape it cannot read means throwing.
 */
function assertPresidioRows(body: unknown): readonly PresidioResult[] {
	if (!Array.isArray(body)) {
		throw new Error(
			"presidio /analyze returned a non-array body — refusing to read it as 'no PII found'",
		);
	}
	for (const row of body) {
		if (row === null || typeof row !== "object") {
			throw new Error("presidio /analyze returned a non-object row");
		}
		const candidate = row as Record<string, unknown>;
		const { entity_type: entityType, start, end, score } = candidate;
		if (
			typeof entityType !== "string" ||
			typeof start !== "number" ||
			typeof end !== "number" ||
			typeof score !== "number" ||
			!Number.isFinite(start) ||
			!Number.isFinite(end) ||
			!Number.isFinite(score)
		) {
			throw new Error(
				"presidio /analyze returned a row that is not {entity_type, start, end, score} — the analyzer's response shape changed",
			);
		}
	}
	return body as readonly PresidioResult[];
}

export type PresidioOptions = {
	/** The analyzer's base URL, e.g. "http://localhost:5002". */
	url: string;
	/** What the analyzer's NLP engine reads the text as. Default "en". */
	language?: string;
	/** Below this score a hit is dropped. Default {@link DEFAULT_SCORE_FLOOR}. */
	scoreFloor?: number;
	/** entity_type → kind for THIS model. Default {@link presidioDefaultEntityMap}; override for a
	 *  model with a different label set (spread the default to extend, or replace wholesale). */
	entityMap?: Readonly<Record<string, PiiKind>>;
	/** Presidio has no native auth; a baked gate can check `X-Api-Key`. Omit → no header. */
	apiKey?: string;
	/** Per-request deadline. The redaction path waits on this call, so an analyzer that accepts the
	 *  connection and then stalls would hold the caller for as long as the ambient fetch allows —
	 *  which on some runtimes is forever. Default 10 s; the abort surfaces as a throw, so the
	 *  detector still fails CLOSED. */
	timeoutMs?: number;
	/** Injectable transport (tests, custom agents/retry). Default the global `fetch`. */
	fetch?: typeof globalThis.fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Build a Presidio-backed {@link Detector}. FAIL-CLOSED: a non-ok response throws, so a Presidio
 * outage fails the redaction rather than letting unredacted text reach the model. (No built-in
 * retry — wrap the transport if you need cold-start resilience.)
 */
export function presidioDetector(options: PresidioOptions): Detector {
	const language = options.language ?? "en";
	const scoreFloor = options.scoreFloor ?? DEFAULT_SCORE_FLOOR;
	const entityMap = options.entityMap ?? presidioDefaultEntityMap;
	const doFetch = options.fetch ?? globalThis.fetch;
	const endpoint = `${options.url}/analyze`;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return async (text) => {
		if (text.trim() === "") return []; // nothing to analyze; skip the round-trip
		const response = await doFetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(options.apiKey !== undefined
					? { "x-api-key": options.apiKey }
					: {}),
			},
			body: JSON.stringify({ text, language }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				`presidio /analyze failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
			);
		}
		const rows = assertPresidioRows(await response.json());
		return presidioSpans(rows, text, { scoreFloor, entityMap });
	};
}
