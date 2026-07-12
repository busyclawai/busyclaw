import type { Adapter } from "@euroclaw/contracts";
import {
	type PiiMapping,
	type PiiMappingStore,
	piiMappingFields,
	piiSubjectFields,
} from "@euroclaw/contracts";
import { type EntityWhere, entityDb } from "@euroclaw/storage-core";

export type PiiMappingStoreOptions = {
	/** The table PII mappings live in. Default "pii_mapping". */
	model?: string;
	/** The subject junction table. Default "pii_subject". */
	subjectModel?: string;
};

type MappingWhere = EntityWhere<typeof piiMappingFields>;

/** The exact-row predicate for an upsert: the placeholder plus its container. */
function mappingWhere(mapping: PiiMapping): MappingWhere[] {
	const where: MappingWhere[] = [
		{ field: "placeholder", value: mapping.placeholder },
	];
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
	// Both tables ride one entity-validating adapter (options overrides ride modelName — the
	// engine-sql precedent). The store owns the mapping + its subject junction (the erasure axis);
	// every row crossing the adapter boundary is parsed against its record schema.
	const db = entityDb(adapter, {
		pii_mapping: {
			fields: piiMappingFields,
			...(options.model !== undefined ? { modelName: options.model } : {}),
		},
		pii_subject: {
			fields: piiSubjectFields,
			...(options.subjectModel !== undefined
				? { modelName: options.subjectModel }
				: {}),
		},
	});
	return {
		durable: true,

		async save(mapping, subjectIds) {
			const rows = await db.findMany({
				model: "pii_mapping",
				where: [{ field: "placeholder", value: mapping.placeholder }],
			});
			const existing = rows.find((row) => sameContainer(row, mapping));
			if (existing) {
				await db.update({
					model: "pii_mapping",
					where: mappingWhere(mapping),
					update: mapping,
				});
			} else {
				await db.create({ model: "pii_mapping", data: mapping });
			}
			for (const subjectId of subjectIds ?? []) {
				// The junction is a set, not a log — re-linking an existing (placeholder, subject)
				// pair (deterministic placeholders re-save on reuse) must not duplicate rows.
				const linked = await db.findMany({
					model: "pii_subject",
					where: [
						{ field: "placeholder", value: mapping.placeholder },
						{ field: "subjectId", value: subjectId, connector: "AND" },
					],
				});
				if (linked.length > 0) continue;
				await db.create({
					model: "pii_subject",
					data: { placeholder: mapping.placeholder, subjectId },
				});
			}
		},

		async resolve(placeholder, ctx) {
			const rows = await db.findMany({
				model: "pii_mapping",
				where: [{ field: "placeholder", value: placeholder }],
			});
			const row = rows.find((mapping) => sameContainer(mapping, ctx));
			return row?.original ?? null;
		},

		async findByHash(originalHash, ctx) {
			const rows = await db.findMany({
				model: "pii_mapping",
				where: [{ field: "originalHash", value: originalHash }],
			});
			return rows.find((mapping) => sameContainer(mapping, ctx)) ?? null;
		},

		async deleteForSubject(subjectId: string) {
			// Find every mapping this subject appears on (multi-subject safe), then erase the value —
			// the placeholder becomes permanently un-rehydratable — and all of that value's subject rows.
			const subjectRows = await db.findMany({
				model: "pii_subject",
				where: [{ field: "subjectId", value: subjectId }],
			});
			const placeholders = new Set(subjectRows.map((row) => row.placeholder));
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
