import {
	type AccessGrant,
	type AccessGrantRecord,
	type Adapter,
	accessGrantCreateInput,
	accessGrantFields,
	validationError,
} from "@euroclaw/contracts";
import {
	type EntityPatch,
	type EntityWhere,
	entityView,
} from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import {
	type CreateSkillActivationInput,
	type CreateSkillInstallationInput,
	type CreateSkillPackageInput,
	type CreateSkillProposalInput,
	type CreateSkillReadInput,
	createSkillActivationInput,
	createSkillInstallationInput,
	createSkillPackageInput,
	createSkillProposalInput,
	createSkillReadInput,
	type SkillInstallationStatusPatch,
	type SkillProposalStatusPatch,
	type SkillsStore,
	skillActivationFields,
	skillInstallationFields,
	skillPackageFields,
	skillProposalFields,
	skillReadFields,
} from "../core";

export type SkillsStoreOptions = {
	/** Time source for deterministic tests and host-controlled timestamps. */
	now?: () => string;
};

const newId = (): string => bytesToHex(randomBytes(16));

function assertCreateSkillPackageInput(
	input: unknown,
): CreateSkillPackageInput {
	const valid = createSkillPackageInput(input) as
		| CreateSkillPackageInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create skill package input invalid", valid.summary);
	}
	// The manifest column is schema-first (`field.json(skillManifest)`), so the input schema above
	// already validated `manifest` through `skillManifest` — no separate re-parse needed here.
	return valid;
}

function assertCreateSkillInstallationInput(
	input: unknown,
): CreateSkillInstallationInput {
	const valid = createSkillInstallationInput(input) as
		| CreateSkillInstallationInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError(
			"create skill installation input invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertNewAccessGrant(input: unknown) {
	const valid = accessGrantCreateInput(input);
	if (valid instanceof type.errors) {
		throw validationError("new access grant invalid", valid.summary);
	}
	return valid;
}

function assertCreateSkillActivationInput(
	input: unknown,
): CreateSkillActivationInput {
	const valid = createSkillActivationInput(input) as
		| CreateSkillActivationInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError(
			"create skill activation input invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertCreateSkillReadInput(input: unknown): CreateSkillReadInput {
	const valid = createSkillReadInput(input) as
		| CreateSkillReadInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create skill read input invalid", valid.summary);
	}
	return valid;
}

function assertCreateSkillProposalInput(
	input: unknown,
): CreateSkillProposalInput {
	const valid = createSkillProposalInput(input) as
		| CreateSkillProposalInput
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("create skill proposal input invalid", valid.summary);
	}
	return valid;
}

export function createSkillsStore(
	// The entity-validating adapter the assembly hands through the configure context; entityView
	// opens the typed lens for this plugin's own models (fails loud if one was never declared).
	// Tests wrap manually: entityAdapter(memoryAdapter(), …).
	adapter: Adapter,
	options: SkillsStoreOptions = {},
): SkillsStore {
	const db = entityView(adapter, {
		skill_package: { fields: skillPackageFields },
		skill_installation: { fields: skillInstallationFields },
		// The generic shareable-resource ACL (a CORE table) — skill grants live here as
		// `resourceKind="skill"` rows. Registered on the assembly's adapter, so this lens reaches it.
		access_grant: { fields: accessGrantFields },
		skill_activation: { fields: skillActivationFields },
		skill_read: { fields: skillReadFields },
		skill_proposal: { fields: skillProposalFields },
	});
	const now = options.now ?? (() => new Date().toISOString());

	return {
		packages: {
			async create(input) {
				const valid = assertCreateSkillPackageInput(input);
				return db.create({
					model: "skill_package",
					data: { ...valid, id: valid.id ?? newId(), createdAt: now() },
				});
			},

			get(id) {
				return db.findOne({
					model: "skill_package",
					where: [{ field: "id", value: id }],
				});
			},

			getByDigest(digest) {
				return db.findOne({
					model: "skill_package",
					where: [{ field: "digest", value: digest }],
				});
			},

			getByPackageVersion(input) {
				return db.findOne({
					model: "skill_package",
					where: [
						{ field: "packageId", value: input.packageId },
						{ field: "version", value: input.version, connector: "AND" },
					],
				});
			},

			list(input = {}) {
				const where: EntityWhere<typeof skillPackageFields>[] = [];
				if (input.source !== undefined) {
					where.push({ field: "source", value: input.source });
				}
				if (input.publisher !== undefined) {
					where.push({
						field: "publisher",
						value: input.publisher,
						connector: where.length > 0 ? "AND" : undefined,
					});
				}
				return db.findMany({
					model: "skill_package",
					where,
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},

		installations: {
			async create(input) {
				const valid = assertCreateSkillInstallationInput(input);
				const ts = now();
				return db.create({
					model: "skill_installation",
					data: {
						...valid,
						id: valid.id ?? newId(),
						// An installation is personal to its installer until re-shared — the one scope
						// literal in this store (mirrors claws.create).
						scope: valid.scope ?? "personal",
						scopeId: valid.scopeId ?? valid.createdBy,
						status: valid.status ?? "installed",
						createdAt: ts,
						updatedAt: ts,
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "skill_installation",
					where: [{ field: "id", value: id }],
				});
			},

			listForScope(input) {
				const where: EntityWhere<typeof skillInstallationFields>[] = [
					{ field: "scope", value: input.scope },
					{ field: "scopeId", value: input.scopeId, connector: "AND" },
				];
				if (input.status !== undefined) {
					where.push({
						field: "status",
						value: input.status,
						connector: "AND",
					});
				}
				return db.findMany({
					model: "skill_installation",
					where,
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			async updateStatus(id, patch: SkillInstallationStatusPatch) {
				const update: EntityPatch<typeof skillInstallationFields> = {
					updatedAt: now(),
				};
				if (patch.status !== undefined) update.status = patch.status;
				if (patch.trustedBy !== undefined) update.trustedBy = patch.trustedBy;
				if (patch.enabledBy !== undefined) update.enabledBy = patch.enabledBy;
				return db.update({
					model: "skill_installation",
					where: [{ field: "id", value: id }],
					update,
				});
			},
		},

		// The generic AccessGrantStore over `access_grant`, backed by the SAME adapter (mirrors
		// storage-durable's createAccessGrantStore, but via `entityView` since the assembly hands the
		// plugin an already entity-validating adapter). Rows are IMMUTABLE: a share is a `create`, an
		// unshare a `delete`. `listForResource` projects each validated row to the opaque
		// `{ principalRef, level }` shape the runtime gate consumes.
		grants: {
			async listForResource(resourceKind, resourceId) {
				const rows = await db.findMany({
					model: "access_grant",
					where: [
						{ field: "resourceKind", value: resourceKind },
						{ field: "resourceId", value: resourceId, connector: "AND" },
					],
					sortBy: { field: "createdAt", direction: "asc" },
				});
				return rows.map(
					(row): AccessGrant => ({
						principalRef: row.principalRef,
						level: row.permission,
					}),
				);
			},

			async create(input) {
				const valid = assertNewAccessGrant(input);
				const record: AccessGrantRecord = {
					id: newId(),
					createdAt: now(),
					...valid,
				};
				await db.create({ model: "access_grant", data: record });
				return record;
			},

			delete({ resourceKind, resourceId, principalRef }) {
				return db.deleteMany({
					model: "access_grant",
					where: [
						{ field: "resourceKind", value: resourceKind },
						{ field: "resourceId", value: resourceId, connector: "AND" },
						{ field: "principalRef", value: principalRef, connector: "AND" },
					],
				});
			},
		},

		activations: {
			async create(input) {
				const valid = assertCreateSkillActivationInput(input);
				return db.create({
					model: "skill_activation",
					data: { ...valid, id: valid.id ?? newId(), createdAt: now() },
				});
			},

			get(id) {
				return db.findOne({
					model: "skill_activation",
					where: [{ field: "id", value: id }],
				});
			},

			listForRun(runId) {
				return db.findMany({
					model: "skill_activation",
					where: [{ field: "runId", value: runId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			listForThread(threadId) {
				return db.findMany({
					model: "skill_activation",
					where: [{ field: "threadId", value: threadId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},

		reads: {
			async create(input) {
				const valid = assertCreateSkillReadInput(input);
				return db.create({
					model: "skill_read",
					data: { ...valid, id: valid.id ?? newId(), createdAt: now() },
				});
			},

			get(id) {
				return db.findOne({
					model: "skill_read",
					where: [{ field: "id", value: id }],
				});
			},

			listForRun(runId) {
				return db.findMany({
					model: "skill_read",
					where: [{ field: "runId", value: runId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			listForThread(threadId) {
				return db.findMany({
					model: "skill_read",
					where: [{ field: "threadId", value: threadId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},

		proposals: {
			async create(input) {
				const valid = assertCreateSkillProposalInput(input);
				const ts = now();
				return db.create({
					model: "skill_proposal",
					data: {
						...valid,
						id: valid.id ?? newId(),
						status: valid.status ?? "pending",
						createdAt: ts,
						updatedAt: ts,
					},
				});
			},

			get(id) {
				return db.findOne({
					model: "skill_proposal",
					where: [{ field: "id", value: id }],
				});
			},

			listForScope(input) {
				const where: EntityWhere<typeof skillProposalFields>[] = [
					{ field: "scope", value: input.scope },
					{ field: "scopeId", value: input.scopeId, connector: "AND" },
				];
				if (input.status !== undefined) {
					where.push({
						field: "status",
						value: input.status,
						connector: "AND",
					});
				}
				return db.findMany({
					model: "skill_proposal",
					where,
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			async updateStatus(id, patch: SkillProposalStatusPatch) {
				const update: EntityPatch<typeof skillProposalFields> = {
					updatedAt: now(),
				};
				if (patch.status !== undefined) update.status = patch.status;
				if (patch.state !== undefined) update.state = patch.state;
				return db.update({
					model: "skill_proposal",
					where: [{ field: "id", value: id }],
					update,
				});
			},
		},
	};
}
