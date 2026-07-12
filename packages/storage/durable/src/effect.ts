// createEffectStore — the EffectStore port (durable idempotency + lease-based execution), backed by
// any @euroclaw/storage-core Adapter. Persistence goes through `entityDb`: JSON columns (output,
// error, compensation) are (de)serialized by the schema layer, the storage-only `leaseTokenHash`
// drops on read (returned:false — absent from the read record type AND the read validator), and
// every row crossing the adapter boundary is parsed against the effect record schema.

import type { Adapter } from "@euroclaw/contracts";
import {
	type EffectClaim,
	type EffectRecord,
	type EffectStore,
	effectStorageFields,
	type JsonValue,
	jsonValue as jsonValueSchema,
	stateError,
	validationError,
} from "@euroclaw/contracts";
import {
	type EntityPatch,
	type EntityWhere,
	entityDb,
} from "@euroclaw/storage-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

const MODEL = "effect";
const DEFAULT_EFFECT_LEASE_TTL_MS = 60_000;

const newToken = (): string => bytesToHex(randomBytes(16));
const hashToken = (value: string): string =>
	bytesToHex(sha256(utf8ToBytes(value)));
const addMs = (iso: string, ms: number): string =>
	new Date(new Date(iso).getTime() + ms).toISOString();

// JSON payloads (tool output / error) are validated as JsonValue at the boundary; the entity
// layer owns the serialization to the storage column.
function assertJsonValue(value: unknown, label: string): JsonValue {
	const valid = jsonValueSchema(value);
	if (valid instanceof type.errors) {
		throw validationError(`${label} invalid`, valid.summary);
	}
	return valid;
}

type EffectWhere = EntityWhere<typeof effectStorageFields>;
type EffectPatch = EntityPatch<typeof effectStorageFields>;

export function createEffectStore(adapter: Adapter): EffectStore {
	const db = entityDb(adapter, { effect: { fields: effectStorageFields } });
	const locks = new Map<string, Promise<void>>();

	const read = async (id: string): Promise<EffectRecord | null> =>
		db.findOne({ model: MODEL, where: [{ field: "id", value: id }] });

	const withLock = async <R>(id: string, fn: () => Promise<R>): Promise<R> => {
		const previous = locks.get(id) ?? Promise.resolve();
		let release: () => void = () => {};
		const next = previous.then(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		locks.set(id, next);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (locks.get(id) === next) locks.delete(id);
		}
	};

	const assertSameEffect = (
		input: { id: string; toolName: string; inputHash: string },
		record: EffectRecord,
	): void => {
		if (
			record.toolName !== input.toolName ||
			record.inputHash !== input.inputHash
		) {
			throw stateError("effect id reused with different input", {
				effectId: input.id,
			});
		}
	};

	const activeLeaseWhere = (input: {
		id: string;
		leaseToken: string;
		now: string;
	}): EffectWhere[] => [
		{ field: "id", value: input.id },
		{ field: "status", value: "started", connector: "AND" as const },
		{
			field: "leaseTokenHash",
			value: hashToken(input.leaseToken),
			connector: "AND" as const,
		},
		{
			field: "leaseExpiresAt",
			value: input.now,
			operator: "gt" as const,
			connector: "AND" as const,
		},
	];

	const unavailableClaim = (record: EffectRecord): EffectClaim => {
		if (record.status === "completed") return { status: "completed", record };
		if (record.status === "started") {
			return {
				status: "in_progress",
				record,
				leaseExpiresAt: record.leaseExpiresAt,
			};
		}
		return { status: "unavailable", record };
	};
	const uncertainClaim = (record: EffectRecord): EffectClaim => ({
		status: "uncertain",
		record,
		leaseExpiresAt: record.leaseExpiresAt,
	});

	return {
		async get(id) {
			return read(id);
		},

		async claim(input) {
			return withLock(input.id, async () => {
				const leaseToken = newToken();
				const leaseExpiresAt = addMs(
					input.now,
					input.leaseTtlMs ?? DEFAULT_EFFECT_LEASE_TTL_MS,
				);
				const leaseTokenHash = hashToken(leaseToken);
				const claimRecord = (record: EffectRecord): EffectClaim => ({
					status: "claimed",
					record,
					leaseToken,
					leaseExpiresAt,
				});

				const claimExisting = async (
					record: EffectRecord,
				): Promise<EffectClaim> => {
					assertSameEffect(input, record);
					if (record.status === "completed")
						return { status: "completed", record };
					if (record.status !== "started")
						return { status: "unavailable", record };
					if (record.leaseExpiresAt && record.leaseExpiresAt > input.now) {
						return {
							status: "in_progress",
							record,
							leaseExpiresAt: record.leaseExpiresAt,
						};
					}
					if (!record.leaseExpiresAt) return { status: "in_progress", record };
					if (input.reclaimExpired === false) return uncertainClaim(record);
					const row = await db.update({
						model: MODEL,
						where: [
							{ field: "id", value: input.id },
							{ field: "status", value: "started", connector: "AND" },
							{
								field: "leaseExpiresAt",
								value: input.now,
								operator: "lte",
								connector: "AND",
							},
						],
						update: { leaseTokenHash, leaseExpiresAt, updatedAt: input.now },
					});
					if (row) return claimRecord(row);
					const latest = await read(input.id);
					if (!latest) return { status: "unavailable", record };
					assertSameEffect(input, latest);
					return unavailableClaim(latest);
				};

				const existing = await read(input.id);
				if (existing) return claimExisting(existing);

				const record: EffectRecord = {
					id: input.id,
					status: "started",
					toolName: input.toolName,
					inputHash: input.inputHash,
					compensation: input.compensation,
					leaseExpiresAt,
					createdAt: input.now,
					updatedAt: input.now,
				};
				try {
					await db.create({
						model: MODEL,
						data: { ...record, leaseTokenHash },
					});
					return claimRecord(record);
				} catch (err) {
					const raced = await read(input.id);
					if (!raced) throw err;
					return claimExisting(raced);
				}
			});
		},

		async heartbeat(input) {
			const leaseExpiresAt = addMs(
				input.now,
				input.leaseTtlMs ?? DEFAULT_EFFECT_LEASE_TTL_MS,
			);
			return db.update({
				model: MODEL,
				where: activeLeaseWhere(input),
				update: { leaseExpiresAt, updatedAt: input.now },
			});
		},

		async complete(input) {
			const update: EffectPatch = {
				status: "completed",
				leaseTokenHash: null,
				leaseExpiresAt: null,
				updatedAt: input.now,
			};
			if (input.output !== undefined) {
				update.output = assertJsonValue(input.output, "effect.output");
			}
			const row = await db.update({
				model: MODEL,
				where: activeLeaseWhere(input),
				update,
			});
			if (!row) {
				throw validationError(
					"effect complete invalid",
					"effect lease is not active",
					{ effectId: input.id },
				);
			}
			return row;
		},

		async fail(input) {
			const row = await db.update({
				model: MODEL,
				where: activeLeaseWhere(input),
				update: {
					status: "failed",
					error: assertJsonValue(input.error, "effect.error"),
					leaseTokenHash: null,
					leaseExpiresAt: null,
					updatedAt: input.now,
				},
			});
			if (!row) {
				throw validationError(
					"effect fail invalid",
					"effect lease is not active",
					{ effectId: input.id },
				);
			}
			return row;
		},
	};
}
