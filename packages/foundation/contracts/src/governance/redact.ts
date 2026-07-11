// The redaction CONTRACTS: the PII span/mapping schemas, the re-identification store port, and the
// Redactor port the governance pipeline talks to. The redactor IMPLEMENTATIONS (the actual
// redact/rehydrate engine) live in @euroclaw/core — privacy is enforced there, not declared here.
// See docs/architecture/03-pii-and-erasure.md.

import { type } from "arktype";
import type { EntityRecord } from "../entity";
import { entity, field } from "../entity";
import {
	SCOPE_CONTEXT_KEY,
	SCOPE_ID_CONTEXT_KEY,
	SUBJECT_CONTEXT_KEY,
	type TurnContext,
} from "./boundary";

const piiKindValues = [
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

export const piiMappingFields = {
	placeholder: field.string({ required: true, index: true }),
	original: field.string({ required: true, pii: "contains" }),
	kind: field.enum(piiKindValues, { required: true, index: true }),
	// Containment: the (scope, scopeId) container this was redacted in — `claw:<clawId>` today,
	// `memory:<kbId>` / `task:<taskId>` later. A placeholder rehydrates ONLY within the same
	// container. Optional (a context-less redaction has no container). `scopeId` is a unique entity
	// id, so the container implies its tenant — pii carries NO organizationId, ever.
	scope: field.string({ index: true }),
	scopeId: field.string({ index: true }),
	createdAt: field.string({ required: true }),
} as const;

export const piiMappingEntity = entity("pii_mapping", piiMappingFields);
export const piiMapping = piiMappingEntity.record;
export type PiiMapping = EntityRecord<typeof piiMappingFields>;

/** The storage schema backing durable PiiMappingStore. */
export const piiMappingSchema = piiMappingEntity.storage;

// The subject junction — a single PII value can be about SEVERAL data-subjects (a shared address).
// Subject is the ERASURE axis (right-to-be-forgotten), decoupled from containment: many-to-many, and
// NOT part of the rehydration key. Linked to a mapping by its unique `placeholder`.
export const piiSubjectFields = {
	placeholder: field.string({ required: true, index: true }),
	subjectId: field.string({ required: true, index: true }),
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

/** Finds PII spans in a string. Swap in a model/Presidio detector later. */
export type Detector = (text: string) => PiiSpan[];

/** Redact/rehydrate any value (deep). The governance talks only to this shape. */
export type Redactor = {
	durable?: boolean;
	redactValue: <T>(value: T, ctx?: RedactionContext) => Promise<T>;
	rehydrateValue: <T>(value: T, ctx?: RehydrationContext) => Promise<T>;
};
