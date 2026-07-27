// The redactor IMPLEMENTATION: PII in → scoped opaque placeholders out, and back again. This is where
// euroclaw's privacy promise is ENFORCED — the engine only ever hands gates and tools the redacted
// value. The contracts (PiiMappingStore / Redactor / Detector + the span/mapping schemas) live in
// @euroclaw/contracts. See docs/architecture/03-pii-and-erasure.md.

import {
	type Detector,
	type PiiKind,
	piiKindValues,
	type PiiMapping,
	type PiiMappingStore,
	type PiiSpan,
	piiContainer,
	piiMapping,
	piiSpans,
	type RedactionContext,
	type Redactor,
	type RehydrationContext,
	redactionContext,
	rehydrationContext,
	type ScopeRef,
} from "@euroclaw/contracts";
import { isConflict, validationError } from "@euroclaw/errors";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import {
	NAME_BY_PREFIX4,
	NAME_SET,
	NAME_WORDLIST,
	WORD_BY_PREFIX4,
	WORD_SET,
	WORDLIST,
} from "./wordlist";

// Kind-typed tokens (`{{pii:email:robin-oak-river}}`) so the model can reason over what a placeholder
// IS. The identity is a hyphen-joined BIP-39 word code — far easier for a (cheap) model to copy
// faithfully than random hex, and snap-back recoverable when it doesn't (see `recover` below). The
// `[a-z0-9-]+` identity class also still matches the legacy hex form so pre-existing tokens rehydrate.
const PLACEHOLDER = /\{\{pii:(?:[a-z]+:)?[a-z0-9-]+\}\}/g;

/** A per-kind placeholder alphabet: which word list a kind's tokens are drawn from and repaired
 *  against, plus how many words a fresh code carries. The `name` kind uses a name-styled book so its
 *  tokens read like a person (better model coreference); every other kind uses the generic book. */
type Codebook = {
	list: readonly string[];
	set: ReadonlySet<string>;
	prefix: ReadonlyMap<string, string>;
	/** Word slots in a fresh code. Generic 4 = 44 bits; name 3 = 33 bits — both ample WITHIN a
	 *  container (identity is container-scoped, not global) with the mint-time collision check. */
	words: number;
};
const GENERIC_BOOK: Codebook = {
	list: WORDLIST,
	set: WORD_SET,
	prefix: WORD_BY_PREFIX4,
	words: 4,
};
const NAME_BOOK: Codebook = {
	list: NAME_WORDLIST,
	set: NAME_SET,
	prefix: NAME_BY_PREFIX4,
	words: 3,
};

function codebookFor(kind: PiiKind): Codebook {
	return kind === "name" ? NAME_BOOK : GENERIC_BOOK;
}

/**
 * The neutral default: detects nothing, so redaction is a no-op until you opt in.
 * Concrete detectors (email, Presidio, an NER model) are yours to bring — the governance ships
 * only the mechanism, never a policy about what counts as PII.
 */
export const noopDetector: Detector = () => [];

/** A random hyphen-joined code from `book` (its `words` slots, plus `extra` for collision escalation).
 *  Each index masks the low bits of two random bytes; the list length is a power of two, so the mask
 *  is bias-free (no modulo). */
function wordCode(book: Codebook, extra: number): string {
	const mask = book.list.length - 1;
	const count = book.words + extra;
	const bytes = randomBytes(count * 2);
	const words: string[] = [];
	for (let i = 0; i < count; i++) {
		const hi = bytes[i * 2] ?? 0;
		const lo = bytes[i * 2 + 1] ?? 0;
		words.push(book.list[((hi << 8) | lo) & mask] ?? book.list[0] ?? "");
	}
	return words.join("-");
}

function formatPlaceholder(kind: PiiKind, code: string): string {
	return `{{pii:${kind}:${code}}}`;
}

// ── recovery: snap a model-mangled placeholder back to a real one ─────────────────────────────────
// Words are a natural error-correcting code — prefix-unique in 4 letters and edit-separated — so a
// mangled word snaps to its dictionary word, and a mangled placeholder to its mapping. Fail-safe by
// construction: a repair is used only when it RESOLVES in-container AND is unambiguous, so recovery
// can never invent a value or cross to another subject's.

// The books' unique-decoding radius, and not one edit more. Both wordlists are built to a MINIMUM
// pairwise edit distance of 3 (measured, not assumed: 2048 words each, closest pairs `abacus`/`apache`
// and `aaberg`/`abbey`), which corrects exactly floor((3-1)/2) = 1 edit.
//
// Inside radius 1 the nearest word is PROVABLY the original: if one word is within 1 edit, every other
// is at least 3 - 1 = 2 away, so a candidate set can never hold more than one entry. Outside it there
// is no such guarantee — at 2, a mangling of three or more edits can land uniquely nearest a DIFFERENT
// word at distance 2 and be accepted with no tie for the caller to refuse, which for a placeholder
// means rehydrating as another subject's value. "Same value or refuse" is this recoverer's whole
// contract, so it now repairs only what it can prove.
//
// Precise about what this does NOT buy: a mangling that happens to land inside some other word's
// radius is indistinguishable from that word at ANY tolerance, and no radius fixes it. What narrows
// that residue is the layer above — a repair is used only if it also RESOLVES in-container, so a wrong
// word is inert unless that token is separately saved in the same container.
//
// The cost is real: this is a tolerance, not a bug fix, and dropping it to 1 stops recovering
// two-edit manglings the books could often still decode uniquely — a transposition (`abacus` →
// `baacus`) is 2 under plain Levenshtein and no longer repairs. Damerau-Levenshtein, which would score
// that 1, is not the answer either: measured against these books its minimum pairwise distance is only
// 2 (`abide`/`babied`, `adela`/`adlee`), a radius of ZERO, so the metric that makes transpositions
// cheap also makes the code non-correcting.
const WORD_MAX_EDITS = 1;
const RECOVER_MAX_CANDIDATES = 24;
// Catches dropped/extra braces, spaced or `_`/`-` separators, and stray case; the identity class
// excludes braces so a frame can never swallow a neighbouring token, and is length-bounded to boot.
const LOOSE_PLACEHOLDER =
	/\{{1,2}\s*pii\s*[\s:_-]\s*([a-z]+)\s*[\s:_-]\s*([a-z0-9][a-z0-9 _-]{0,80}?)\s*\}{1,2}/gi;

/** Levenshtein over short strings (dictionary words ≤ 8 chars, kinds ≤ 7). Two rolling rows. */
function editDistance(a: string, b: string): number {
	const n = b.length;
	let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
	let curr: number[] = new Array<number>(n + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				(prev[j] ?? 0) + 1,
				(curr[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + cost,
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n] ?? 0;
}

/** Snap one possibly-mangled word to its dictionary word(s) within tolerance, against the kind's own
 *  `book`. The first-4-letters prefix is unique by construction, so a word whose prefix survived
 *  resolves with zero ambiguity; otherwise the nearest word(s) by edit distance — a tie returns
 *  several, which the caller refuses. */
function repairWord(raw: string, book: Codebook): string[] {
	const w = raw.toLowerCase();
	if (book.set.has(w)) return [w];
	const byPrefix = book.prefix.get(w.slice(0, 4));
	if (byPrefix !== undefined && editDistance(w, byPrefix) <= WORD_MAX_EDITS) {
		return [byPrefix];
	}
	let best = WORD_MAX_EDITS + 1;
	let matches: string[] = [];
	for (const word of book.list) {
		const d = editDistance(w, word);
		if (d < best) {
			best = d;
			matches = [word];
		} else if (d === best) {
			matches.push(word);
		}
	}
	return best <= WORD_MAX_EDITS ? matches : [];
}

/** Snap a mangled kind to the nearest PiiKind. Conservative (≤ 1 edit, no ties) — a wrong kind can
 *  only fail to resolve, never mis-resolve, so tightness just means fewer recoveries, never wrong ones. */
function repairKind(raw: string): PiiKind | undefined {
	const k = raw.toLowerCase();
	let best = 2;
	let match: PiiKind | undefined;
	for (const kind of piiKindValues) {
		const d = editDistance(k, kind);
		if (d < best) {
			best = d;
			match = kind;
		} else if (d === best) {
			match = undefined; // tie → ambiguous kind, refuse
		}
	}
	return match;
}

/** The bounded cartesian product of per-slot candidate words → candidate codes. Returns null if the
 *  ambiguity explodes past the cap (treated as a refusal — too many ways to read the token). */
function candidateCodes(perSlot: readonly string[][]): string[] | null {
	let combos: string[][] = [[]];
	for (const slot of perSlot) {
		const next: string[][] = [];
		for (const combo of combos) {
			for (const word of slot) {
				next.push([...combo, word]);
				if (next.length > RECOVER_MAX_CANDIDATES) return null;
			}
		}
		combos = next;
	}
	return combos.map((words) => words.join("-"));
}

export function createMemoryPiiMappingStore(): PiiMappingStore {
	// (scope, scopeId, placeholder) → mapping. The placeholder is unique only WITHIN its container
	// (word-code tokens are lower-entropy than the old 128-bit hex), so the container is part of the
	// key — a namesake token in another container is a DIFFERENT mapping, never a collision that
	// clobbers. Subjects are a separate index for erasure only.
	const byKey = new Map<string, PiiMapping>();
	const subjectToKeys = new Map<string, Set<string>>();
	// A whole container, never two independently-optional halves: `piiContainer` has already collapsed
	// the absent and half-absent cases to UNCONTAINED, so there is no `?? null` to get wrong here and
	// no way for a write and a read to disagree about which bucket "no context" means.
	const containerKey = (container: ScopeRef, placeholder: string): string =>
		JSON.stringify([container.scope, container.scopeId, placeholder]);
	const sameContainer = (
		mapping: PiiMapping,
		ctx?: RehydrationContext,
	): boolean => {
		const container = piiContainer(ctx);
		return (
			mapping.scope === container.scope && mapping.scopeId === container.scopeId
		);
	};
	return {
		durable: false,
		save(mapping, subjectIds) {
			const valid = piiMapping(mapping);
			if (valid instanceof type.errors) {
				throw validationError("invalid PII mapping", valid.summary);
			}
			const key = containerKey(valid, valid.placeholder);
			byKey.set(key, valid);
			for (const subjectId of subjectIds ?? []) {
				let set = subjectToKeys.get(subjectId);
				if (set === undefined) {
					set = new Set<string>();
					subjectToKeys.set(subjectId, set);
				}
				set.add(key);
			}
		},
		resolve(placeholder, ctx) {
			// The container is baked into the key, so a foreign placeholder simply misses.
			const mapping = byKey.get(containerKey(piiContainer(ctx), placeholder));
			return mapping?.original ?? null;
		},
		findByHash(originalHash, ctx) {
			for (const mapping of byKey.values()) {
				if (
					mapping.originalHash === originalHash &&
					sameContainer(mapping, ctx)
				) {
					return mapping;
				}
			}
			return null;
		},
		deleteForSubject(subjectId) {
			const keys = subjectToKeys.get(subjectId);
			if (keys === undefined) return;
			for (const key of keys) byKey.delete(key);
			// The value is gone — drop it from every other subject's index too.
			for (const set of subjectToKeys.values()) {
				for (const key of keys) set.delete(key);
			}
			subjectToKeys.delete(subjectId);
		},
	};
}

export type StoredRedactorOptions = {
	detector?: Detector;
	mappings: PiiMappingStore;
	now?: () => string;
	/**
	 * Dedup key: with it, the same (value, kind, container) always yields the SAME placeholder —
	 * coreference across mentions/steps/artifacts, stable prompt caching, one mapping row per value.
	 * The key only feeds the lookup hash; rehydration never depends on it, so loss or rotation
	 * merely resets dedup. Omit → every occurrence mints fresh (a durable store warns once).
	 */
	indexKey?: string;
	/** Where the keyless-durable warning goes (core has no console). Omit → silent. Also carries
	 *  recovery telemetry: each fuzzy recovery and each refused-as-ambiguous placeholder warns here. */
	warn?: (message: string) => void;
	/**
	 * On rehydrate, snap a MANGLED placeholder back to its mapping when a (cheap) model corrupted the
	 * token — a typo'd word, dropped braces, spaced separators. Fail-safe: a repaired code is used only
	 * when it RESOLVES in the same container, and only when the repair is unambiguous (all resolving
	 * candidates yield the SAME value — never a guess that could cross to another subject). Runs only on
	 * an exact-miss, so exact rehydration is byte-identical whether on or off. Default ON — a mangled
	 * token that stays mangled is broken output, not safety, and recovery adds no leak class exact
	 * matching doesn't already have. Set `false` for strict deployments where only exact tokens may ever
	 * rehydrate.
	 */
	recover?: boolean;
};

function cleanSpans(spans: PiiSpan[], textLength: number): PiiSpan[] {
	const out: PiiSpan[] = [];
	let lastEnd = 0;
	for (const span of [...spans].sort(
		(a, b) => a.start - b.start || b.end - a.end,
	)) {
		if (span.start < lastEnd) continue;
		if (span.start < 0 || span.end > textLength || span.start >= span.end)
			continue;
		out.push(span);
		lastEnd = span.end;
	}
	return out;
}

// Existing placeholders are opaque to detection: a detector whose pattern can match inside a
// token's body (a digit/hex-run phone-card-id detector can) would corrupt it on a second pass.
// Dropping every detected span that touches one makes redact(redact(x)) === redact(x) a property
// of the redactor, not a promise about detector alphabets.
function withoutPlaceholderOverlaps(
	spans: PiiSpan[],
	text: string,
): PiiSpan[] {
	const taken: { start: number; end: number }[] = [];
	for (const match of text.matchAll(PLACEHOLDER)) {
		const start = match.index ?? 0;
		taken.push({ start, end: start + match[0].length });
	}
	if (taken.length === 0) return spans;
	return spans.filter(
		(span) =>
			!taken.some((range) => span.start < range.end && span.end > range.start),
	);
}

function validateRedactionContext(
	ctx: RedactionContext | undefined,
): RedactionContext | undefined {
	if (ctx === undefined) return undefined;
	const valid = redactionContext(ctx);
	if (valid instanceof type.errors) {
		throw validationError("invalid redaction context", valid.summary);
	}
	return valid;
}

function validateRehydrationContext(
	ctx: RehydrationContext | undefined,
): RehydrationContext | undefined {
	if (ctx === undefined) return undefined;
	const valid = rehydrationContext(ctx);
	if (valid instanceof type.errors) {
		throw validationError("invalid rehydration context", valid.summary);
	}
	return valid;
}

/** Build a Redactor backed by a PiiMappingStore. */
export function createStoredRedactor(options: StoredRedactorOptions): Redactor {
	const detect = options.detector ?? noopDetector;
	const now = options.now ?? (() => new Date().toISOString());
	const mappings = options.mappings;
	const indexKey = options.indexKey;
	if (indexKey === undefined && mappings.durable === true) {
		options.warn?.(
			"no indexKey configured — placeholders will not deduplicate, so the durable mapping store grows per occurrence and transcripts lose coreference. Provide indexKey to make placeholders deterministic.",
		);
	}
	const hashOf =
		indexKey === undefined
			? undefined
			: (kind: PiiKind, value: string): string =>
					bytesToHex(
						hmac(
							sha256,
							utf8ToBytes(indexKey),
							utf8ToBytes(`${kind}\0${value}`),
						),
					);

	// Mint a fresh placeholder whose word-code is unique WITHIN the container. At 44 bits over a
	// container's hundreds–thousands of tokens a collision is astronomically unlikely, so the loop
	// almost never turns; adding a word after several attempts is a hard backstop, not an expected path.
	const mintPlaceholder = async (
		kind: PiiKind,
		ctx?: RedactionContext,
	): Promise<string> => {
		const book = codebookFor(kind);
		for (let attempt = 0; attempt < 24; attempt++) {
			const placeholder = formatPlaceholder(kind, wordCode(book, attempt >> 3));
			if ((await mappings.resolve(placeholder, ctx)) === null) return placeholder;
		}
		// Unreachable in practice; escalate hard rather than risk a within-container collision.
		return formatPlaceholder(kind, wordCode(book, 4));
	};

	// ── the concurrency latch ─────────────────────────────────────────────────────────────────────
	//
	// Lookup-or-mint below is a read-modify-write, and `walk` runs ARRAY elements through
	// `Promise.all`. So two elements carrying the same value both miss `findByHash`, both mint, and one
	// person wears a different token per element — the dedup docstring's three promises (coreference,
	// stable prompt caching, one row per value) all quietly fail. A message list, a tool-result list, a
	// list of documents: arrays are the normal payload shape, not an edge case. Sequential paths — the
	// span loop inside one text, and object keys — were never affected, which is why this survived.
	//
	// Coalescing by (container, hash) makes the first caller do the work and the rest await its answer,
	// so concurrent mints inside one process settle on ONE placeholder.
	//
	// Why a latch and not a DERIVED code (the obvious fix — HMAC the container and hash, and two
	// racers compute the same token without seeing each other): deriving from the value would
	// resurrect erased tokens. `deleteForSubject` erases by REMOVING the row, and a value that
	// reappears afterwards must mint fresh so the already-emitted dead token stays permanently inert.
	// A pure derivation reproduces it exactly. Randomness is load-bearing for erasure here, so the
	// race gets closed instead of designed away.
	//
	// Cleared on settle: a concurrency latch, never a cache. Dedup and erasure keep coming from the
	// store, which is the only thing that survives a restart.
	//
	// SCOPE OF THE GUARANTEE — this half is per process, and it is the fast half, not the whole of it.
	// Two INSTANCES redacting one value in one container at the same instant cannot see each other's
	// in-flight write, so only the database can arbitrate between them: `pii_mapping` is unique on
	// (scope, scopeId, originalHash), and `lookupOrMint` below adopts the winner when its insert loses.
	// The latch's job is to make that the rare path — within one process the race is settled here, for
	// the cost of a map lookup instead of a rejected insert and a re-read.
	const inFlight = new Map<string, Promise<PiiMapping>>();

	// The mapping for a value: an existing row, or a freshly minted and saved one.
	//
	// The mint can LOSE. `pii_mapping` is unique on (scope, scopeId, originalHash), so another process
	// that minted for this same value a moment earlier already holds the row, and this insert is
	// rejected. Losing is not a failure — the row we wanted exists — so the answer is to re-read and
	// adopt the winner's placeholder.
	//
	// The recovery has to return the winner rather than swallow the error, and that is the whole
	// reason it lives here instead of inside the store's `save`: a store that quietly adopted the
	// winner would still leave THIS caller holding the placeholder it minted, and that placeholder was
	// never written. The redacted text would carry a token with no mapping behind it, and rehydration
	// would hand it back verbatim — a leaked placeholder in an otherwise finished draft, which is
	// worse than the split it was fixing.
	const lookupOrMint = async (
		span: PiiSpan,
		originalHash: string | undefined,
		ctx?: RedactionContext,
	): Promise<PiiMapping> => {
		const existing =
			originalHash === undefined
				? null
				: await mappings.findByHash(originalHash, ctx);
		if (existing !== null) {
			// Same value, possibly a new data-subject — append junction rows only.
			if (ctx?.subjectIds !== undefined && ctx.subjectIds.length > 0) {
				await mappings.save(existing, ctx.subjectIds);
			}
			return existing;
		}
		const minted: PiiMapping = {
			placeholder: await mintPlaceholder(span.kind, ctx),
			original: span.value,
			originalHash,
			kind: span.kind,
			...piiContainer(ctx),
			createdAt: now(),
		};
		try {
			await mappings.save(minted, ctx?.subjectIds);
			return minted;
		} catch (error) {
			if (!isConflict(error) || originalHash === undefined) throw error;
			const winner = await mappings.findByHash(originalHash, ctx);
			// A conflict whose winner cannot be read back is not a race we understand — some OTHER
			// uniqueness on the table was violated. Rethrow rather than invent a placeholder.
			if (winner === null) throw error;
			// The losing save threw before it reached the junction, so this caller's subjects are not
			// linked yet. Same rule as the latch: a dropped link is a subject whose erasure would never
			// reach this mapping.
			if (ctx?.subjectIds !== undefined && ctx.subjectIds.length > 0) {
				await mappings.save(winner, ctx.subjectIds);
			}
			options.warn?.(
				"adopted another writer's placeholder after a mapping conflict — concurrent redaction of one value",
			);
			return winner;
		}
	};

	const placeholderFor = async (
		span: PiiSpan,
		ctx?: RedactionContext,
	): Promise<string> => {
		const originalHash = hashOf?.(span.kind, span.value);
		// No dedup key → every occurrence mints fresh by design, so there is nothing to coalesce.
		if (originalHash === undefined) {
			return (await lookupOrMint(span, undefined, ctx)).placeholder;
		}
		const container = piiContainer(ctx);
		const key = JSON.stringify([
			container.scope,
			container.scopeId,
			originalHash,
		]);
		const running = inFlight.get(key);
		if (running !== undefined) {
			const shared = await running;
			// Every caller appends its OWN junction rows, not just the one that won the latch: two
			// concurrent redactions can carry different subjectIds, and a dropped link is a subject
			// whose erasure would never reach this mapping. Both stores make the append idempotent.
			if (ctx?.subjectIds !== undefined && ctx.subjectIds.length > 0) {
				await mappings.save(shared, ctx.subjectIds);
			}
			return shared.placeholder;
		}
		const pending = lookupOrMint(span, originalHash, ctx);
		inFlight.set(key, pending);
		try {
			return (await pending).placeholder;
		} finally {
			inFlight.delete(key);
		}
	};

	const redactText = async (
		text: string,
		ctx?: RedactionContext,
	): Promise<string> => {
		const detected = piiSpans(await detect(text));
		if (detected instanceof type.errors) {
			throw validationError(
				"detector returned invalid PII spans",
				detected.summary,
			);
		}
		const spans = cleanSpans(
			withoutPlaceholderOverlaps(detected, text),
			text.length,
		);
		if (spans.length === 0) return text;
		let out = "";
		let last = 0;
		for (const span of spans) {
			// Lookup-or-mint: an already-known (value, kind, container) reuses its placeholder, so
			// every mention wears the same token. The awaited save above the next lookup makes the
			// dedup hold for two occurrences inside ONE text; the latch inside `placeholderFor` is
			// what makes it hold when the caller walks several texts CONCURRENTLY (arrays do).
			const placeholder = await placeholderFor(span, ctx);
			out += text.slice(last, span.start) + placeholder;
			last = span.end;
		}
		return out + text.slice(last);
	};

	const recover = options.recover !== false;

	// Snap a mangled frame back to its mapping. Fast path first: the kind + words exactly as written
	// (pure structural damage — braces/spacing/case — with no word corruption) may already resolve.
	// Otherwise repair each word to its dictionary word(s), enumerate the (bounded) candidate codes,
	// resolve each in-container, and accept ONLY if every hit is the SAME value. Two distinct values →
	// the repair could cross a subject boundary → refuse. Returns null when nothing safely recovers.
	const recoverFrame = async (
		kindRaw: string,
		identityRaw: string,
		ctx?: RehydrationContext,
	): Promise<string | null> => {
		const words = identityRaw
			.toLowerCase()
			.split(/[\s_-]+/)
			.filter((word) => word.length > 0);
		if (words.length === 0) return null;
		const kindLower = kindRaw.toLowerCase();
		if ((piiKindValues as readonly string[]).includes(kindLower)) {
			const asIs = await mappings.resolve(
				formatPlaceholder(kindLower as PiiKind, words.join("-")),
				ctx,
			);
			if (asIs !== null) return asIs;
		}
		const kind = repairKind(kindRaw);
		if (kind === undefined) return null;
		const book = codebookFor(kind);
		const perSlot = words.map((word) => repairWord(word, book));
		if (perSlot.some((candidates) => candidates.length === 0)) return null;
		const codes = candidateCodes(perSlot);
		if (codes === null) return null; // ambiguity exploded → refuse
		const values = new Set<string>();
		let recovered: string | null = null;
		for (const code of codes) {
			const original = await mappings.resolve(
				formatPlaceholder(kind, code),
				ctx,
			);
			if (original !== null) {
				values.add(original);
				recovered = original;
			}
		}
		if (values.size === 1) {
			options.warn?.("recovered a mangled PII placeholder on rehydrate");
			return recovered;
		}
		if (values.size > 1) {
			options.warn?.(
				"refused an ambiguous PII placeholder recovery — repairs resolved to multiple values",
			);
		}
		return null;
	};

	const rehydrateText = async (
		text: string,
		ctx?: RehydrationContext,
	): Promise<string> => {
		let out = "";
		let last = 0;
		if (!recover) {
			// Exact only — byte-identical to the pre-recovery behaviour.
			for (const match of text.matchAll(PLACEHOLDER)) {
				const placeholder = match[0];
				const start = match.index ?? 0;
				out += text.slice(last, start);
				out += (await mappings.resolve(placeholder, ctx)) ?? placeholder;
				last = start + placeholder.length;
			}
			return out + text.slice(last);
		}
		// A loose scan catches healthy AND structurally-damaged frames. A healthy token resolves on
		// the exact check with no repair cost; anything that neither resolves nor safely repairs is
		// left byte-for-byte as-is (recovery never degrades the exact-match outcome).
		for (const match of text.matchAll(LOOSE_PLACEHOLDER)) {
			const whole = match[0];
			const kindRaw = match[1] ?? "";
			const identityRaw = match[2] ?? "";
			const start = match.index ?? 0;
			out += text.slice(last, start);
			const exact = await mappings.resolve(whole, ctx);
			out += exact ?? (await recoverFrame(kindRaw, identityRaw, ctx)) ?? whole;
			last = start + whole.length;
		}
		return out + text.slice(last);
	};

	const isRedactableObject = (v: unknown): v is Record<string, unknown> => {
		if (v === null || typeof v !== "object") return false;
		const proto = Object.getPrototypeOf(v);
		return proto === Object.prototype || proto === null;
	};

	const walk = async (
		value: unknown,
		fn: (s: string) => Promise<string>,
	): Promise<unknown> => {
		if (typeof value === "string") return fn(value);
		if (Array.isArray(value)) return Promise.all(value.map((v) => walk(v, fn)));
		if (isRedactableObject(value)) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[k] = await walk(v, fn);
			return out;
		}
		// Map and Set are CONTAINERS, so they are walked like the other two. They reach here as
		// ordinary carriers of caller data, and passing them through untouched meant any string inside
		// one crossed the model boundary in the clear while the plain object beside it was tokenized —
		// a hole whose shape is "which container type did the caller happen to use". Keys are walked
		// too: a Map keyed by email address is a natural thing to write and leaks exactly as readily.
		if (value instanceof Map) {
			const out = new Map<unknown, unknown>();
			for (const [k, v] of value) out.set(await walk(k, fn), await walk(v, fn));
			return out;
		}
		if (value instanceof Set) {
			const out = new Set<unknown>();
			for (const member of value) out.add(await walk(member, fn));
			return out;
		}
		// Numbers, booleans, null, and non-CONTAINER objects (Uint8Array, Date, URL, class instances —
		// e.g. binary parts in a model prompt) pass through untouched. That is deliberate: they are
		// values, not carriers, and rebuilding one would change its type out from under the caller. It
		// is also a KNOWN EDGE — a class instance holding a PII string is not reached, so anything
		// crossing this boundary should be JSON-shaped rather than a bespoke carrier.
		return value;
	};

	return {
		durable: mappings.durable === true,
		async redactValue<T>(value: T, ctx?: RedactionContext): Promise<T> {
			const validCtx = validateRedactionContext(ctx);
			return (await walk(value, (text) => redactText(text, validCtx))) as T;
		},
		async rehydrateValue<T>(value: T, ctx?: RehydrationContext): Promise<T> {
			const validCtx = validateRehydrationContext(ctx);
			return (await walk(value, (text) => rehydrateText(text, validCtx))) as T;
		},
	};
}

export function createMemoryRedactor(
	detect: Detector = noopDetector,
): Redactor {
	return createStoredRedactor({
		detector: detect,
		mappings: createMemoryPiiMappingStore(),
	});
}

/** A container's resolved redaction posture — the claw row's birth fact. */
export type ContainerPosture = "strict" | "raw";

export type RoutingRedactorOptions = {
	/** The armed redactor strict containers use. */
	strict: Redactor;
	/** Posture per redaction context. Called on every redact; cache inside if reads are costly. */
	postureOf: (
		ctx?: RedactionContext,
	) => ContainerPosture | Promise<ContainerPosture>;
};

/**
 * Posture router over the one Redactor port: "strict" delegates, "raw" passes through — one claw,
 * per-container posture. Rehydration ALWAYS delegates: raw containers hold no placeholders, and a
 * foreign placeholder is inert by containment, so delegation is harmless and fail-closed.
 */
export function createRoutingRedactor(
	options: RoutingRedactorOptions,
): Redactor {
	return {
		durable: options.strict.durable,
		async redactValue<T>(value: T, ctx?: RedactionContext): Promise<T> {
			return (await options.postureOf(ctx)) === "strict"
				? options.strict.redactValue(value, ctx)
				: value;
		},
		async rehydrateValue<T>(value: T, ctx?: RehydrationContext): Promise<T> {
			return options.strict.rehydrateValue(value, ctx);
		},
	};
}

/**
 * The declared-raw redactor: identity both ways, and vacuously durable — it never mints a
 * placeholder, so "every minted placeholder survives a restart" holds. Exists so a deployment
 * that CHOSE unredacted durability (`redaction: { posture: "raw" }`) satisfies the database
 * boot guard by declaration instead of by accident.
 */
export function createInertRedactor(): Redactor {
	return {
		durable: true,
		redactValue: async (value) => value,
		rehydrateValue: async (value) => value,
	};
}

/** Union of detectors: run all (concurrently), concatenate spans. Sync and async detectors mix
 *  freely — the result is a `Promise` whenever any member is async. Overlaps are resolved by the
 *  redactor's span cleaning — earliest start wins, ties go to the longer span. */
export function composeDetectors(...detectors: readonly Detector[]): Detector {
	return async (text) => {
		const results = await Promise.all(detectors.map((detect) => detect(text)));
		return results.flat();
	};
}
