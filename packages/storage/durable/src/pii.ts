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
type SubjectWhere = EntityWhere<typeof piiSubjectFields>;

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

/** A junction predicate scoped to one container — the placeholder is unique only within it, so
 *  erasure must never reach a namesake mapping in another container. */
function subjectContainerWhere(row: {
	placeholder: string;
	scope?: string;
	scopeId?: string;
}): SubjectWhere[] {
	const where: SubjectWhere[] = [
		{ field: "placeholder", value: row.placeholder },
	];
	if (row.scope !== undefined) {
		where.push({ field: "scope", value: row.scope, connector: "AND" });
	}
	if (row.scopeId !== undefined) {
		where.push({ field: "scopeId", value: row.scopeId, connector: "AND" });
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
				// pair (deterministic placeholders re-save on reuse) must not duplicate rows. Scoped to
				// the container, since the placeholder is unique only within it.
				const linked = await db.findMany({
					model: "pii_subject",
					where: [
						...subjectContainerWhere(mapping),
						{ field: "subjectId", value: subjectId, connector: "AND" },
					],
				});
				if (linked.length > 0) continue;
				await db.create({
					model: "pii_subject",
					data: {
						placeholder: mapping.placeholder,
						subjectId,
						scope: mapping.scope,
						scopeId: mapping.scopeId,
					},
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
			// Find every (placeholder, container) this subject appears on (multi-subject safe), then
			// erase the value — the placeholder becomes permanently un-rehydratable — and all of that
			// value's subject rows, scoped to its OWN container so a namesake elsewhere is untouched.
			const subjectRows = await db.findMany({
				model: "pii_subject",
				where: [{ field: "subjectId", value: subjectId }],
			});
			const seen = new Set<string>();
			for (const row of subjectRows) {
				const key = JSON.stringify([
					row.placeholder,
					row.scope ?? null,
					row.scopeId ?? null,
				]);
				if (seen.has(key)) continue;
				seen.add(key);
				const mappingErase: MappingWhere[] = [
					{ field: "placeholder", value: row.placeholder },
				];
				if (row.scope !== undefined) {
					mappingErase.push({
						field: "scope",
						value: row.scope,
						connector: "AND",
					});
				}
				if (row.scopeId !== undefined) {
					mappingErase.push({
						field: "scopeId",
						value: row.scopeId,
						connector: "AND",
					});
				}
				await db.deleteMany({ model: "pii_mapping", where: mappingErase });
				await db.deleteMany({
					model: "pii_subject",
					where: subjectContainerWhere(row),
				});
			}
		},
	};
}
