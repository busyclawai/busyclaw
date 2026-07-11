// The redactor IMPLEMENTATION: PII in → scoped opaque placeholders out, and back again. This is where
// euroclaw's privacy promise is ENFORCED — the engine only ever hands gates and tools the redacted
// value. The contracts (PiiMappingStore / Redactor / Detector + the span/mapping schemas) live in
// @euroclaw/contracts. See docs/architecture/03-pii-and-erasure.md.

import {
	type Detector,
	type PiiMapping,
	type PiiMappingStore,
	piiMapping,
	piiSpans,
	type RedactionContext,
	type Redactor,
	type RehydrationContext,
	redactionContext,
	rehydrationContext,
} from "@euroclaw/contracts";
import { validationError } from "@euroclaw/errors";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

const PLACEHOLDER = /\{\{pii:[a-z0-9]+\}\}/g;

/**
 * The neutral default: detects nothing, so redaction is a no-op until you opt in.
 * Concrete detectors (email, Presidio, an NER model) are yours to bring — the governance ships
 * only the mechanism, never a policy about what counts as PII.
 */
export const noopDetector: Detector = () => [];

function newPlaceholder(): string {
	return `{{pii:${bytesToHex(randomBytes(16))}}}`;
}

export function createMemoryPiiMappingStore(): PiiMappingStore {
	// placeholder → mapping (the placeholder is a unique 128-bit token). Rehydration additionally
	// requires the CONTAINER (scope, scopeId) to match — a placeholder that travels into another
	// container is inert. Subjects are a separate index for erasure only.
	const byPlaceholder = new Map<string, PiiMapping>();
	const subjectToPlaceholders = new Map<string, Set<string>>();
	const sameContainer = (
		mapping: PiiMapping,
		ctx?: RehydrationContext,
	): boolean => mapping.scope === ctx?.scope && mapping.scopeId === ctx?.scopeId;
	return {
		durable: false,
		save(mapping, subjectIds) {
			const valid = piiMapping(mapping);
			if (valid instanceof type.errors) {
				throw validationError("invalid PII mapping", valid.summary);
			}
			byPlaceholder.set(valid.placeholder, valid);
			for (const subjectId of subjectIds ?? []) {
				let set = subjectToPlaceholders.get(subjectId);
				if (set === undefined) {
					set = new Set<string>();
					subjectToPlaceholders.set(subjectId, set);
				}
				set.add(valid.placeholder);
			}
		},
		resolve(placeholder, ctx) {
			const mapping = byPlaceholder.get(placeholder);
			return mapping !== undefined && sameContainer(mapping, ctx)
				? mapping.original
				: null;
		},
		deleteForSubject(subjectId) {
			const placeholders = subjectToPlaceholders.get(subjectId);
			if (placeholders === undefined) return;
			for (const placeholder of placeholders) byPlaceholder.delete(placeholder);
			// The value is gone — drop it from every other subject's index too.
			for (const set of subjectToPlaceholders.values()) {
				for (const placeholder of placeholders) set.delete(placeholder);
			}
			subjectToPlaceholders.delete(subjectId);
		},
	};
}

export type StoredRedactorOptions = {
	detector?: Detector;
	mappings: PiiMappingStore;
	now?: () => string;
};

function cleanSpans(
	spans: ReturnType<Detector>,
	textLength: number,
): ReturnType<Detector> {
	const out: ReturnType<Detector> = [];
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

	const redactText = async (
		text: string,
		ctx?: RedactionContext,
	): Promise<string> => {
		const detected = piiSpans(detect(text));
		if (detected instanceof type.errors) {
			throw validationError(
				"detector returned invalid PII spans",
				detected.summary,
			);
		}
		const spans = cleanSpans(detected, text.length);
		if (spans.length === 0) return text;
		let out = "";
		let last = 0;
		for (const span of spans) {
			const placeholder = newPlaceholder();
			await mappings.save(
				{
					placeholder,
					original: span.value,
					kind: span.kind,
					scope: ctx?.scope,
					scopeId: ctx?.scopeId,
					createdAt: now(),
				},
				ctx?.subjectIds,
			);
			out += text.slice(last, span.start) + placeholder;
			last = span.end;
		}
		return out + text.slice(last);
	};

	const rehydrateText = async (
		text: string,
		ctx?: RehydrationContext,
	): Promise<string> => {
		let out = "";
		let last = 0;
		for (const match of text.matchAll(PLACEHOLDER)) {
			const placeholder = match[0];
			const start = match.index ?? 0;
			out += text.slice(last, start);
			out += (await mappings.resolve(placeholder, ctx)) ?? placeholder;
			last = start + placeholder.length;
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
		// Numbers, booleans, null, and non-plain objects (Uint8Array, Date, URL, class
		// instances — e.g. binary parts in a model prompt) pass through untouched.
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
