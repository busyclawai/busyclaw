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
	createdBy: nes.configure({
		euroclaw: {
			doc: "Who installs — recorded for accountability and branded to a Principal. Not authorization; access policy over the lifecycle methods is app-authz's job.",
		},
	}),
	"digest?": optionalNes.configure({
		euroclaw: {
			doc: "Resolves the package by digest; the handler then cross-checks that packageId/version/digest all agree and rejects as 'skill package not found' otherwise.",
		},
	}),
	"initialStatus?": type("'installed' | 'quarantined' | undefined").configure({
		euroclaw: {
			doc: "A skill cannot be installed straight to trusted or enabled; defaults to 'installed'.",
		},
	}),
	packageId: nes.configure({
		euroclaw: {
			doc: "Logical package id (stable across versions); must match the package resolved by digest/version.",
		},
	}),
	"scope?": optionalNes.configure({
		euroclaw: {
			doc: "The boundary the installation lands in; omit both scope and scopeId to install personal to createdBy (the store default).",
		},
	}),
	"scopeId?": optionalNes,
	"version?": optionalNes.configure({
		euroclaw: {
			doc: "Resolves the package by (packageId, version); the narrow requires version or digest to be present.",
		},
	}),
}).narrow(
	(value, ctx) =>
		value.version !== undefined ||
		value.digest !== undefined ||
		ctx.reject("version or digest"),
);

export const trustSkillInstallationInput = type({
	installationId: nes.configure({
		euroclaw: {
			doc: "The handler requires the installation's current status to be 'installed' or 'quarantined' before promoting it to 'trusted'.",
		},
	}),
	trustedBy: nes.configure({
		euroclaw: {
			doc: "Recorded as the trustedBy principal stamp on the installation.",
		},
	}),
});

export const enableSkillInstallationInput = type({
	enabledBy: nes.configure({
		euroclaw: {
			doc: "Recorded as the enabledBy principal stamp on the installation.",
		},
	}),
	installationId: nes.configure({
		euroclaw: {
			doc: "The handler requires current status === 'trusted' before enabling — enforcing the installed→trusted→enabled ladder.",
		},
	}),
});

// public grants carry no principalId; every other principal type requires a non-empty one.
const grantPrincipal = type({
	principalType: "'public'",
	"principalId?": "undefined",
})
	.or({
		principalType: "'actor' | 'team' | 'organization'",
		principalId: nes,
	})
	.configure({
		euroclaw: {
			doc: "Names the eventual grantee: a 'public' grant must omit principalId; actor/team/organization each require a non-empty principalId.",
		},
	});

export const grantActivationInput = type({
	installationId: nes.configure({
		euroclaw: {
			doc: "The installation must exist; the grant always issues the 'activate' permission.",
		},
	}),
}).and(grantPrincipal);

export const requestShareInput = type({
	installationId: nes.configure({
		euroclaw: {
			doc: "The proposal's review-inbox (scope, scopeId) is derived from this installation, never from a caller claim.",
		},
	}),
	"reason?": optionalNes.configure({
		euroclaw: { doc: "Optional free text carried into the proposal state." },
	}),
	requestedBy: nes.configure({
		euroclaw: {
			doc: "Branded to a Principal as the proposal's proposerActorId and also copied into state.requestedBy.",
		},
	}),
}).and(grantPrincipal);

export const shareSkillInput = type({
	"approvedBy?": optionalNes.configure({
		euroclaw: {
			doc: "The governed-share discriminator: absent emits a proposal (status 'proposed'); present short-circuits straight to the ACL grant (status 'granted'). Only its presence is used.",
		},
	}),
	installationId: nes.configure({
		euroclaw: {
			doc: "Same derive-the-review-inbox-from-the-installation rule as requestShare.",
		},
	}),
	"reason?": optionalNes,
	requestedBy: nes.configure({
		euroclaw: {
			doc: "The proposer/requester; carried into the proposal state on the review path.",
		},
	}),
}).and(grantPrincipal);

export const shareSkillResult = type({
	grant: skillAclRecord,
	status: "'granted'",
})
	.or({
		proposal: skillProposalRecord,
		status: "'proposed'",
	})
	.configure({
		euroclaw: {
			doc: "The 'granted' branch carries the ACL grant (an approver was supplied); the 'proposed' branch carries the proposal (the review path).",
		},
	});

// ── Substore boundary inputs ─────────────────────────────────────────────────
// The raw substore accessors (packages/installations/acl/activations/reads/proposals) are routed
// endpoints too, so their query/patch shapes get validators here. In-process they stay the plain TS
// signatures the stores declare; over HTTP these parse the wire input. Patch shapes mirror the
// hand-declared Status-patch types exactly — entity.updateSchema() would admit every mutable column,
// wider than the api's contract.
export const skillRowLookupInput = type({
	id: nes.configure({
		euroclaw: {
			doc: "Generic single-row get by primary id, reused by the packages/installations/acl/activations/reads/proposals get endpoints.",
		},
	}),
});
export const skillPackageDigestLookupInput = type({ digest: nes });
export const skillPackageVersionLookupInput = type({
	packageId: nes.configure({
		euroclaw: { doc: "Logical package id, not the row id." },
	}),
	version: nes,
});
export const listSkillPackagesInput = type({
	"publisher?": optionalNes,
	"source?": skillPackageSource.or("undefined"),
});
export const listSkillInstallationsInput = type({
	scope: nes.configure({
		euroclaw: {
			doc: "Both scope and scopeId are required — lists exactly one boundary, with no personal/default fallback (unlike install).",
		},
	}),
	scopeId: nes,
	"status?": skillInstallationStatus.or("undefined"),
});
export const updateSkillInstallationStatusInput = type({
	id: nes,
	patch: type({
		"enabledBy?": optionalNes,
		"status?": skillInstallationStatus.or("undefined"),
		"trustedBy?": optionalNes,
	}).configure({
		euroclaw: {
			doc: "Hand-narrowed to enabledBy/status/trustedBy — deliberately narrower than entity.updateSchema(), which would admit every mutable column, keeping the api contract from widening.",
		},
	}),
});
export const listSkillAclForInstallationInput = type({ installationId: nes });
export const listSkillAclForPrincipalInput = type({
	"permission?": skillAclPermission.or("undefined"),
	"principalId?": optionalNes,
	principalType: skillAclPrincipalType.configure({
		euroclaw: {
			doc: "Required; principalId and permission are optional filters.",
		},
	}),
});
export const skillRunLookupInput = type({
	runId: nes.configure({
		euroclaw: { doc: "Reused by activations.listForRun and reads.listForRun." },
	}),
});
export const skillThreadLookupInput = type({
	threadId: nes.configure({
		euroclaw: {
			doc: "Reused by activations.listForThread and reads.listForThread.",
		},
	}),
});
export const listSkillProposalsInput = type({
	scope: nes.configure({
		euroclaw: {
			doc: "Both scope and scopeId are required — the review-inbox boundary being listed.",
		},
	}),
	scopeId: nes,
	"status?": skillProposalStatus.or("undefined"),
});
export const updateSkillProposalStatusInput = type({
	id: nes,
	patch: type({
		"state?": skillProposalState.or("undefined"),
		"status?": skillProposalStatus.or("undefined"),
	}).configure({
		euroclaw: {
			doc: "Narrowed to state/status only, mirroring the hand-declared patch type — narrower than the entity's full mutable set.",
		},
	}),
});
