// @euroclaw/detectors/regex — the deterministic, synchronous PII detector: high-precision spans
// for the categories a pattern reaches EXACTLY. Offsets are plain JavaScript string indices (no
// code-point conversion — that boundary is Presidio's problem, not this one). Detection is policy,
// so this lives outside @euroclaw/core; the redactor owns overlap resolution, dedup, and the
// mapping store, so a span here is just {where, what, the matched text}.
//
// PRECISION over recall, deliberately: over-detection costs one needless placeholder (safe),
// noise costs trust. Every category is either shape-anchored (email) or checksum-gated (card
// Luhn, IBAN mod-97), and phone carries the guards deckerhr's v1 taught — a 7..15 digit gate, a
// year-range reject ("2021-2026" is employment, not a number), and suppression when the digits
// live inside a stronger match (an email's local part, a card, an IBAN). Names/addresses/dates
// are NOT here — they need NER (@euroclaw/detectors/presidio).
import type { Detector, PiiSpan } from "@euroclaw/contracts";

// Pragmatic, not RFC 5321 — the RFC grammar matches things no message contains and misses nothing
// one does.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A digit run with phone punctuation, bounded by digits. The digit gate below does the real
// filtering; this only proposes candidates.
const PHONE_CANDIDATE = /\+?\d[\d\s().\-/]{4,}\d/g;
// "2021-2026" — the single most common phone false positive. Reject the shape outright.
const YEAR_RANGE = /^\d{4}\s*[-–—/]\s*\d{4}$/;
// 13..19 digits with optional single space/hyphen separators (a payment card's printed forms).
const CARD_CANDIDATE = /\d(?:[ -]?\d){12,18}/g;
// IBAN: country + check digits + a body of alnum groups (electronic run or space-grouped). The
// mod-97 gate rejects the over-matches this loose shape admits.
const IBAN_CANDIDATE =
	/[A-Z]{2}\d{2}(?: ?[A-Za-z0-9]{4})+(?: ?[A-Za-z0-9]{1,3})?/g;

const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15; // E.164's ceiling
const MIN_IBAN_LENGTH = 15;
const MAX_IBAN_LENGTH = 34;

const EMAIL_CONFIDENCE = 0.9;
const PHONE_CONFIDENCE = 0.7;
const CARD_CONFIDENCE = 0.95; // Luhn passed
const IBAN_CONFIDENCE = 0.95; // mod-97 passed

type Range = { readonly start: number; readonly end: number };

function overlapsAny(candidate: Range, taken: readonly Range[]): boolean {
	return taken.some((r) => candidate.start < r.end && r.start < candidate.end);
}

function digitsOnly(text: string): string {
	return text.replace(/\D/g, "");
}

/** Luhn checksum — the gate that turns "16 digits" into "a card number". */
function luhnValid(digits: string): boolean {
	if (digits.length === 0) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48; // '0' === 48
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

/** ISO 7064 mod-97-10 over the rearranged IBAN — 1 means valid. Iterative so no BigInt. */
function mod97(rearranged: string): number {
	let remainder = 0;
	for (let i = 0; i < rearranged.length; i++) {
		const c = rearranged.charCodeAt(i);
		if (c >= 48 && c <= 57) {
			remainder = (remainder * 10 + (c - 48)) % 97;
		} else if (c >= 65 && c <= 90) {
			remainder = (remainder * 100 + (c - 55)) % 97; // 'A' === 65 → 10
		} else {
			return -1;
		}
	}
	return remainder;
}

function ibanValid(value: string): boolean {
	const normalized = value.replace(/\s/g, "").toUpperCase();
	if (
		normalized.length < MIN_IBAN_LENGTH ||
		normalized.length > MAX_IBAN_LENGTH
	) {
		return false;
	}
	const rearranged = normalized.slice(4) + normalized.slice(0, 4);
	return mod97(rearranged) === 1;
}

function matches(
	text: string,
	pattern: RegExp,
): { value: string; start: number; end: number }[] {
	const out: { value: string; start: number; end: number }[] = [];
	for (const match of text.matchAll(pattern)) {
		const value = match[0];
		const start = match.index;
		if (start === undefined) continue;
		out.push({ value, start, end: start + value.length });
	}
	return out;
}

export const regexDetector: Detector = (text) => {
	const emails: PiiSpan[] = matches(text, EMAIL).map((m) => ({
		...m,
		kind: "email",
		confidence: EMAIL_CONFIDENCE,
		source: "regex",
	}));

	const ibans: PiiSpan[] = matches(text, IBAN_CANDIDATE)
		.filter((m) => ibanValid(m.value))
		.map((m) => ({
			...m,
			kind: "id",
			confidence: IBAN_CONFIDENCE,
			source: "regex",
		}));

	// Cards must not fire on digits that are really an email's local part or an IBAN's body.
	const cardExclude: Range[] = [...emails, ...ibans];
	const cards: PiiSpan[] = matches(text, CARD_CANDIDATE)
		.filter((m) => {
			const digits = digitsOnly(m.value);
			// A uniform run ("0000…", "1111…") passes Luhn trivially yet is never a real PAN.
			if (new Set(digits).size < 2) return false;
			return luhnValid(digits) && !overlapsAny(m, cardExclude);
		})
		.map((m) => ({
			...m,
			kind: "card",
			confidence: CARD_CONFIDENCE,
			source: "regex",
		}));

	// Phones yield to every stronger match sharing their digits (one value, one kind).
	const phoneExclude: Range[] = [...emails, ...ibans, ...cards];
	const phones: PiiSpan[] = matches(text, PHONE_CANDIDATE)
		.filter((m) => {
			const digits = digitsOnly(m.value);
			if (
				digits.length < MIN_PHONE_DIGITS ||
				digits.length > MAX_PHONE_DIGITS
			) {
				return false;
			}
			if (YEAR_RANGE.test(m.value.trim())) return false;
			return !overlapsAny(m, phoneExclude);
		})
		.map((m) => ({
			...m,
			kind: "phone",
			confidence: PHONE_CONFIDENCE,
			source: "regex",
		}));

	return [...emails, ...ibans, ...cards, ...phones];
};
