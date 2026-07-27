// The redaction CONTRACTS: the PII span/mapping schemas, the re-identification store port, and the
// Redactor port the governance pipeline talks to. The redactor IMPLEMENTATIONS (the actual
// redact/rehydrate engine) live in @busyclaw/core — privacy is enforced there, not declared here.
// See docs/architecture/03-pii-and-erasure.md.

import { type } from "arktype";
import type { EntityRecord } from "../entity";
import { entity, field } from "../entity";
import { type ScopeRef, UNCONTAINED } from "../scope";
import {
	SCOPE_CONTEXT_KEY,
	SCOPE_ID_CONTEXT_KEY,
	SUBJECT_CONTEXT_KEY,
	type TurnContext,
} from "./boundary";

export const piiKindValues = [
	"email",
	"phone",
	"name",
	"address",
	"date",
	"id",
	"card",
	"secret",
	"url",
] as const;

export const piiKind = type(
	"'email' | 'phone' | 'name' | 'address' | 'date' | 'id' | 'card' | 'secret' | 'url'",
);
export type PiiKind = (typeof piiKindValues)[number];

export const piiSpanSource = type("'regex' | 'schema' | 'plugin' | 'model'");
export type PiiSpanSource = typeof piiSpanSource.infer;

export const piiSpan = type({
	/** Byte/string offsets into the original JavaScript string. */
	start: "number",
	end: "number",
	value: "string",
	kind: piiKind,
	"confidence?": "number | undefined",
	"source?": piiSpanSource.or("undefined"),
});
export type PiiSpan = typeof piiSpan.infer;

export const piiSpans = piiSpan.array();
export type PiiSpans = typeof piiSpans.infer;

// The key is the TRIPLE (placeholder, scope, scopeId): a placeholder is unique only within its
// container (word-code tokens are far lower-entropy than the old 128-bit hex, and are collision-minted
// PER CONTAINER — so the same token in two containers is expected, not a clash). Declaring it as the
// composite primary key was blocked while `scope`/`scopeId` were optional, because a key column cannot
// be NULL. They are now required, with `UNCONTAINED` standing in for the context-less redaction that
// genuinely has no container.
//
// That is a correctness fix, not only a schema tidy. While the columns were nullable, the durable
// store built its container clauses CONDITIONALLY — an uncontained row produced a where of
// `placeholder` alone, which matches the namesake token in every other container. Erasing an
// uncontained subject therefore deleted contained mappings belonging to other claws, destroying their
// rehydration. Required columns make the predicate unconditional, so the container is always part of
// the question. This is the erasure gap the cleanroom brief flags in §7.
export const piiMappingFields = {
	placeholder: field.string({ required: true, index: true, primaryKey: true }),
	original: field.string({ required: true, pii: "contains" }),
	// Dedup index: keyed hash of (kind, original) — what makes placeholders deterministic per
	// (value, kind, container). KEYED (never a bare hash) so low-entropy PII can't be
	// dictionary-attacked offline; optional because a keyless redactor cannot compute it and
	// falls back to minting fresh placeholders. Losing the key only resets dedup — rehydration
	// never depends on it.
	originalHash: field.string({ index: true }),
	kind: field.enum(piiKindValues, { required: true, index: true }),
	// Containment: the (scope, scopeId) container this was redacted in — `claw:<clawId>` today,
	// `memory:<kbId>` / `task:<taskId>` later. A placeholder rehydrates ONLY within the same
	// container. `scopeId` is a unique entity id, so the container implies its boundary — pii
	// carries NO organizationId, ever. Normalize a context into one with `piiContainer`.
	scope: field.string({ required: true, index: true, primaryKey: true }),
	scopeId: field.string({ required: true, index: true, primaryKey: true }),
	createdAt: field.string({ required: true }),
} as const;

/**
 * One value, one placeholder, per container — enforced by the DATABASE.
 *
 * The tuple is (scope, scopeId, originalHash), NOT the placeholder: `placeholder` + `scope` +
 * `scopeId` are already the composite primary key, so a unique over those would only restate it. Two
 * concurrent writers never collide on the placeholder — they mint two DIFFERENT ones, which is
 * exactly why the primary key could not catch this. What they share is the VALUE, and `originalHash`
 * is what names it.
 *
 * The redactor coalesces concurrent mints within one process; this is the half no process can do
 * alone, because another instance's in-flight insert is invisible to it. `createStoredRedactor`
 * catches the conflict and adopts the winner's placeholder.
 *
 * `originalHash` is optional — a keyless redactor computes none — and every backend in the adapter
 * set treats NULLs as DISTINCT in a unique index (Postgres, SQLite, MySQL, Mongo), so keyless mode
 * still writes a row per occurrence, which is its documented behaviour. SQL Server, which treats
 * them as equal and would reject the second, is not among them.
 */
export const piiMappingEntity = entity("pii_mapping", piiMappingFields, {
	uniques: [["scope", "scopeId", "originalHash"]],
});
export const piiMapping = piiMappingEntity.record;
export type PiiMapping = EntityRecord<typeof piiMappingFields>;

/** The storage schema backing durable PiiMappingStore. */
export const piiMappingSchema = piiMappingEntity.storage;

// The subject junction — a single PII value can be about SEVERAL data-subjects (a shared address).
// Subject is the ERASURE axis (right-to-be-forgotten), decoupled from containment: many-to-many, and
// NOT part of the rehydration key. Carries the mapping's container `(scope, scopeId)` because the
// placeholder is only unique WITHIN a container (word-code tokens are lower-entropy than the old
// 128-bit hex), so erasure must delete the mapping in the RIGHT container — never a namesake token in
// another one.
// All four columns are the key: a subject is linked to a placeholder in a container at most once, and
// the junction is a SET, not a log — re-saving a deterministic placeholder must not accumulate rows.
// The stores already de-duplicated by reading first; the constraint makes that a property of the table
// rather than of every caller remembering to check.
export const piiSubjectFields = {
	placeholder: field.string({ required: true, index: true, primaryKey: true }),
	subjectId: field.string({ required: true, index: true, primaryKey: true }),
	scope: field.string({ required: true, index: true, primaryKey: true }),
	scopeId: field.string({ required: true, index: true, primaryKey: true }),
} as const;

export const piiSubjectEntity = entity("pii_subject", piiSubjectFields);
export const piiSubject = piiSubjectEntity.record;
export type PiiSubject = EntityRecord<typeof piiSubjectFields>;

/** The storage schema backing the durable subject junction. */
export const piiSubjectSchema = piiSubjectEntity.storage;

// The erasure TOMBSTONE — one row per (subject, container) that has been shredded.
//
// Erasure without it is a point-in-time delete, not a standing instruction: the mappings go, and the
// very next turn that mentions the same person mints them again. The person asked to be forgotten and
// was, for as long as nobody said their name.
//
// Per CONTAINER, like everything else on this axis: a subject erased from one claw has said nothing
// about another, and a tombstone that reached across containers would silently disable re-identification
// for tenants who never asked for it.
export const piiErasureFields = {
	subjectId: field.string({ required: true, index: true, primaryKey: true }),
	scope: field.string({ required: true, index: true, primaryKey: true }),
	scopeId: field.string({ required: true, index: true, primaryKey: true }),
	/** When the shred happened — the durable half of the `pii.erasure` audit line, which lives in a
	 *  different store and answers a different question ("was it requested" vs "is it still in force"). */
	erasedAt: field.string({ required: true }),
} as const;

export const piiErasureEntity = entity("pii_erasure", piiErasureFields);
export const piiErasure = piiErasureEntity.record;
export type PiiErasure = EntityRecord<typeof piiErasureFields>;

/** The storage schema backing the erasure tombstone. */
export const piiErasureSchema = piiErasureEntity.storage;

/** The re-identification store: placeholder → original PII, contained by (scope, scopeId), with a
 *  subject junction for erasure. */
export type PiiMappingStore = {
	durable?: boolean;
	/** Save a mapping plus its subject rows (the erasure junction). */
	save: (
		mapping: PiiMapping,
		subjectIds?: readonly string[],
	) => void | Promise<void>;
	/** placeholder → original, but only within the SAME container (scope, scopeId). */
	resolve: (
		placeholder: string,
		ctx?: RehydrationContext,
	) => string | null | Promise<string | null>;
	/** originalHash → its mapping, but only within the SAME container — the dedup read behind
	 *  deterministic placeholders (same value, same kind, same container → same placeholder). */
	findByHash: (
		originalHash: string,
		ctx?: RehydrationContext,
	) => PiiMapping | null | Promise<PiiMapping | null>;
	/** Right-to-be-forgotten: delete every mapping this subject appears on (multi-subject safe). */
	/**
	 * Crypto-shred every mapping this subject appears on, and report HOW MANY.
	 *
	 * The count is the point. Erasure used to answer `void`, so "shredded every mapping this person
	 * appears on" and "found nothing, because nothing was ever linked to them" were the same reply —
	 * and the second is the likely one, since a subject is only linked when trusted code stamps it.
	 * A compliance answer that cannot distinguish those is worse than no answer: it is a false one.
	 */
	deleteForSubject: (subjectId: string) => number | Promise<number>;
	/**
	 * Has this subject been erased from this container? Reads the tombstone.
	 *
	 * A RECORD, deliberately not a gate. Blocking future mints would make erasure a permanent ban, and
	 * a person who asks to be forgotten must still be able to come back — the existing behaviour is
	 * already right: the erased token stays inert forever and a reappearing value mints a FRESH one.
	 * What was missing is proof. Once the mappings are gone nothing else says the erasure happened;
	 * the audit chain records that it was REQUESTED, in a different store, and cannot say whether it
	 * completed or where.
	 */
	isErased: (
		subjectId: string,
		ctx?: RehydrationContext,
	) => boolean | Promise<boolean>;
};

export const redactionContext = type({
	"scope?": "string | undefined",
	"scopeId?": "string | undefined",
	"subjectIds?": "string[] | undefined",
});
export type RedactionContext = typeof redactionContext.infer;

export const rehydrationContext = redactionContext;
export type RehydrationContext = typeof rehydrationContext.infer;

/**
 * The container a redaction or rehydration acts in, normalized to a whole {@link ScopeRef}. Every
 * store goes through this — it is the ONE place the absent container becomes a value, so mint, lookup,
 * dedup and erasure cannot disagree about which bucket a context-less call lands in.
 *
 * BOTH halves must be present to count. A half-named container (`{ scope: "claw" }` with no `scopeId`)
 * used to form its own bucket — distinct from the fully-absent one and from every real claw — so a
 * placeholder minted under one was rehydratable only by a caller who repeated the identical mistake.
 * Collapsing a partial context to {@link UNCONTAINED} makes the absent case exactly one bucket rather
 * than an open family of near-misses.
 */
export function piiContainer(ctx?: RehydrationContext): ScopeRef {
	return ctx?.scope !== undefined && ctx.scopeId !== undefined
		? { scope: ctx.scope, scopeId: ctx.scopeId }
		: UNCONTAINED;
}

export function redactionContextFrom(
	ctx: TurnContext,
): RedactionContext | undefined {
	const scope = ctx[SCOPE_CONTEXT_KEY];
	const scopeId = ctx[SCOPE_ID_CONTEXT_KEY];
	const subjectId = ctx[SUBJECT_CONTEXT_KEY];
	const out: RedactionContext = {};
	if (typeof scope === "string") out.scope = scope;
	if (typeof scopeId === "string") out.scopeId = scopeId;
	if (typeof subjectId === "string") out.subjectIds = [subjectId];
	return out.scope === undefined &&
		out.scopeId === undefined &&
		out.subjectIds === undefined
		? undefined
		: out;
}

/** Finds PII spans in a string. Sync for pattern detectors (regex/schema); a `Promise` for
 *  network-backed ones (a Presidio analyzer, an NER model). The redactor awaits either. */
export type Detector = (text: string) => PiiSpan[] | Promise<PiiSpan[]>;

/** Redact/rehydrate any value (deep). The governance talks only to this shape. */
export type Redactor = {
	durable?: boolean;
	redactValue: <T>(value: T, ctx?: RedactionContext) => Promise<T>;
	rehydrateValue: <T>(value: T, ctx?: RehydrationContext) => Promise<T>;
};
