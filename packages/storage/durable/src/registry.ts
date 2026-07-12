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
// Replace semantics: spec_registration replaces in place per (organizationId, source) — all its
// mutable columns are re-set, id/createdAt preserved. facts_overlay replaces per (organizationId,
// actionId) by delete-then-create, because a replace must CLEAR optional facts an earlier override
// set (a partial update can only add, and a nulled JSON column would fail the record schema on
// read-back) — a fresh row is the honest "the override was replaced".

import type { Adapter } from "@euroclaw/contracts";
import {
	type AuthzChangeAppend,
	type AuthzChangeStore,
	authzChangeAppend as authzChangeAppendSchema,
	authzChangeFields,
	type FactsOverlayStore,
	type FactsOverlayUpsert,
	factsOverlayFields,
	factsOverlayUpsert as factsOverlayUpsertSchema,
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
// own columns, so the const generic keeps "organizationId" a literal instead of widening to string.
const whereEq = <const F extends string>(field: F, value: string) => ({
	field,
	value,
});
const andEq = <const F extends string>(field: F, value: string) => ({
	field,
	value,
	connector: "AND" as const,
});

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
			const existing = await db.findOne({
				model: SPEC_MODEL,
				where: [
					whereEq("organizationId", valid.organizationId),
					andEq("source", valid.source),
				],
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
		},

		async get(organizationId, source) {
			return db.findOne({
				model: SPEC_MODEL,
				where: [
					whereEq("organizationId", organizationId),
					andEq("source", source),
				],
			});
		},

		async listByOrganization(organizationId) {
			return db.findMany({
				model: SPEC_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
		},
	};

	const registeredTools: RegisteredToolStore = {
		async listBySource(organizationId, source) {
			return db.findMany({
				model: TOOL_MODEL,
				where: [
					whereEq("organizationId", organizationId),
					andEq("source", source),
				],
			});
		},

		async listByOrganization(organizationId) {
			return db.findMany({
				model: TOOL_MODEL,
				where: [whereEq("organizationId", organizationId)],
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
		async listByOrganization(organizationId) {
			return db.findMany({
				model: OVERLAY_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
		},

		async upsert(input) {
			const valid = validateOverlayInput(input);
			// Replace: drop any prior override for this (org, actionId), then write the new one whole.
			await db.delete({
				model: OVERLAY_MODEL,
				where: [
					whereEq("organizationId", valid.organizationId),
					andEq("actionId", valid.actionId),
				],
			});
			const stamp = now();
			const record = await db.create({
				model: OVERLAY_MODEL,
				data: { ...valid, id: newId(), createdAt: stamp, updatedAt: stamp },
			});
			await authzChanges.append({
				organizationId: valid.organizationId,
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
					organizationId: existing.organizationId,
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

		async count(organizationId) {
			return db.count({
				model: CHANGE_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
		},

		async listByOrganization(organizationId) {
			return db.findMany({
				model: CHANGE_MODEL,
				where: [whereEq("organizationId", organizationId)],
				sortBy: { field: "at", direction: "asc" },
			});
		},
	};

	// A customer's Cedar policy slices; upsert REPLACES in place per (organizationId, name) — id +
	// createdAt preserved, updatedAt bumped (all fields required, so nothing to clear; the in-place
	// replace mirrors spec_registration). Every mutation (upsert AND delete) appends to the authz
	// change log, so the router's `count`-keyed version bumps and the edit takes effect next decision.
	const policySlices: PolicySliceStore = {
		async listByOrganization(organizationId) {
			return db.findMany({
				model: POLICY_MODEL,
				where: [whereEq("organizationId", organizationId)],
			});
		},

		async upsert(input) {
			const valid = validatePolicyInput(input);
			const existing = await db.findOne({
				model: POLICY_MODEL,
				where: [
					whereEq("organizationId", valid.organizationId),
					andEq("name", valid.name),
				],
			});
			const stamp = now();
			let record: Awaited<ReturnType<PolicySliceStore["upsert"]>>;
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
					throw stateError("policy slice vanished mid-upsert", {
						id: existing.id,
					});
				}
				record = updated;
			} else {
				record = await db.create({
					model: POLICY_MODEL,
					data: { ...valid, id: newId(), createdAt: stamp, updatedAt: stamp },
				});
			}
			// Append after the write succeeds — a failed write must never bump the router's version.
			await authzChanges.append({
				organizationId: valid.organizationId,
				kind: "policy_changed",
				summary: { slice: valid.name },
				by: valid.updatedBy,
			});
			return record;
		},

		async delete(organizationId, id) {
			// Org-scoped: find AND delete by (organizationId, id), so a caller in one org can never
			// remove another org's slice by id. A delete APPENDS a change event (keeping the count
			// monotonic) — read first for the org, skip the append when the row was absent (a no-op
			// must not bump the count).
			const existing = await db.findOne({
				model: POLICY_MODEL,
				where: [whereEq("organizationId", organizationId), andEq("id", id)],
			});
			if (!existing) return;
			await db.delete({
				model: POLICY_MODEL,
				where: [whereEq("organizationId", organizationId), andEq("id", id)],
			});
			await authzChanges.append({
				organizationId: existing.organizationId,
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
