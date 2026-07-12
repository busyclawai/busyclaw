import { type Adapter, validationError } from "@euroclaw/contracts";
import {
	type EntityPatch,
	type EntityWhere,
	entityView,
} from "@euroclaw/storage-core";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type } from "arktype";
import {
	type CreateSkillAclInput,
	type CreateSkillActivationInput,
	type CreateSkillInstallationInput,
	type CreateSkillPackageInput,
	type CreateSkillProposalInput,
	type CreateSkillReadInput,
	createSkillAclInput,
	createSkillActivationInput,
	createSkillInstallationInput,
	createSkillPackageInput,
	createSkillProposalInput,
	createSkillReadInput,
	type SkillInstallationStatusPatch,
	type SkillProposalStatusPatch,
	type SkillsStore,
	skillAclFields,
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

function assertCreateSkillAclInput(input: unknown): CreateSkillAclInput {
	const valid = createSkillAclInput(input);
	if (valid instanceof type.errors) {
		throw validationError("create skill acl input invalid", valid.summary);
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
		skill_acl: { fields: skillAclFields },
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

		acl: {
			async grant(input) {
				const valid = assertCreateSkillAclInput(input);
				return db.create({
					model: "skill_acl",
					data: { ...valid, id: valid.id ?? newId(), createdAt: now() },
				});
			},

			get(id) {
				return db.findOne({
					model: "skill_acl",
					where: [{ field: "id", value: id }],
				});
			},

			listForInstallation(installationId) {
				return db.findMany({
					model: "skill_acl",
					where: [{ field: "installationId", value: installationId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			listForPrincipal(input) {
				const where: EntityWhere<typeof skillAclFields>[] = [
					{ field: "principalType", value: input.principalType },
				];
				if (input.principalId !== undefined) {
					where.push({
						field: "principalId",
						value: input.principalId,
						connector: "AND",
					});
				}
				if (input.permission !== undefined) {
					where.push({
						field: "permission",
						value: input.permission,
						connector: "AND",
					});
				}
				return db.findMany({
					model: "skill_acl",
					where,
					sortBy: { field: "createdAt", direction: "asc" },
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
