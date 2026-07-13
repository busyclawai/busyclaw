import { type } from "arktype";
import {
	nonEmptyString,
	skillAclPermission,
	skillAclPrincipalType,
	skillAclRecord,
	skillInstallationStatus,
	skillPackageSource,
	skillProposalRecord,
	skillProposalState,
	skillProposalStatus,
} from "../core";

// Identity fields (ids, boundary refs, actor refs) must be non-empty — enforced at the schema so the
// API layer parses instead of re-checking each field with assertNonEmptyString.
const nes = nonEmptyString;
const optionalNes = nonEmptyString.or("undefined");

// `createdBy` is who installs (accountability, claws parity); `(scope, scopeId)` is the boundary
// the installation lands in — omit both to install personal to the installer (the store default).
export const installSkillInput = type({
	createdBy: nes,
	"digest?": optionalNes,
	"initialStatus?": "'installed' | 'quarantined' | undefined",
	packageId: nes,
	"scope?": optionalNes,
	"scopeId?": optionalNes,
	"version?": optionalNes,
}).narrow(
	(value, ctx) =>
		value.version !== undefined ||
		value.digest !== undefined ||
		ctx.reject("version or digest"),
);

export const trustSkillInstallationInput = type({
	installationId: nes,
	trustedBy: nes,
});

export const enableSkillInstallationInput = type({
	enabledBy: nes,
	installationId: nes,
});

// public grants carry no principalId; every other principal type requires a non-empty one.
const grantPrincipal = type({
	principalType: "'public'",
	"principalId?": "undefined",
}).or({
	principalType: "'actor' | 'team' | 'organization'",
	principalId: nes,
});

export const grantActivationInput = type({
	installationId: nes,
}).and(grantPrincipal);

export const requestShareInput = type({
	installationId: nes,
	"reason?": optionalNes,
	requestedBy: nes,
}).and(grantPrincipal);

export const shareSkillInput = type({
	"approvedBy?": optionalNes,
	installationId: nes,
	"reason?": optionalNes,
	requestedBy: nes,
}).and(grantPrincipal);

export const shareSkillResult = type({
	grant: skillAclRecord,
	status: "'granted'",
}).or({
	proposal: skillProposalRecord,
	status: "'proposed'",
});

// ── Substore boundary inputs ─────────────────────────────────────────────────
// The raw substore accessors (packages/installations/acl/activations/reads/proposals) are routed
// endpoints too, so their query/patch shapes get validators here. In-process they stay the plain TS
// signatures the stores declare; over HTTP these parse the wire input. Patch shapes mirror the
// hand-declared Status-patch types exactly — entity.updateSchema() would admit every mutable column,
// wider than the api's contract.
export const skillRowLookupInput = type({ id: nes });
export const skillPackageDigestLookupInput = type({ digest: nes });
export const skillPackageVersionLookupInput = type({
	packageId: nes,
	version: nes,
});
export const listSkillPackagesInput = type({
	"publisher?": optionalNes,
	"source?": skillPackageSource.or("undefined"),
});
export const listSkillInstallationsInput = type({
	scope: nes,
	scopeId: nes,
	"status?": skillInstallationStatus.or("undefined"),
});
export const updateSkillInstallationStatusInput = type({
	id: nes,
	patch: {
		"enabledBy?": optionalNes,
		"status?": skillInstallationStatus.or("undefined"),
		"trustedBy?": optionalNes,
	},
});
export const listSkillAclForInstallationInput = type({ installationId: nes });
export const listSkillAclForPrincipalInput = type({
	"permission?": skillAclPermission.or("undefined"),
	"principalId?": optionalNes,
	principalType: skillAclPrincipalType,
});
export const skillRunLookupInput = type({ runId: nes });
export const skillThreadLookupInput = type({ threadId: nes });
export const listSkillProposalsInput = type({
	scope: nes,
	scopeId: nes,
	"status?": skillProposalStatus.or("undefined"),
});
export const updateSkillProposalStatusInput = type({
	id: nes,
	patch: {
		"state?": skillProposalState.or("undefined"),
		"status?": skillProposalStatus.or("undefined"),
	},
});
