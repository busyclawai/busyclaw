// createRegistryStores — the tool-registry ports (SpecRegistrationStore / RegisteredToolStore /
// FactsOverlayStore) plus the slice-6b customer-policy stores (PolicySliceStore + the append-only
// AuthzChangeStore), backed by any @euroclaw/storage-core Adapter. Persistence goes through
// `entityDb`: the model name drives the row types, JSON columns (specBlob, report, inputSchema,
// governance, binding, groups, summary) are (de)serialized by the schema layer, and every row
// crossing the adapter boundary is parsed against its record schema (untrusted boundary: a hostile
// row must fail loud, not cast) — the stores validate INPUTS and let the entity layer own the rows.
//
// The authz change log is the router's version source: every authz mutation here — facts_overlay and
// policy_slice upsert AND delete — APPENDS an authz_change (createSpecRegistry appends the
// spec_registered event). Append-only ⇒ count() is monotonic ⇒ authzBundleKey is sound under delete.
//
// Replace semantics: spec_registration replaces in place per (scope, scopeId, source) — all its
// mutable columns are re-set, id/createdAt preserved. facts_overlay replaces per (scope, scopeId,
// actionId) by delete-then-create, because a replace must CLEAR optional facts an earlier override
// set (a partial update can only add, and a nulled JSON column would fail the record schema on
// read-back) — a fresh row is the honest "the override was replaced".

import type { Adapter, ScopeRef } from "@euroclaw/contracts";
import {
	type AuthzChangeAppend,
	type AuthzChangeStore,
	authzChangeAppend as authzChangeAppendSchema,
	authzChangeFields,
	type FactsOverlayStore,
	type FactsOverlayUpsert,
	factsOverlayFields,
	factsOverlayUpsert as factsOverlayUpsertSchema,
	isConflict,
	type PolicySliceStore,
	type PolicySliceUpsert,
	policySliceFields,
	policySliceUpsert as policySliceUpsertSchema,
	type RegisteredToolCreate,
	type RegisteredToolPatch,
	type RegisteredToolStore,
	registeredToolCreate as registeredToolCreateSchema,
	registeredToolFields,
	registeredToolPatch as registeredToolPatchSchema,
	type SpecRegistrationStore,
	type SpecRegistrationUpsert,
	specRegistrationFields,
	specRegistrationUpsert as specRegistrationUpsertSchema,
	stateError,
	validationError,
} from "@euroclaw/contracts";
import { entityDb } from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";

type RegistryStoresOptions = {
	/** Time source — for deterministic createdAt/updatedAt in tests. */
	now?: () => string;
};

/** The registry ports over one adapter (they share the `now`/id sources). Also carries the slice-6b
 *  customer-policy stores — the policy slices and the append-only authz change log (whose count keys
 *  the org policy router). They ride the same adapter as product durable state, not a plugin. */
export type RegistryStores = {
	specRegistrations: SpecRegistrationStore;
	registeredTools: RegisteredToolStore;
	factsOverlay: FactsOverlayStore;
	policySlices: PolicySliceStore;
	authzChanges: AuthzChangeStore;
};

const SPEC_MODEL = "spec_registration";
const TOOL_MODEL = "registered_tool";
const OVERLAY_MODEL = "facts_overlay";
const POLICY_MODEL = "policy_slice";
const CHANGE_MODEL = "authz_change";
const newId = (): string => bytesToHex(randomBytes(16));

// Literal-preserving Where helpers: the entity layer types each clause's field against the model's
// own columns, so the const generic keeps "scope"/"scopeId" a literal instead of widening to string.
const whereEq = <const F extends string>(field: F, value: string) => ({
	field,
	value,
});
const andEq = <const F extends string>(field: F, value: string) => ({
	field,
	value,
	connector: "AND" as const,
});

/** The clauses that pin a row to one opaque access boundary. ALWAYS BOTH — matching `scopeId` alone
 *  would collide across labels, so `(team, acme)` could read `(organization, acme)`'s rows. */
const inScope = (ref: ScopeRef) =>
	[whereEq("scope", ref.scope), andEq("scopeId", ref.scopeId)] as const;

/** Attempts an upsert gets before a conflict is the caller's problem. */
const UPSERT_ATTEMPTS = 3;

/**
 * Run an upsert body again when the database refuses its insert.
 *
 * Every upsert below is lookup-then-create (or, for the overlay, delete-then-create) with a GENERATED
 * id, so two concurrent writers produce two different primary keys and the key cannot arbitrate
 * between them — the same reason a generated placeholder slipped past `pii_mapping`'s key. The
 * composite unique on each table's logical tuple is what rejects the second write; this is what turns
 * that rejection into a retry rather than a crash on a path that had a correct recovery.
 *
 * It retries the WHOLE body instead of adopting the winner's row, because that is what upsert means:
 * the caller's content is meant to land. On the second pass the row exists, so lookup-then-create
 * takes its update branch and delete-then-create replaces it. (Redaction resolves the same race the
 * opposite way — it ADOPTS, because there a placeholder already handed to a model is authoritative and
 * ours is the one to discard. Same detection, different resolution; which is why there is no shared
 * helper spanning both.)
 *
 * Every append to the authz change log happens after its write succeeds, so a retried body appends
 * exactly once — the router's version never bumps for an attempt that lost.
 *
 * Bounded, and the bound earns its keep on the overlay: two writers trading delete-then-create could
 * otherwise hand the race back and forth indefinitely. Exhausting it rethrows, because a caller whose
 * write never landed has to hear about it.
 */
async function upsertWithRetry<T>(
	what: string,
	run: () => Promise<T>,
): Promise<T> {
	for (let attempt = 1; attempt <= UPSERT_ATTEMPTS; attempt++) {
		try {
			return await run();
		} catch (error) {
			// Anything that is not the database saying "that row already exists" keeps its identity.
			if (!isConflict(error) || attempt === UPSERT_ATTEMPTS) throw error;
		}
	}
	// Unreachable: the final attempt either returns or rethrows above.
	throw stateError(`${what} exhausted its upsert attempts`);
}

/** Back the three registry ports with a storage Adapter. */
export function createRegistryStores(
	adapter: Adapter,
	options: RegistryStoresOptions = {},
): RegistryStores {
	const now = options.now ?? (() => new Date().toISOString());
	// Literal keys (not computed [SPEC_MODEL]) so the model map keeps precise per-model types.
	const db = entityDb(adapter, {
		spec_registration: { fields: specRegistrationFields },
		registered_tool: { fields: registeredToolFields },
		facts_overlay: { fields: factsOverlayFields },
		policy_slice: { fields: policySliceFields },
		authz_change: { fields: authzChangeFields },
	});

	function validateSpecInput(input: unknown): SpecRegistrationUpsert {
		const valid = specRegistrationUpsertSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("spec registration input invalid", valid.summary);
		}
		return valid;
	}
	function validateToolInput(input: unknown): RegisteredToolCreate {
		const valid = registeredToolCreateSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("registered tool input invalid", valid.summary);
		}
		return valid;
	}
	function validateToolPatch(patch: unknown): RegisteredToolPatch {
		const valid = registeredToolPatchSchema(patch);
		if (valid instanceof type.errors) {
			throw validationError("registered tool patch invalid", valid.summary);
		}
		return valid;
	}
	function validateOverlayInput(input: unknown): FactsOverlayUpsert {
		const valid = factsOverlayUpsertSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("facts overlay input invalid", valid.summary);
		}
		return valid;
	}
	function validatePolicyInput(input: unknown): PolicySliceUpsert {
		const valid = policySliceUpsertSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("policy slice input invalid", valid.summary);
		}
		return valid;
	}
	function validateChangeInput(input: unknown): AuthzChangeAppend {
		const valid = authzChangeAppendSchema(input);
		if (valid instanceof type.errors) {
			throw validationError("authz change input invalid", valid.summary);
		}
		return valid;
	}

	const specRegistrations: SpecRegistrationStore = {
		async upsert(input) {
			const valid = validateSpecInput(input);
			return upsertWithRetry("spec registration", async () => {
				const existing = await db.findOne({
					model: SPEC_MODEL,
					where: [...inScope(valid), andEq("source", valid.source)],
				});
				const stamp = now();
				if (existing) {
					const updated = await db.update({
						model: SPEC_MODEL,
						where: [whereEq("id", existing.id)],
						update: {
							specBlob: valid.specBlob,
							contentVersion: valid.contentVersion,
							report: valid.report,
							registeredBy: valid.registeredBy,
							updatedAt: stamp,
						},
					});
					if (!updated) {
						// Genuinely gone now: a concurrent delete between the read and the update. Before
						// the unique constraint, duplicate rows were another way to land here, which made
						// this message misreport its own cause.
						throw stateError("spec registration vanished mid-upsert", {
							id: existing.id,
						});
					}
					return updated;
				}
				return db.create({
					model: SPEC_MODEL,
					data: { ...valid, id: newId(), createdAt: stamp, updatedAt: stamp },
				});
			});
		},

		async get(ref, source) {
			return db.findOne({
				model: SPEC_MODEL,
				where: [...inScope(ref), andEq("source", source)],
			});
		},

		async listForScope(ref) {
			return db.findMany({
				model: SPEC_MODEL,
				where: [...inScope(ref)],
			});
		},
	};

	const registeredTools: RegisteredToolStore = {
		async listBySource(ref, source) {
			return db.findMany({
				model: TOOL_MODEL,
				where: [...inScope(ref), andEq("source", source)],
			});
		},

		async listForScope(ref) {
			return db.findMany({
				model: TOOL_MODEL,
				where: [...inScope(ref)],
			});
		},

		async create(input) {
			// Parsed inputs carry no undefined-valued keys (the entity schemas drop them), so the
			// spread writes exactly the present fields — absent stays absent at the adapter.
			const valid = validateToolInput(input);
			const stamp = now();
			return db.create({
				model: TOOL_MODEL,
				data: { ...valid, id: newId(), createdAt: stamp, updatedAt: stamp },
			});
		},

		async update(id, patch) {
			const valid = validateToolPatch(patch);
			return db.update({
				model: TOOL_MODEL,
				where: [whereEq("id", id)],
				// The store owns updatedAt — spread first so a caller-supplied one is overridden.
				update: { ...valid, updatedAt: now() },
			});
		},

		async deleteById(id) {
			await db.delete({ model: TOOL_MODEL, where: [whereEq("id", id)] });
		},
	};

	const factsOverlay: FactsOverlayStore = {
		async listForScope(ref) {
			return db.findMany({
				model: OVERLAY_MODEL,
				where: [...inScope(ref)],
			});
		},

		async upsert(input) {
			const valid = validateOverlayInput(input);
			// Replace: drop any prior override for this (org, actionId), then write the new one whole.
			// The retry is what makes the gap between the delete and the create survivable — another
			// writer can create in it, and then OUR create is the one the unique rejects.
			const record = await upsertWithRetry("facts overlay", async () => {
				await db.delete({
					model: OVERLAY_MODEL,
					where: [...inScope(valid), andEq("actionId", valid.actionId)],
				});
				const stamp = now();
				return db.create({
					model: OVERLAY_MODEL,
					data: { ...valid, id: newId(), createdAt: stamp, updatedAt: stamp },
				});
			});
			await authzChanges.append({
				scope: valid.scope,
				scopeId: valid.scopeId,
				kind: "overlay_changed",
				summary: { actionId: valid.actionId },
				by: valid.updatedBy,
			});
			return record;
		},

		async deleteById(id) {
			// Read first: the append needs the org (the router keys on its count), and a no-op delete
			// (the row is already gone) must NOT bump the count.
			const existing = await db.findOne({
				model: OVERLAY_MODEL,
				where: [whereEq("id", id)],
			});
			await db.delete({
				model: OVERLAY_MODEL,
				where: [whereEq("id", id)],
			});
			if (existing) {
				await authzChanges.append({
					scope: existing.scope,
					scopeId: existing.scopeId,
					kind: "overlay_changed",
					// `by` is the row's last actor — deleteById(id) carries no acting principal itself.
					summary: { actionId: existing.actionId, deleted: true },
					by: existing.updatedBy,
				});
			}
		},
	};

	// The append-only authz change log. `append` stamps id + at; `count` is the cheap per-decision
	// read the org router keys on; `listByOrganization` (sorted oldest-first) is the deferred-use
	// history. There is no update or delete — a DELETE elsewhere APPENDS a change event, so the count
	// stays monotonic (sound where max(updatedAt) is not).
	const authzChanges: AuthzChangeStore = {
		async append(input) {
			const valid = validateChangeInput(input);
			return db.create({
				model: CHANGE_MODEL,
				data: { ...valid, id: newId(), at: now() },
			});
		},

		async count(ref) {
			return db.count({
				model: CHANGE_MODEL,
				where: [...inScope(ref)],
			});
		},

		async listForScope(ref) {
			return db.findMany({
				model: CHANGE_MODEL,
				where: [...inScope(ref)],
				sortBy: { field: "at", direction: "asc" },
			});
		},
	};

	// A customer's Cedar policy slices; upsert REPLACES in place per (scope, scopeId, name) — id +
	// createdAt preserved, updatedAt bumped (all fields required, so nothing to clear; the in-place
	// replace mirrors spec_registration). Every mutation (upsert AND delete) appends to the authz
	// change log, so the router's `count`-keyed version bumps and the edit takes effect next decision.
	const policySlices: PolicySliceStore = {
		async listForScope(ref) {
			return db.findMany({
				model: POLICY_MODEL,
				where: [...inScope(ref)],
			});
		},

		async upsert(input) {
			const valid = validatePolicyInput(input);
			const record = await upsertWithRetry("policy slice", async () => {
				const existing = await db.findOne({
					model: POLICY_MODEL,
					where: [...inScope(valid), andEq("name", valid.name)],
				});
				const stamp = now();
				if (existing) {
					const updated = await db.update({
						model: POLICY_MODEL,
						where: [whereEq("id", existing.id)],
						// The store owns updatedAt — spread first so a caller-supplied one is overridden.
						update: {
							cedar: valid.cedar,
							mode: valid.mode,
							updatedBy: valid.updatedBy,
							updatedAt: stamp,
						},
					});
					if (!updated) {
						// A concurrent delete between the read and the update. Duplicate rows used to be
						// another route here, which made this message misreport its cause.
						throw stateError("policy slice vanished mid-upsert", {
							id: existing.id,
						});
					}
					return updated;
				}
				return db.create({
					model: POLICY_MODEL,
					data: { ...valid, id: newId(), createdAt: stamp, updatedAt: stamp },
				});
			});
			// Append after the write succeeds — a failed write must never bump the router's version.
			await authzChanges.append({
				scope: valid.scope,
				scopeId: valid.scopeId,
				kind: "policy_changed",
				summary: { slice: valid.name },
				by: valid.updatedBy,
			});
			return record;
		},

		async delete(ref, id) {
			// Scope-keyed: find AND delete by (ref, id), so a caller in one boundary can never
			// remove another boundary's slice by id. A delete APPENDS a change event (keeping the count
			// monotonic) — read first for the org, skip the append when the row was absent (a no-op
			// must not bump the count).
			const existing = await db.findOne({
				model: POLICY_MODEL,
				where: [...inScope(ref), andEq("id", id)],
			});
			if (!existing) return;
			await db.delete({
				model: POLICY_MODEL,
				where: [...inScope(ref), andEq("id", id)],
			});
			await authzChanges.append({
				scope: existing.scope,
				scopeId: existing.scopeId,
				kind: "policy_changed",
				// `by` is the row's last actor — delete carries no acting principal itself.
				summary: { slice: existing.name, deleted: true },
				by: existing.updatedBy,
			});
		},
	};

	return {
		specRegistrations,
		registeredTools,
		factsOverlay,
		policySlices,
		authzChanges,
	};
}
