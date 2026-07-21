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
	const spans: PiiSpan[] = [];
	for (const row of results) {
		const kind = presidioKindOf(row.entity_type, entityMap);
		if (kind === null) continue; // unmapped (incl. DATE_TIME)
		if (row.score < scoreFloor) continue; // noise
		const start = codePointToUtf16(text, row.start);
		const end = codePointToUtf16(text, row.end);
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
	/** Injectable transport (tests, custom agents/retry). Default the global `fetch`. */
	fetch?: typeof globalThis.fetch;
};

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
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				`presidio /analyze failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
			);
		}
		const rows = (await response.json()) as PresidioResult[];
		return presidioSpans(rows, text, { scoreFloor, entityMap });
	};
}
