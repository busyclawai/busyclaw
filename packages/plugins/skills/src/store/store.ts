import { type Adapter, validationError, type Where } from "@euroclaw/contracts";
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
	type SkillAclRecord,
	type SkillActivationRecord,
	type SkillInstallationRecord,
	type SkillInstallationStatusPatch,
	type SkillPackageRecord,
	type SkillProposalRecord,
	type SkillProposalStatusPatch,
	type SkillReadRecord,
	type SkillsStore,
	skillAclRecord,
	skillActivationRecord,
	skillInstallationRecord,
	skillManifest,
	skillPackageRecord,
	skillProposalRecord,
	skillReadRecord,
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
	const manifest = skillManifest(valid.manifest);
	if (manifest instanceof type.errors) {
		throw validationError("skill package manifest invalid", manifest.summary);
	}
	return valid;
}

function assertSkillPackageRecord(input: unknown): SkillPackageRecord {
	const valid = skillPackageRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("skill package record invalid", valid.summary);
	}
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

function assertSkillInstallationRecord(
	input: unknown,
): SkillInstallationRecord {
	const valid = skillInstallationRecord(input) as
		| SkillInstallationRecord
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("skill installation record invalid", valid.summary);
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

function assertSkillAclRecord(input: unknown): SkillAclRecord {
	const valid = skillAclRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("skill acl record invalid", valid.summary);
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

function assertSkillActivationRecord(input: unknown): SkillActivationRecord {
	const valid = skillActivationRecord(input) as
		| SkillActivationRecord
		| type.errors;
	if (valid instanceof type.errors) {
		throw validationError("skill activation record invalid", valid.summary);
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

function assertSkillReadRecord(input: unknown): SkillReadRecord {
	const valid = skillReadRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("skill read record invalid", valid.summary);
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

function assertSkillProposalRecord(input: unknown): SkillProposalRecord {
	const valid = skillProposalRecord(input);
	if (valid instanceof type.errors) {
		throw validationError("skill proposal record invalid", valid.summary);
	}
	return valid;
}

export function createSkillsStore(
	// The schema-aware adapter the assembly hands through the configure context; tests wrap manually.
	db: Adapter,
	options: SkillsStoreOptions = {},
): SkillsStore {
	const now = options.now ?? (() => new Date().toISOString());

	return {
		packages: {
			async create(input) {
				const valid = assertCreateSkillPackageInput(input);
				const record = assertSkillPackageRecord({
					id: valid.id ?? newId(),
					packageId: valid.packageId,
					version: valid.version,
					digest: valid.digest,
					manifest: valid.manifest,
					instructions: valid.instructions,
					source: valid.source,
					publisher: valid.publisher,
					signature: valid.signature,
					createdAt: now(),
				});
				await db.create({ model: "skill_package", data: record });
				return record;
			},

			get(id) {
				return db.findOne<SkillPackageRecord>({
					model: "skill_package",
					where: [{ field: "id", value: id }],
				});
			},

			getByDigest(digest) {
				return db.findOne<SkillPackageRecord>({
					model: "skill_package",
					where: [{ field: "digest", value: digest }],
				});
			},

			getByPackageVersion(input) {
				return db.findOne<SkillPackageRecord>({
					model: "skill_package",
					where: [
						{ field: "packageId", value: input.packageId },
						{ field: "version", value: input.version, connector: "AND" },
					],
				});
			},

			list(input = {}) {
				const where: Where[] = [];
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
				return db.findMany<SkillPackageRecord>({
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
				const record = assertSkillInstallationRecord({
					id: valid.id ?? newId(),
					packageId: valid.packageId,
					version: valid.version,
					digest: valid.digest,
					createdBy: valid.createdBy,
					// An installation is personal to its installer until re-shared — the one scope
					// literal in this store (mirrors claws.create).
					scope: valid.scope ?? "personal",
					scopeId: valid.scopeId ?? valid.createdBy,
					status: valid.status ?? "installed",
					trustedBy: valid.trustedBy,
					enabledBy: valid.enabledBy,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "skill_installation", data: record });
				return record;
			},

			get(id) {
				return db.findOne<SkillInstallationRecord>({
					model: "skill_installation",
					where: [{ field: "id", value: id }],
				});
			},

			listForScope(input) {
				const where: Where[] = [
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
				return db.findMany<SkillInstallationRecord>({
					model: "skill_installation",
					where,
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			async updateStatus(id, patch: SkillInstallationStatusPatch) {
				const update: Record<string, unknown> = { updatedAt: now() };
				if (patch.status !== undefined) update.status = patch.status;
				if (patch.trustedBy !== undefined) update.trustedBy = patch.trustedBy;
				if (patch.enabledBy !== undefined) update.enabledBy = patch.enabledBy;
				const row = await db.update<SkillInstallationRecord>({
					model: "skill_installation",
					where: [{ field: "id", value: id }],
					update,
				});
				return row ? assertSkillInstallationRecord(row) : null;
			},
		},

		acl: {
			async grant(input) {
				const valid = assertCreateSkillAclInput(input);
				const record = assertSkillAclRecord({
					id: valid.id ?? newId(),
					installationId: valid.installationId,
					principalType: valid.principalType,
					principalId: valid.principalId,
					permission: valid.permission,
					createdAt: now(),
				});
				await db.create({ model: "skill_acl", data: record });
				return record;
			},

			get(id) {
				return db.findOne<SkillAclRecord>({
					model: "skill_acl",
					where: [{ field: "id", value: id }],
				});
			},

			listForInstallation(installationId) {
				return db.findMany<SkillAclRecord>({
					model: "skill_acl",
					where: [{ field: "installationId", value: installationId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			listForPrincipal(input) {
				const where: Where[] = [
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
				return db.findMany<SkillAclRecord>({
					model: "skill_acl",
					where,
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},

		activations: {
			async create(input) {
				const valid = assertCreateSkillActivationInput(input);
				const record = assertSkillActivationRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					threadId: valid.threadId,
					runId: valid.runId,
					installationId: valid.installationId,
					skillId: valid.skillId,
					digest: valid.digest,
					activatedBy: valid.activatedBy,
					source: valid.source,
					createdAt: now(),
				});
				await db.create({ model: "skill_activation", data: record });
				return record;
			},

			get(id) {
				return db.findOne<SkillActivationRecord>({
					model: "skill_activation",
					where: [{ field: "id", value: id }],
				});
			},

			listForRun(runId) {
				return db.findMany<SkillActivationRecord>({
					model: "skill_activation",
					where: [{ field: "runId", value: runId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			listForThread(threadId) {
				return db.findMany<SkillActivationRecord>({
					model: "skill_activation",
					where: [{ field: "threadId", value: threadId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},
		},

		reads: {
			async create(input) {
				const valid = assertCreateSkillReadInput(input);
				const record = assertSkillReadRecord({
					id: valid.id ?? newId(),
					clawId: valid.clawId,
					threadId: valid.threadId,
					runId: valid.runId,
					installationId: valid.installationId,
					skillId: valid.skillId,
					packageId: valid.packageId,
					version: valid.version,
					digest: valid.digest,
					readBy: valid.readBy,
					source: valid.source,
					createdAt: now(),
				});
				await db.create({ model: "skill_read", data: record });
				return record;
			},

			get(id) {
				return db.findOne<SkillReadRecord>({
					model: "skill_read",
					where: [{ field: "id", value: id }],
				});
			},

			listForRun(runId) {
				return db.findMany<SkillReadRecord>({
					model: "skill_read",
					where: [{ field: "runId", value: runId }],
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			listForThread(threadId) {
				return db.findMany<SkillReadRecord>({
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
				const record = assertSkillProposalRecord({
					id: valid.id ?? newId(),
					scope: valid.scope,
					scopeId: valid.scopeId,
					targetInstallationId: valid.targetInstallationId,
					proposerActorId: valid.proposerActorId,
					kind: valid.kind,
					status: valid.status ?? "pending",
					state: valid.state,
					createdAt: ts,
					updatedAt: ts,
				});
				await db.create({ model: "skill_proposal", data: record });
				return record;
			},

			get(id) {
				return db.findOne<SkillProposalRecord>({
					model: "skill_proposal",
					where: [{ field: "id", value: id }],
				});
			},

			listForScope(input) {
				const where: Where[] = [
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
				return db.findMany<SkillProposalRecord>({
					model: "skill_proposal",
					where,
					sortBy: { field: "createdAt", direction: "asc" },
				});
			},

			async updateStatus(id, patch: SkillProposalStatusPatch) {
				const update: Record<string, unknown> = { updatedAt: now() };
				if (patch.status !== undefined) update.status = patch.status;
				if (patch.state !== undefined) update.state = patch.state;
				const row = await db.update<SkillProposalRecord>({
					model: "skill_proposal",
					where: [{ field: "id", value: id }],
					update,
				});
				return row ? assertSkillProposalRecord(row) : null;
			},
		},
	};
}
