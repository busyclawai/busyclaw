import type { Adapter, Where } from "@euroclaw/contracts";
import {
	configurationError,
	type PiiMapping,
	type PiiMappingStore,
	type PiiSubject,
	piiMapping as piiMappingRecord,
	piiMappingSchema,
	piiSubject as piiSubjectRecord,
	piiSubjectSchema,
	validationError,
} from "@euroclaw/contracts";
import { schemaAdapter } from "@euroclaw/storage-core";
import { type } from "arktype";

export type PiiMappingStoreOptions = {
	/** The table PII mappings live in. Default "pii_mapping". */
	model?: string;
	/** The subject junction table. Default "pii_subject". */
	subjectModel?: string;
};

function validateMapping(value: unknown): PiiMapping {
	const valid = piiMappingRecord(value);
	if (valid instanceof type.errors) {
		throw validationError("PII mapping invalid", valid.summary);
	}
	return valid;
}

function validateSubject(value: unknown): PiiSubject {
	const valid = piiSubjectRecord(value);
	if (valid instanceof type.errors) {
		throw validationError("PII subject invalid", valid.summary);
	}
	return valid;
}

/** The exact-row predicate for an upsert: the placeholder plus its container. */
function mappingWhere(mapping: PiiMapping): Where[] {
	const where: Where[] = [{ field: "placeholder", value: mapping.placeholder }];
	if (mapping.scope !== undefined) {
		where.push({ field: "scope", value: mapping.scope, connector: "AND" });
	}
	if (mapping.scopeId !== undefined) {
		where.push({ field: "scopeId", value: mapping.scopeId, connector: "AND" });
	}
	return where;
}

/** Containment: a placeholder rehydrates only within the same (scope, scopeId) container. The decode
 *  normalizes SQL NULL columns to absent, which is what the === comparison expects. */
function sameContainer(
	mapping: PiiMapping,
	ctx: Parameters<PiiMappingStore["resolve"]>[1],
): boolean {
	return mapping.scope === ctx?.scope && mapping.scopeId === ctx?.scopeId;
}

export function createPiiMappingStore(
	adapter: Adapter,
	options: PiiMappingStoreOptions = {},
): PiiMappingStore {
	const mappingTable = piiMappingSchema.pii_mapping;
	const subjectTable = piiSubjectSchema.pii_subject;
	if (!mappingTable || !subjectTable) {
		throw configurationError("pii schema missing", {});
	}
	const model = options.model ?? "pii_mapping";
	const subjectModel = options.subjectModel ?? "pii_subject";
	// Both tables ride one schema-aware adapter (options overrides ride modelName — the engine-sql
	// precedent). The store owns the mapping + its subject junction (the erasure axis).
	const db = schemaAdapter(adapter, {
		pii_mapping: { ...mappingTable, modelName: model },
		pii_subject: { ...subjectTable, modelName: subjectModel },
	});
	return {
		durable: true,

		async save(mapping, subjectIds) {
			const valid = validateMapping(mapping);
			const existing = (
				await db.findMany<PiiMapping>({
					model: "pii_mapping",
					where: [{ field: "placeholder", value: valid.placeholder }],
				})
			)
				.map(validateMapping)
				.find((row) => sameContainer(row, valid));
			if (existing) {
				await db.update({
					model: "pii_mapping",
					where: mappingWhere(valid),
					update: valid,
				});
			} else {
				await db.create({ model: "pii_mapping", data: valid });
			}
			for (const subjectId of subjectIds ?? []) {
				await db.create({
					model: "pii_subject",
					data: { placeholder: valid.placeholder, subjectId },
				});
			}
		},

		async resolve(placeholder, ctx) {
			const row = (
				await db.findMany<PiiMapping>({
					model: "pii_mapping",
					where: [{ field: "placeholder", value: placeholder }],
				})
			)
				.map(validateMapping)
				.find((mapping) => sameContainer(mapping, ctx));
			return row?.original ?? null;
		},

		async deleteForSubject(subjectId: string) {
			// Find every mapping this subject appears on (multi-subject safe), then erase the value —
			// the placeholder becomes permanently un-rehydratable — and all of that value's subject rows.
			const placeholders = new Set(
				(
					await db.findMany<PiiSubject>({
						model: "pii_subject",
						where: [{ field: "subjectId", value: subjectId }],
					})
				)
					.map(validateSubject)
					.map((row) => row.placeholder),
			);
			for (const placeholder of placeholders) {
				await db.deleteMany({
					model: "pii_mapping",
					where: [{ field: "placeholder", value: placeholder }],
				});
				await db.deleteMany({
					model: "pii_subject",
					where: [{ field: "placeholder", value: placeholder }],
				});
			}
		},
	};
}
