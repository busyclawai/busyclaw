export { skillManifest, skillManifests } from "../core";

import { type } from "arktype";
import { nonEmptyString, skillManifest } from "../core";

// Identity fields (ids, boundary refs, actor refs) must be non-empty — enforced at the schema so the
// API layer parses instead of re-checking each field with assertNonEmptyString.
const nes = nonEmptyString;
const optionalNes = nonEmptyString.or("undefined");
const sourceEnum =
	"'user' | 'channel' | 'runtime' | 'cron' | 'default' | undefined";

export const activeSkillIdRef = nonEmptyString;
export const activeSkillInstallationRef = type({
	installationId: nonEmptyString,
});
// Pins a skillId lookup to ONE explicit `(scope, scopeId)` boundary (was the organization ref —
// generalized so a skill can be pinned to a personal/team/organization boundary alike).
export const activeSkillScopeRef = type({
	skillId: nonEmptyString,
	scope: nonEmptyString,
	scopeId: nonEmptyString,
});
export const activeSkillRef = activeSkillIdRef
	.or(activeSkillInstallationRef)
	.or(activeSkillScopeRef);
export const activeSkillRefs = activeSkillRef.array();

export const activeSkillResolution = type({
	status: "'ok'",
	manifest: skillManifest,
	ref: activeSkillRef,
})
	.or({ status: "'missing'", ref: activeSkillRef })
	// The ref names a boundary this context cannot stand inside (replaces organization_required:
	// with additive org, "no organization" is no longer an error — personal skills resolve fine).
	.or({ status: "'out_of_scope'", ref: activeSkillRef })
	.or({ status: "'forbidden'", ref: activeSkillRef })
	.or({ status: "'unavailable'", ref: activeSkillRef });

export const activateSkillInput = type({
	clawId: nes,
	installationId: nes,
	"runId?": optionalNes,
	"source?": sourceEnum,
	"threadId?": optionalNes,
});

// Trusted principal facts for the ladder. Org/team are ADDITIVE — absent until the host's identity
// wiring supplies them; an org-less deployment activates personal skills.
export const activateSkillContext = type({
	activatedBy: nes,
	"teamId?": optionalNes,
	"organizationId?": optionalNes,
});

export const readSkillContext = type({
	readBy: nes,
	"teamId?": optionalNes,
	"organizationId?": optionalNes,
});

export const readSkillInput = type({
	"clawId?": optionalNes,
	"id?": optionalNes,
	"installationId?": optionalNes,
	"runId?": optionalNes,
	"skillId?": optionalNes,
	"source?": sourceEnum,
	"threadId?": optionalNes,
}).narrow((value, ctx) => {
	// Exactly one of id / installationId / skillId identifies the skill to read.
	const refs = [value.id, value.installationId, value.skillId].filter(
		(ref) => ref !== undefined,
	);
	return (
		refs.length === 1 ||
		ctx.reject("exactly one of id, installationId, or skillId")
	);
});
