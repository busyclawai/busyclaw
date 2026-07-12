import { type } from "arktype";
import { jsonObject } from "./common";
import type { EntityRecord } from "./entity";
import { entity, field } from "./entity";

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
	id: field.string({ required: true, unique: true, immutable: true }),
	status: field.enum(effectStatusValues, { required: true, index: true }),
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
