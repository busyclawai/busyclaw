import type {
	AccessGrantStore,
	EntityRecord,
	EntitySchemaInput,
} from "@euroclaw/contracts";
import type {
	createSkillActivationInputOptions,
	createSkillInstallationInputOptions,
	createSkillPackageInputOptions,
	createSkillProposalInputOptions,
	createSkillReadInputOptions,
	skillActivationFields,
	skillActivationSourceValues,
	skillInstallationFields,
	skillInstallationStatusValues,
	skillManifest,
	skillPackageFields,
	skillPackageSourceValues,
	skillProposalFields,
	skillProposalKindValues,
	skillProposalStatusValues,
	skillReadFields,
	skillReadSourceValues,
} from "./schema";

export type SkillManifest = typeof skillManifest.infer;
export type SkillPackageSource = (typeof skillPackageSourceValues)[number];
export type SkillInstallationStatus =
	(typeof skillInstallationStatusValues)[number];
export type SkillActivationSource =
	(typeof skillActivationSourceValues)[number];
export type SkillReadSource = (typeof skillReadSourceValues)[number];
export type SkillProposalKind = (typeof skillProposalKindValues)[number];
export type SkillProposalStatus = (typeof skillProposalStatusValues)[number];

export type SkillPackageRecord = EntityRecord<typeof skillPackageFields>;
export type SkillInstallationRecord = EntityRecord<
	typeof skillInstallationFields
>;
export type SkillActivationRecord = EntityRecord<typeof skillActivationFields>;
export type SkillReadRecord = EntityRecord<typeof skillReadFields>;
export type SkillProposalRecord = EntityRecord<typeof skillProposalFields>;

export type CreateSkillPackageInput = EntitySchemaInput<
	typeof skillPackageFields,
	typeof createSkillPackageInputOptions
>;
export type CreateSkillInstallationInput = EntitySchemaInput<
	typeof skillInstallationFields,
	typeof createSkillInstallationInputOptions
>;
export type CreateSkillActivationInput = EntitySchemaInput<
	typeof skillActivationFields,
	typeof createSkillActivationInputOptions
>;
export type CreateSkillReadInput = EntitySchemaInput<
	typeof skillReadFields,
	typeof createSkillReadInputOptions
>;
export type CreateSkillProposalInput = EntitySchemaInput<
	typeof skillProposalFields,
	typeof createSkillProposalInputOptions
>;

export type SkillInstallationStatusPatch = Partial<
	Pick<SkillInstallationRecord, "status" | "trustedBy" | "enabledBy">
>;

export type SkillProposalStatusPatch = Partial<
	Pick<SkillProposalRecord, "status" | "state">
>;

export type SkillPackageStore = {
	create: (input: CreateSkillPackageInput) => Promise<SkillPackageRecord>;
	get: (id: string) => Promise<SkillPackageRecord | null>;
	getByDigest: (digest: string) => Promise<SkillPackageRecord | null>;
	getByPackageVersion: (input: {
		packageId: string;
		version: string;
	}) => Promise<SkillPackageRecord | null>;
	list: (input?: {
		publisher?: string;
		source?: SkillPackageSource;
	}) => Promise<SkillPackageRecord[]>;
};

export type SkillInstallationStore = {
	create: (
		input: CreateSkillInstallationInput,
	) => Promise<SkillInstallationRecord>;
	get: (id: string) => Promise<SkillInstallationRecord | null>;
	// EXACT single-scope listing (the store-filter shape) — one boundary at a time. The union across
	// a caller's boundaries is the caller's job (resolution walks its context's pairs; the full
	// membership-expanding union is app-authz's).
	listForScope: (input: {
		status?: SkillInstallationStatus;
		scope: string;
		scopeId: string;
	}) => Promise<SkillInstallationRecord[]>;
	updateStatus: (
		id: string,
		patch: SkillInstallationStatusPatch,
	) => Promise<SkillInstallationRecord | null>;
};

export type SkillActivationStore = {
	create: (input: CreateSkillActivationInput) => Promise<SkillActivationRecord>;
	get: (id: string) => Promise<SkillActivationRecord | null>;
	listForRun: (runId: string) => Promise<SkillActivationRecord[]>;
	listForThread: (threadId: string) => Promise<SkillActivationRecord[]>;
};

export type SkillReadStore = {
	create: (input: CreateSkillReadInput) => Promise<SkillReadRecord>;
	get: (id: string) => Promise<SkillReadRecord | null>;
	listForRun: (runId: string) => Promise<SkillReadRecord[]>;
	listForThread: (threadId: string) => Promise<SkillReadRecord[]>;
};

export type SkillProposalStore = {
	create: (input: CreateSkillProposalInput) => Promise<SkillProposalRecord>;
	get: (id: string) => Promise<SkillProposalRecord | null>;
	// The review inbox for one boundary — exact single-scope, like installations.
	listForScope: (input: {
		status?: SkillProposalStatus;
		scope: string;
		scopeId: string;
	}) => Promise<SkillProposalRecord[]>;
	updateStatus: (
		id: string,
		patch: SkillProposalStatusPatch,
	) => Promise<SkillProposalRecord | null>;
};

export type SkillsStore = {
	packages: SkillPackageStore;
	installations: SkillInstallationStore;
	// Skill grants are rows in the generic `access_grant` table (app-authz slice 5), keyed
	// `resourceKind="skill"`, `resourceId=<installationId>` — the bespoke `skill_acl` ACL is retired.
	// The store implements the canonical port over the SAME adapter (via `entityView`), so the plugin
	// never imports @euroclaw/storage-durable.
	grants: AccessGrantStore;
	activations: SkillActivationStore;
	reads: SkillReadStore;
	proposals: SkillProposalStore;
};
