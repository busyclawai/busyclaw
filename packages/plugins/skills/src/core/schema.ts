import type { SchemaDeclaration } from "@euroclaw/contracts";
import { type EntityField, entity, field } from "@euroclaw/contracts";
import { type } from "arktype";

// ── Manifest constraint vocabulary ───────────────────────────────────────────
// Bounds the manifest schema imposes itself, so callers parse instead of re-validating
// length/non-empty/dedup imperatively. Mirrors the limits the skills plugin used to hand-roll.
export const skillManifestLimits = {
	maxAllowedTools: 128,
	maxDescriptionLength: 2_000,
	maxNameLength: 200,
	maxPolicyArrayEntries: 128,
	maxPolicyStringLength: 512,
	maxSkillIdLength: 128,
	maxToolNameLength: 128,
} as const;

/** A string that is non-empty after trimming (plain `string >= 1` accepts " "). Exported so the
 *  skills input schemas validate identity fields at the schema, not with call-site asserts. */
export const nonEmptyString = type("string").narrow(
	(value, ctx) => value.trim().length > 0 || ctx.reject("non-empty"),
);

/** Non-empty, trimmed, at most `max` chars. */
const boundedString = (max: number) => nonEmptyString.and(`string <= ${max}`);

/** A non-empty, length-bounded, duplicate-free string array, capped at `maxEntries`. */
const boundedUniqueArray = (maxEntries: number, maxEntryLength: number) =>
	type(`1 <= string <= ${maxEntryLength}`)
		.array()
		.narrow(
			(values, ctx) =>
				values.length <= maxEntries ||
				ctx.reject(`at most ${maxEntries} entries`),
		)
		.narrow(
			(values, ctx) =>
				new Set(values).size === values.length ||
				ctx.reject("no duplicate entries"),
		);

/** lowercase alphanumeric segments separated by '.', '_' or '-', length-bounded. */
const skillId = type(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).and(
	`1 <= string <= ${skillManifestLimits.maxSkillIdLength}`,
);

const policyArray = boundedUniqueArray(
	skillManifestLimits.maxPolicyArrayEntries,
	skillManifestLimits.maxPolicyStringLength,
);

export const skillPackageSourceValues = [
	"builtin",
	"registry",
	"upload",
	"local",
] as const;
export const skillInstallationStatusValues = [
	"quarantined",
	"installed",
	"trusted",
	"enabled",
	"disabled",
	"archived",
] as const;
export const skillAclPrincipalTypeValues = [
	"actor",
	"team",
	"organization",
	"public",
] as const;
export const skillAclPermissionValues = [
	"read",
	"activate",
	"manage",
	"share",
] as const;
export const skillActivationSourceValues = [
	"user",
	"channel",
	"runtime",
	"cron",
	"default",
] as const;
export const skillReadSourceValues = skillActivationSourceValues;
export const skillProposalKindValues = [
	"create",
	"patch",
	"share",
	"archive",
	"restore",
] as const;
export const skillProposalStatusValues = [
	"pending",
	"approved",
	"denied",
	"applied",
	"archived",
] as const;

export const skillPackageSource = type(
	"'builtin' | 'registry' | 'upload' | 'local'",
);
export const skillInstallationStatus = type(
	"'quarantined' | 'installed' | 'trusted' | 'enabled' | 'disabled' | 'archived'",
);
export const skillAclPrincipalType = type(
	"'actor' | 'team' | 'organization' | 'public'",
);
export const skillAclPermission = type(
	"'read' | 'activate' | 'manage' | 'share'",
);
export const skillActivationSource = type(
	"'user' | 'channel' | 'runtime' | 'cron' | 'default'",
);
export const skillReadSource = skillActivationSource;
export const skillProposalKind = type(
	"'create' | 'patch' | 'share' | 'archive' | 'restore'",
);
export const skillProposalStatus = type(
	"'pending' | 'approved' | 'denied' | 'applied' | 'archived'",
);

// `pii.reads/writes` declares which PII scopes a skill touches. Declared-only today (no runtime
// enforcement); the future use is scoping the redactor/detector when the skill is active.
export const skillPiiPolicy = type({
	"reads?": policyArray.or("undefined"),
	"writes?": policyArray.or("undefined"),
});

// allowedTools is bound + dedup'd by the schema; the only non-mechanical rule (reserved
// `euroclaw__` names cannot be declared) stays a behavioural check in the skills plugin.
const allowedTools = boundedUniqueArray(
	skillManifestLimits.maxAllowedTools,
	skillManifestLimits.maxToolNameLength,
);

// The v2 manifest is deliberately thin (skills-plan-v2): identity + discovery + optional scoped-tool
// backing. The how-to-use content lives in the skill body (the package's `instructions` column),
// not a hardened manifest field. Authorization is policy's job, so `allowedTools` is OPTIONAL and
// only backs scoped/locked tool variants — never a global deny-list. Unknown keys are rejected so
// an untrusted manifest can't smuggle in undeclared authority.
export const skillManifest = type({
	id: skillId,
	description: boundedString(skillManifestLimits.maxDescriptionLength),
	"name?": boundedString(skillManifestLimits.maxNameLength).or("undefined"),
	"allowedTools?": allowedTools.or("undefined"),
	"pii?": skillPiiPolicy.or("undefined"),
}).onUndeclaredKey("reject");
export const skillManifests = skillManifest.array();

export const skillPackageFields = {
	id: field.string({ required: true, unique: true }),
	packageId: field.string({ required: true, index: true }),
	version: field.string({ required: true, index: true }),
	digest: field.string({ required: true, index: true }),
	// Schema-first: the column IS `skillManifest`, so the record type is `SkillManifest` and every
	// read validates it (the store no longer needs a separate manifest re-parse). The one behavioural
	// rule the schema can't express — no reserved `euroclaw__` tool names — stays in `assertSkillManifest`.
	manifest: field.json(skillManifest, { required: true, pii: "redacted" }),
	instructions: field.string({ pii: "possible" }),
	source: field.enum(skillPackageSourceValues, { required: true, index: true }),
	publisher: field.string({ index: true }),
	signature: field.string(),
	createdAt: field.string({ required: true }),
} as const;

export const skillInstallationFields = {
	id: field.string({ required: true, unique: true }),
	packageId: field.string({ required: true, index: true }),
	version: field.string({ required: true, index: true }),
	digest: field.string({ required: true, index: true }),
	// An installation is a SHAREABLE resource (the claws shape): `createdBy` is immutable — who
	// installed it (accountability, erasure attribution). The access boundary `(scope, scopeId)` is
	// MUTABLE — an installation can be re-shared over its life (installed personal, promoted
	// org-wide). `scope` is an OPAQUE string this table never interprets; the old
	// visibility + organizationId/teamId/ownerActorId columns double-encoded exactly this pair
	// (visibility named the boundary KIND, the triple named its ID). Default at create:
	// scope="personal", scopeId=createdBy.
	createdBy: field.principal({ required: true, index: true, immutable: true }),
	scope: field.string({ required: true, index: true }),
	scopeId: field.string({ required: true, index: true }),
	status: field.enum(skillInstallationStatusValues, {
		required: true,
		index: true,
	}),
	trustedBy: field.principal({ index: true }),
	enabledBy: field.principal({ index: true }),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

// A grant row — the shares junction on an installation. Whose boundary the grant lives in is
// transitive via `installationId` (the thread→claw shape); the principal (type, id) names the
// grantee, orthogonal to tenancy.
export const skillAclFields = {
	id: field.string({ required: true, unique: true }),
	installationId: field.string({
		required: true,
		index: true,
		references: { model: "skill_installation", field: "id" },
	}),
	principalType: field.enum(skillAclPrincipalTypeValues, {
		required: true,
		index: true,
	}),
	principalId: field.string({ index: true }),
	permission: field.enum(skillAclPermissionValues, {
		required: true,
		index: true,
	}),
	createdAt: field.string({ required: true }),
} as const;

// An activation is anchored by the claw/thread/run it activates for and the installation it
// activates — both sides carry the boundary, so the row itself is tenancy-free.
export const skillActivationFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({ required: true, index: true }),
	threadId: field.string({ index: true }),
	runId: field.string({ index: true }),
	installationId: field.string({
		required: true,
		index: true,
		references: { model: "skill_installation", field: "id" },
	}),
	skillId: field.string({ required: true, index: true }),
	digest: field.string({ required: true, index: true }),
	activatedBy: field.string({ required: true, index: true }),
	source: field.enum(skillActivationSourceValues, {
		required: true,
		index: true,
	}),
	createdAt: field.string({ required: true }),
} as const;

// A read is an audit row: who read what, from where. Anchored by `readBy` and the optional
// claw/thread/run/installation refs — no tenancy stamp of its own.
export const skillReadFields = {
	id: field.string({ required: true, unique: true }),
	clawId: field.string({ index: true }),
	threadId: field.string({ index: true }),
	runId: field.string({ index: true }),
	installationId: field.string({
		index: true,
		references: { model: "skill_installation", field: "id" },
	}),
	skillId: field.string({ required: true, index: true }),
	packageId: field.string({ index: true }),
	version: field.string({ index: true }),
	digest: field.string({ index: true }),
	readBy: field.string({ required: true, index: true }),
	source: field.enum(skillReadSourceValues, {
		required: true,
		index: true,
	}),
	createdAt: field.string({ required: true }),
} as const;

// The proposal STATE — a versioned, kind-owned payload. One member today: the share proposal
// (`skills.share.v1`, produced by the governed api's createShareProposal). Future kinds
// (create/patch/archive/restore) JOIN this union with their own versioned schema when they grow a
// producer — the schema-first column makes "write the shape first" a compile-time requirement, and
// unknown keys are rejected so a stored state can't smuggle undeclared authority.
export const skillShareProposalState = type({
	version: "'skills.share.v1'",
	installationId: "string",
	permission: "'activate'",
	principalType: "'actor' | 'team' | 'organization' | 'public'",
	"principalId?": "string",
	requestedBy: "string",
	"reason?": "string",
}).onUndeclaredKey("reject");
export const skillProposalState = skillShareProposalState;
export type SkillProposalState = typeof skillProposalState.infer;

// A proposal's `(scope, scopeId)` is the review inbox — the boundary whose admins decide it. For
// share proposals it is DERIVED from the target installation at creation (server-set, never a
// caller claim); future create-proposals will carry the boundary the creation targets.
export const skillProposalFields = {
	id: field.string({ required: true, unique: true }),
	scope: field.string({ required: true, index: true }),
	scopeId: field.string({ required: true, index: true }),
	targetInstallationId: field.string({ index: true }),
	proposerActorId: field.principal({ required: true, index: true }),
	kind: field.enum(skillProposalKindValues, { required: true, index: true }),
	status: field.enum(skillProposalStatusValues, {
		required: true,
		index: true,
	}),
	// Schema-first: the column IS the versioned proposal-state union — typed on read, validated at
	// the create boundary and on every row crossing the adapter.
	state: field.json(skillProposalState, { required: true, pii: "redacted" }),
	createdAt: field.string({ required: true }),
	updatedAt: field.string({ required: true }),
} as const;

export const skillPackageEntity = entity("skill_package", skillPackageFields);
export const skillInstallationEntity = entity(
	"skill_installation",
	skillInstallationFields,
);
export const skillAclEntity = entity("skill_acl", skillAclFields);
export const skillActivationEntity = entity(
	"skill_activation",
	skillActivationFields,
);
export const skillReadEntity = entity("skill_read", skillReadFields);
export const skillProposalEntity = entity(
	"skill_proposal",
	skillProposalFields,
);

export const skillPackageRecord = skillPackageEntity.record;
export const skillInstallationRecord = skillInstallationEntity.record;
export const skillAclRecord = skillAclEntity.record;
export const skillActivationRecord = skillActivationEntity.record;
export const skillReadRecord = skillReadEntity.record;
export const skillProposalRecord = skillProposalEntity.record;

export const createSkillPackageInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createSkillInstallationInputOptions = {
	omit: ["createdAt", "updatedAt"],
	// scope/scopeId default in the store (scope="personal", scopeId=createdBy) — an installation is
	// personal to its installer until re-shared; `createdBy` is required (someone installed it).
	optional: ["id", "scope", "scopeId", "status"],
} as const;
export const createSkillAclInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createSkillActivationInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createSkillReadInputOptions = {
	omit: ["createdAt"],
	optional: ["id"],
} as const;
export const createSkillProposalInputOptions = {
	omit: ["createdAt", "updatedAt"],
	optional: ["id", "status"],
} as const;

export const createSkillPackageInput = skillPackageEntity.schema(
	createSkillPackageInputOptions,
);
export const createSkillInstallationInput = skillInstallationEntity.schema(
	createSkillInstallationInputOptions,
);
export const createSkillAclInput = skillAclEntity.schema(
	createSkillAclInputOptions,
);
export const createSkillActivationInput = skillActivationEntity.schema(
	createSkillActivationInputOptions,
);
export const createSkillReadInput = skillReadEntity.schema(
	createSkillReadInputOptions,
);
export const createSkillProposalInput = skillProposalEntity.schema(
	createSkillProposalInputOptions,
);

// One list drives everything the skills tables need — the plugin `schema` slot that getEuroclawTables
// collects for migrations AND the store schema the skills store persists through — so the two can't
// drift. Add an entity here and both follow.
const skillsEntities = [
	skillPackageEntity,
	skillInstallationEntity,
	skillAclEntity,
	skillActivationEntity,
	skillReadEntity,
	skillProposalEntity,
] as const;

/**
 * The models the skills plugin registers via `plugin.schema` — a plain field map per table, keyed by
 * table name. `getEuroclawTables` merges these into the migration schema when the skills plugin is used;
 * nothing outside this package hard-codes a skills table.
 */
export const skillsModels: Record<
	string,
	{ fields: Record<string, EntityField> }
> = Object.fromEntries(
	skillsEntities.map((skill) => [skill.name, { fields: skill.fields }]),
);

/** The tables the skills store persists — the storage view of the same {@link skillsModels}. */
export const skillsSchema: SchemaDeclaration = {};
for (const skill of skillsEntities) {
	Object.assign(skillsSchema, skill.storage);
}
