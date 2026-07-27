// The redaction CONTRACTS: the PII span/mapping schemas, the re-identification store port, and the
// Redactor port the governance pipeline talks to. The redactor IMPLEMENTATIONS (the actual
// redact/rehydrate engine) live in @euroclaw/core — privacy is enforced there, not declared here.
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
	deleteForSubject: (subjectId: string) => void | Promise<void>;
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
