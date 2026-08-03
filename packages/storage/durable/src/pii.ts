import type { Adapter, ScopeRef } from "@busyclaw/contracts";
import {
	isConflict,
	type PiiMapping,
	type PiiMappingStore,
	piiContainer,
	piiErasureFields,
	piiMappingFields,
	piiSubjectFields,
} from "@busyclaw/contracts";
import type { SecretBinding, SecretCipher } from "@busyclaw/secrets";
import { type EntityWhere, entityDb } from "@busyclaw/storage-core";

export type PiiMappingStoreOptions = {
	/** The table PII mappings live in. Default "pii_mapping". */
	model?: string;
	/** The subject junction table. Default "pii_subject". */
	subjectModel?: string;
	/**
	 * The at-rest cipher for the `original` column (R-M07). Absent ⇒ stored as it arrives.
	 *
	 * This table holds EVERY value the system has ever tokenized — the largest concentration of
	 * personal data anywhere in a deployment, and the one whose whole existence is "we took this
	 * seriously". Erasure works by deleting rows, so sealing is defence in depth rather than a second
	 * erasure path: it makes a stolen dump useless without also stealing the key, and turns
	 * shredding one key into a faster answer to a breach than proving rows were deleted.
	 */
	cipher?: SecretCipher;
	/** Time source — for deterministic tombstone timestamps in tests. */
	now?: () => string;
};

type MappingWhere = EntityWhere<typeof piiMappingFields>;
type SubjectWhere = EntityWhere<typeof piiSubjectFields>;

// Every predicate below names BOTH halves of the container unconditionally. That is the point of the
// columns being required: while they were optional these clauses were built conditionally, so a row
// with no container produced a where of `placeholder` alone — which matches the namesake token in
// every OTHER container. Word-code placeholders are collision-minted per container, so namesakes are
// expected rather than rare.
//
// `deleteForSubject` was the reachable consequence: erasing an uncontained subject deleted contained
// mappings that happened to share a token, destroying an unrelated claw's ability to rehydrate. The
// save path was already narrower by luck rather than design — `sameContainer` rejected the cross-
// container match before `mappingWhere` was ever reached, so the update never fired — but it was one
// refactor away from the same failure. An unconditional clause cannot widen either way.

/** The exact-row predicate: the placeholder plus its whole container — the composite primary key. */
function mappingWhere(row: {
	placeholder: string;
	scope: string;
	scopeId: string;
}): MappingWhere[] {
	return [
		{ field: "placeholder", value: row.placeholder },
		{ field: "scope", value: row.scope, connector: "AND" },
		{ field: "scopeId", value: row.scopeId, connector: "AND" },
	];
}

/** A junction predicate scoped to one container — the placeholder is unique only within it, so
 *  erasure must never reach a namesake mapping in another container. */
function subjectContainerWhere(row: {
	placeholder: string;
	scope: string;
	scopeId: string;
}): SubjectWhere[] {
	return [
		{ field: "placeholder", value: row.placeholder },
		{ field: "scope", value: row.scope, connector: "AND" },
		{ field: "scopeId", value: row.scopeId, connector: "AND" },
	];
}

/** Containment: a placeholder rehydrates only within the same (scope, scopeId) container. A context
 *  with no container — or only half of one — resolves to UNCONTAINED, so it can only ever match rows
 *  written by an equally context-less redaction. */
function sameContainer(
	mapping: PiiMapping,
	ctx: Parameters<PiiMappingStore["resolve"]>[1],
): boolean {
	const container = piiContainer(ctx);
	return (
		mapping.scope === container.scope && mapping.scopeId === container.scopeId
	);
}

/**
 * The AAD one mapping's original is sealed under.
 *
 * The placeholder is unique within a container, so this is row-specific: a ciphertext lifted into
 * another placeholder's row — or the same placeholder in another claw — will not open, because the
 * tag is bound to the triple it was sealed for. Same property that lets ONE deployment key cover the
 * bot token and this table at once.
 */
function originalBinding(mapping: {
	scope: string;
	scopeId: string;
	placeholder: string;
}): SecretBinding {
	return {
		scope: mapping.scope,
		scopeId: mapping.scopeId,
		name: mapping.placeholder,
	};
}

/**
 * Open a stored original, or hand back what is there.
 *
 * A row written before a key was configured is not a failure — it is a row from before, and refusing
 * it would make every historical placeholder un-rehydratable the moment a deployment turns sealing
 * on. So an unopenable value passes through: the mapping still resolves, and the operator's migration
 * is a re-save rather than an outage.
 */
async function openOriginal(
	row: {
		original: string;
		scope: string;
		scopeId: string;
		placeholder: string;
	},
	cipher?: SecretCipher,
): Promise<string> {
	if (!cipher) return row.original;
	try {
		return await cipher.open(row.original, originalBinding(row));
	} catch {
		return row.original;
	}
}

export function createPiiMappingStore(
	adapter: Adapter,
	options: PiiMappingStoreOptions = {},
): PiiMappingStore {
	const now = options.now ?? (() => new Date().toISOString());
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
		pii_erasure: { fields: piiErasureFields },
	});
	return {
		durable: true,

		async save(mapping, subjectIds) {
			// Sealed on the way in, ALWAYS — `findByHash` hands the caller an opened mapping and the
			// caller passes that same object straight back here to append subject rows, so a store that
			// only sealed "new" values would re-save an opened one in the clear.
			const sealed = options.cipher
				? {
						...mapping,
						original: await options.cipher.seal(
							mapping.original,
							originalBinding(mapping),
						),
					}
				: mapping;
			const rows = await db.findMany({
				model: "pii_mapping",
				where: [{ field: "placeholder", value: mapping.placeholder }],
			});
			const existing = rows.find((row) => sameContainer(row, mapping));
			if (existing) {
				await db.update({
					model: "pii_mapping",
					where: mappingWhere(mapping),
					update: sealed,
				});
			} else {
				await db.create({ model: "pii_mapping", data: sealed });
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
			if (row === undefined) return null;
			return openOriginal(row, options.cipher);
		},

		async findByHash(originalHash, ctx) {
			const rows = await db.findMany({
				model: "pii_mapping",
				where: [{ field: "originalHash", value: originalHash }],
			});
			const row = rows.find((mapping) => sameContainer(mapping, ctx));
			if (row === undefined) return null;
			// Opened, because the caller round-trips this object back into `save` — see there.
			return { ...row, original: await openOriginal(row, options.cipher) };
		},

		async isErased(subjectId, ctx) {
			const container = piiContainer(ctx);
			const row = await db.findOne({
				model: "pii_erasure",
				where: [
					{ field: "subjectId", value: subjectId },
					{ field: "scope", value: container.scope, connector: "AND" },
					{ field: "scopeId", value: container.scopeId, connector: "AND" },
				],
			});
			return row !== null;
		},

		async deleteForSubject(subjectId: string, container?: ScopeRef) {
			// R-M06. Erasure is FOUR writes — shred the mappings, drop the subject rows, then tombstone
			// each container — and a crash between them leaves a torn one: mappings gone with no standing
			// instruction, or an instruction with rows still readable. Run inside a transaction when the
			// adapter has one, which is the shape better-auth uses too (`transaction?` on its adapter
			// config, with a declared sequential fallback for backends that cannot).
			//
			// Sequential otherwise, unchanged — and no longer silent about it: the tombstone failure that
			// used to be swallowed is loud, so a torn erasure is reported rather than reported as success.
			const run = async (tx: typeof db): Promise<number> => {
				// Find every (placeholder, container) this subject appears on (multi-subject safe), then
				// erase the value — the placeholder becomes permanently un-rehydratable — and all of that
				// value's subject rows, scoped to its OWN container so a namesake elsewhere is untouched.
				//
				// A `container` narrows the FIND, not the deletes below: those were already per-container
				// (a shred must never reach a namesake in another one), so bounding the sweep is entirely a
				// question of which subject rows are in scope. Omitted ⇒ every container, which is the
				// deployment-wide DSR answer and the only one this verb used to give.
				const subjectRows = await tx.findMany({
					model: "pii_subject",
					where: container
						? [
								{ field: "subjectId", value: subjectId },
								{ field: "scope", value: container.scope, connector: "AND" },
								{
									field: "scopeId",
									value: container.scopeId,
									connector: "AND",
								},
							]
						: [{ field: "subjectId", value: subjectId }],
				});
				const seen = new Set<string>();
				let erased = 0;
				for (const row of subjectRows) {
					const key = JSON.stringify([row.placeholder, row.scope, row.scopeId]);
					if (seen.has(key)) continue;
					seen.add(key);
					erased += await tx.deleteMany({
						model: "pii_mapping",
						where: mappingWhere(row),
					});
					await tx.deleteMany({
						model: "pii_subject",
						where: subjectContainerWhere(row),
					});
				}
				// The TOMBSTONE, one per container this subject was erased from. Without it erasure is a
				// point-in-time delete: the mappings go, and the very next turn naming the same person mints
				// them again — forgotten until somebody says your name. The mark makes the request standing.
				const containers = new Set<string>();
				for (const row of subjectRows) {
					containers.add(JSON.stringify([row.scope, row.scopeId]));
				}
				// Nothing found ⇒ nothing marked, and that is the honest limit rather than an oversight:
				// erasure is addressed by subject alone, with no container in the request, so the only
				// containers this can name are the ones the subject's own rows named. A subject erased
				// before they ever appeared leaves no mark — there is nowhere truthful to put one.
				const at = now();
				for (const key of containers) {
					const [scope, scopeId] = JSON.parse(key) as [string, string];
					// Re-erasing is not an error and must not fail on the composite key.
					try {
						await tx.create({
							model: "pii_erasure",
							data: { subjectId, scope, scopeId, erasedAt: at },
						});
					} catch (error) {
						// R-M06. ONLY a duplicate is survivable here. This caught everything, so a tombstone
						// that failed to write for any other reason — the table missing, the connection gone,
						// a constraint nobody expected — reported a completed erasure whose STANDING half had
						// silently not happened: the mappings were shredded, and the very next turn naming the
						// same person would mint them again with nothing to say they must not.
						//
						// "Already tombstoned" is still not an error: the instruction stands and its first date
						// is the true one.
						if (!isConflict(error)) throw error;
					}
				}
				// Mappings shredded, not subject rows: it is the mapping that made a placeholder
				// rehydratable, so it is the mapping whose removal is the erasure.
				return erased;
			};
			return db.transaction ? db.transaction(run) : run(db);
		},
	};
}
