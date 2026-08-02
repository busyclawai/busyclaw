import { type } from "arktype";
import { jsonObject } from "./common";
import type { EntityRecord } from "./entity";
import { entity, field } from "./entity";
import type { Principal } from "./governance/principal";

const effectStatusValues = [
	"started",
	"completed",
	"failed",
	"compensating",
	"compensated",
	"compensation_failed",
] as const;

export const effectStatus = type(
	"'started' | 'completed' | 'failed' | 'compensating' | 'compensated' | 'compensation_failed'",
);
export type EffectStatus = (typeof effectStatusValues)[number];

export const effectCompensation = type({
	toolName: "string",
	"args?": jsonObject.or("undefined"),
});
export type EffectCompensation = typeof effectCompensation.infer;

export const effectFields = {
	// The effect's identity — what tool ran with what input — is fixed at create; only its execution
	// state (status, lease, output/error, compensation) changes.
	id: field.string({
		required: true,
		primaryKey: true,
		unique: true,
		immutable: true,
	}),
	status: field.enum(effectStatusValues, { required: true, index: true }),
	// ── the access anchors, identical to ApprovalRecord's and decided by the same ladder ──────────
	// An effect records what a tool DID. Unanchored, `getEffect` had nothing to resolve and was
	// `callerOnly`: one authenticated stranger away from another tenant's side effects, with an id
	// that is guessable by construction (`run:<runId>:tool:<toolCallId>`). R-H01.
	//
	// Nothing here is new — an approval and an effect are both "something a run left behind", so they
	// carry the same three anchors rather than inventing a second vocabulary for the same question.
	/** The principal the run executed as. The fallback anchor, and the only one an ad-hoc run has. */
	principal: field.principal({ index: true, immutable: true }),
	/** The claw whose run produced this — the anchor that matters, because whoever may manage the claw
	 *  may see what it did. Absent for an ad-hoc `generate` that belongs to no claw. */
	clawId: field.string({ index: true, immutable: true }),
	/** The TENANT it ran in. Required, and `UNSCOPED` where a deployment resolves none — a nullable
	 *  boundary is one a reader cannot tell from "we never asked". */
	scope: field.string({ required: true, index: true, immutable: true }),
	scopeId: field.string({ required: true, index: true, immutable: true }),
	toolName: field.string({ required: true, index: true, immutable: true }),
	inputHash: field.string({ required: true, index: true, immutable: true }),
	output: field.jsonValue({ pii: "redacted" }),
	error: field.jsonValue({ pii: "redacted" }),
	// Schema-first: the column IS `effectCompensation`, so the record type and the boundary
	// validator come from one source and cannot drift (the old `jsonObject<T>({ ark })` pair could).
	compensation: field.json(effectCompensation),
	compensationEffectId: field.string(),
	leaseExpiresAt: field.string({ index: true }),
	createdAt: field.string({ required: true, immutable: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const effectStorageFields = {
	...effectFields,
	leaseTokenHash: field.string({ returned: false }),
} as const;

export const effectEntity = entity("effect", effectFields);
export const effectStorageEntity = entity("effect", effectStorageFields);
export const effectRecord = effectEntity.record;
export type EffectRecord = EntityRecord<typeof effectFields>;

/** The storage schema backing durable EffectStore. */
export const effectSchema = effectStorageEntity.storage;

/** Whose work an effect was — see the anchor block on {@link effectFields}. */
export type EffectAnchors = {
	scope: string;
	scopeId: string;
	clawId?: string;
	principal?: Principal;
};

export type EffectClaim =
	| {
			status: "claimed";
			record: EffectRecord;
			leaseToken: string;
			leaseExpiresAt: string;
	  }
	| { status: "completed"; record: EffectRecord }
	| { status: "in_progress"; record: EffectRecord; leaseExpiresAt?: string }
	| { status: "uncertain"; record: EffectRecord; leaseExpiresAt?: string }
	| { status: "unavailable"; record: EffectRecord };

export type EffectStore = {
	get: (id: string) => Promise<EffectRecord | null>;
	claim: (input: {
		id: string;
		toolName: string;
		inputHash: string;
		/** The access anchors, stamped from the run's own state at mint — never from anything a tool or
		 *  a model reached. `scope`/`scopeId` are the run's resolved boundary (`UNSCOPED` when it names
		 *  no tenant); `clawId`/`principal` are absent only where the run genuinely has neither. */
		anchors: EffectAnchors;
		compensation?: EffectCompensation;
		now: string;
		leaseTtlMs?: number;
		reclaimExpired?: boolean;
	}) => Promise<EffectClaim>;
	heartbeat: (input: {
		id: string;
		leaseToken: string;
		now: string;
		leaseTtlMs?: number;
	}) => Promise<EffectRecord | null>;
	complete: (input: {
		id: string;
		leaseToken: string;
		output?: unknown;
		now: string;
	}) => Promise<EffectRecord>;
	fail: (input: {
		id: string;
		leaseToken: string;
		error: unknown;
		now: string;
	}) => Promise<EffectRecord>;
};
