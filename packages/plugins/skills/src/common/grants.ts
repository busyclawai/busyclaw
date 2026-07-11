import {
	ACTOR_CONTEXT_KEY,
	ORGANIZATION_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	type TurnContext,
} from "@euroclaw/contracts";
import type {
	SkillAclPermission,
	SkillInstallationRecord,
	SkillsStore,
} from "../core";

function contextString(ctx: TurnContext, key: string): string | undefined {
	const value = ctx[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Container satisfaction — can this context "stand inside" the installation's `(scope, scopeId)`
 * boundary? String equality against the runtime-stamped context facts (actor/team/organization),
 * never a membership lookup — the skills plugin stays org-blind; whoever stamped the fact resolved
 * the membership. Replaces the old hard organization gate. Unknown scope kinds fail CLOSED until
 * the policy layer learns them; `global` is the one deliberate pass (a row explicitly shared with
 * everyone).
 */
export function withinScope(
	ctx: TurnContext,
	boundary: { scope: string; scopeId: string },
): boolean {
	switch (boundary.scope) {
		case "personal":
			return contextString(ctx, ACTOR_CONTEXT_KEY) === boundary.scopeId;
		case "team":
			return contextString(ctx, TEAM_CONTEXT_KEY) === boundary.scopeId;
		case "organization":
			return contextString(ctx, ORGANIZATION_CONTEXT_KEY) === boundary.scopeId;
		case "global":
			return true;
		default:
			return false;
	}
}

// Grant resolution: the container gate first (the boundary the installation lives in), then the ACL
// ladder — does the actor (or its team / organization / a public grant) hold `permission` on the
// installation? A grant never reaches OUTSIDE the container: sharing with an actor who cannot stand
// inside the boundary stays impossible, exactly as the old organization gate had it. Shared by
// active-skill resolution (the gate) and the governed lifecycle API.
export async function hasSkillGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	permission: SkillAclPermission;
	store: SkillsStore;
}): Promise<boolean> {
	if (!withinScope(input.ctx, input.installation)) return false;
	const grants = await input.store.acl.listForInstallation(
		input.installation.id,
	);
	const actorId = contextString(input.ctx, ACTOR_CONTEXT_KEY);
	const teamId = contextString(input.ctx, TEAM_CONTEXT_KEY);
	const organizationId = contextString(input.ctx, ORGANIZATION_CONTEXT_KEY);
	return grants.some(
		(grant) =>
			grant.permission === input.permission &&
			(grant.principalType === "public" ||
				(grant.principalType === "actor" &&
					actorId !== undefined &&
					grant.principalId === actorId) ||
				(grant.principalType === "team" &&
					teamId !== undefined &&
					grant.principalId === teamId) ||
				(grant.principalType === "organization" &&
					organizationId !== undefined &&
					grant.principalId === organizationId)),
	);
}

export function hasActivationGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<boolean> {
	return hasSkillGrant({ ...input, permission: "activate" });
}

export function hasReadGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<boolean> {
	return hasSkillGrant({ ...input, permission: "read" });
}
