import {
	type AccessGrantPermission,
	type GrantMembership,
	grantLevelSatisfies,
	grantReaches,
	ORGANIZATION_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	type TurnContext,
} from "@euroclaw/contracts";
import type { SkillInstallationRecord, SkillsStore } from "../core";

/** The opaque `access_grant.resourceKind` label a skill installation's grants carry — the SAME string
 *  the plugin's `shareable` loader registers, so the product-api PEP and this runtime gate read one kind. */
export const SKILL_RESOURCE_KIND = "skill";

function contextString(ctx: TurnContext, key: string): string | undefined {
	const value = ctx[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The caller's group memberships as {@link grantReaches} consumes them, from its OWN stamped facts —
 * team and organization when present. The skills plugin stays org-blind: whoever stamped the fact
 * resolved the membership, so a `team:`/`organization:` grant reaches the caller exactly when the
 * matching fact is on the context (the same trust model the old split `principalType` ladder had).
 */
function contextMemberships(ctx: TurnContext): GrantMembership[] {
	const memberships: GrantMembership[] = [];
	const teamId = contextString(ctx, TEAM_CONTEXT_KEY);
	if (teamId !== undefined)
		memberships.push({ scope: "team", scopeId: teamId });
	const organizationId = contextString(ctx, ORGANIZATION_CONTEXT_KEY);
	if (organizationId !== undefined) {
		memberships.push({ scope: "organization", scopeId: organizationId });
	}
	return memberships;
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
			return contextString(ctx, PRINCIPAL_CONTEXT_KEY) === boundary.scopeId;
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

// Grant resolution over the generic `access_grant` table: the container gate first (the boundary the
// installation lives in), then the OWNER-RULE (the installer always reaches their own installation —
// kept UNDER `withinScope`, matching the self-grant the owner used to carry within their own scope) OR
// an `access_grant` row that both REACHES the caller (`grantReaches`: direct / team / organization /
// public) and confers AT LEAST the required level (`read < use < manage`). A grant never reaches OUTSIDE
// the container: sharing with a caller who cannot stand inside the boundary stays impossible, exactly as
// the old organization gate had it. Shared by active-skill resolution (the gate) and the governed
// lifecycle API.
export async function hasSkillGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	level: AccessGrantPermission;
	store: SkillsStore;
}): Promise<boolean> {
	if (!withinScope(input.ctx, input.installation)) return false;
	const principal = contextString(input.ctx, PRINCIPAL_CONTEXT_KEY);
	// Owner-rule: the installer reaches their own installation at every level (activate implies read).
	if (principal !== undefined && input.installation.createdBy === principal) {
		return true;
	}
	const grants = await input.store.grants.listForResource(
		SKILL_RESOURCE_KIND,
		input.installation.id,
	);
	const memberships = contextMemberships(input.ctx);
	// `principal` may be absent (a team/organization/public grant still reaches via memberships or the
	// public ref); the empty string never equals a real, non-empty principalRef, so the direct-match
	// branch simply can't fire without a principal fact.
	return grants.some(
		(grant) =>
			grantLevelSatisfies(grant.level, input.level) &&
			grantReaches(grant, principal ?? "", memberships),
	);
}

/** Can this context ACTIVATE the installation? Activation requires the `use` level (the old `activate`
 *  permission folds onto `use`). */
export function hasActivationGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<boolean> {
	return hasSkillGrant({ ...input, level: "use" });
}

/** Can this context READ the installation? Reading requires the `read` level — so a `use`/`manage`
 *  grant (or the owner) satisfies it too (activate implies read). */
export function hasReadGrant(input: {
	ctx: TurnContext;
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<boolean> {
	return hasSkillGrant({ ...input, level: "read" });
}
