import { type } from "arktype";
import { nonEmptyString, skillAclRecord, skillProposalRecord } from "../core";

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
