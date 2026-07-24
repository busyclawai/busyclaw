// Contracts, storage entities, and manifest schema — the storage-facing leaf (src/core).

export type {
	ActivateSkillContext,
	ActivateSkillContextResolver,
	ActivateSkillInput,
	ActiveSkillRef,
	ActiveSkillResolver,
	ActiveSkillSelection,
	ReadSkillContext,
	ReadSkillContextResolver,
	ReadSkillInput,
	SkillId,
	SkillsApiOptions,
	SkillsPluginConfig,
} from "./common/contracts";
// Shared runtime: manifest authoring, reserved namespace, plugin shell (src/common).
export {
	assertSkillManifest,
	assertSkillManifests,
	defineSkill,
	defineSkills,
} from "./common/manifest";
export {
	buildSkillsPlugin,
	requireSkillsStore,
	type SkillsApiFactory,
	skillReasonCodes,
} from "./common/plugin";
export { isReservedToolName, RESERVED_TOOL_PREFIX } from "./common/reserved";
export {
	activateSkillContext,
	activateSkillInput,
	readSkillContext,
	readSkillInput,
} from "./common/schema";
export type {
	CreateSkillActivationInput,
	CreateSkillInstallationInput,
	CreateSkillPackageInput,
	CreateSkillProposalInput,
	CreateSkillReadInput,
	SkillActivationRecord,
	SkillActivationSource,
	SkillActivationStore,
	SkillInstallationRecord,
	SkillInstallationStatus,
	SkillInstallationStatusPatch,
	SkillInstallationStore,
	SkillManifest,
	SkillPackageRecord,
	SkillPackageSource,
	SkillPackageStore,
	SkillProposalKind,
	SkillProposalRecord,
	SkillProposalStatus,
	SkillProposalStatusPatch,
	SkillProposalStore,
	SkillReadRecord,
	SkillReadSource,
	SkillReadStore,
	SkillsStore,
} from "./core";
export {
	skillInstallationStatus,
	skillManifest,
	skillManifestLimits,
	skillManifests,
	skillPackageSource,
	skillPiiPolicy,
	skillsModels,
	skillsSchema,
} from "./core";
// Governed (lifecycle) surface (src/governed).
export { createGovernedSkillsApi } from "./governed/api";
export type {
	EnableSkillInstallationInput,
	GovernedSkillsPlugin,
	GrantActivationInput,
	InstallSkillInput,
	RequestShareInput,
	ShareSkillInput,
	ShareSkillResult,
	SkillsApi,
	TrustSkillInstallationInput,
} from "./governed/contracts";
export { governedSkillsPlugin } from "./governed/plugin";
export {
	enableSkillInstallationInput,
	grantActivationInput,
	installSkillInput,
	requestShareInput,
	shareSkillInput,
	shareSkillResult,
	trustSkillInstallationInput,
} from "./governed/schema";
// Additive (simple) surface (src/simple).
export { createSimpleSkillsApi } from "./simple/api";
export type {
	CreatePersonalSkillInput,
	CreatePersonalSkillResult,
	ReadSkillResult,
	SimpleSkillsApi,
	SimpleSkillsPlugin,
	SkillCatalogEntry,
	SkillCatalogInput,
} from "./simple/contracts";
export { skillsPlugin } from "./simple/plugin";
export {
	createPersonalSkillInput,
	createPersonalSkillResult,
	readSkillResult,
	skillCatalogEntry,
	skillCatalogInput,
} from "./simple/schema";
export type { SkillsStoreOptions } from "./store/store";
// Durable store over the storage-core adapter (src/store).
export { createSkillsStore } from "./store/store";
