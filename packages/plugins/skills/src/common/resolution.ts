import {
	CLAW_ID_CONTEXT_KEY,
	ORGANIZATION_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	RUN_ID_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	THREAD_ID_CONTEXT_KEY,
	type TurnContext,
} from "@euroclaw/contracts";
import type {
	SkillActivationRecord,
	SkillInstallationRecord,
	SkillPackageRecord,
	SkillsStore,
} from "../core";
import type { ActiveSkillRef, SkillManifest } from "./contracts";
import { hasActivationGrant, withinScope } from "./grants";
import { assertSkillManifest } from "./manifest";
import { parseInstallationRef, parseScopeRef } from "./refs";
import type { activeSkillResolution } from "./schema";

type ActiveSkillResolution = typeof activeSkillResolution.infer;

export function contextString(
	ctx: TurnContext,
	key: string,
): string | undefined {
	const value = ctx[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The `(scope, scopeId)` boundaries this context can stand inside, from its own stamped facts —
 * personal:actor, team:team, organization:organization; each present only when the fact is. This is
 * a bounded walk over the context's OWN dimensions (at most three exact-scope lookups), NOT the
 * membership-expanding union ("all of P's orgs") — that listing belongs to app-authz. Global rows
 * are reachable by direct installation ref (withinScope passes them), just not listable here.
 */
export function contextScopePairs(
	ctx: TurnContext,
): Array<{ scope: string; scopeId: string }> {
	const pairs: Array<{ scope: string; scopeId: string }> = [];
	const actorId = contextString(ctx, PRINCIPAL_CONTEXT_KEY);
	if (actorId !== undefined)
		pairs.push({ scope: "personal", scopeId: actorId });
	const teamId = contextString(ctx, TEAM_CONTEXT_KEY);
	if (teamId !== undefined) pairs.push({ scope: "team", scopeId: teamId });
	const organizationId = contextString(ctx, ORGANIZATION_CONTEXT_KEY);
	if (organizationId !== undefined)
		pairs.push({ scope: "organization", scopeId: organizationId });
	return pairs;
}

export function statusAllowsActivation(
	installation: SkillInstallationRecord,
): boolean {
	return installation.status === "enabled" || installation.status === "trusted";
}

function packageMatchesInstallation(
	pkg: SkillPackageRecord,
	installation: SkillInstallationRecord,
): boolean {
	return (
		pkg.packageId === installation.packageId &&
		pkg.version === installation.version &&
		pkg.digest === installation.digest
	);
}

async function packageForInstallation(input: {
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<SkillPackageRecord | null> {
	const byDigest = await input.store.packages.getByDigest(
		input.installation.digest,
	);
	if (byDigest && packageMatchesInstallation(byDigest, input.installation)) {
		return byDigest;
	}
	const byVersion = await input.store.packages.getByPackageVersion({
		packageId: input.installation.packageId,
		version: input.installation.version,
	});
	return byVersion && packageMatchesInstallation(byVersion, input.installation)
		? byVersion
		: null;
}

function manifestFromPackage(pkg: SkillPackageRecord): SkillManifest {
	return assertSkillManifest(pkg.manifest);
}

export async function packageAndManifestForInstallation(input: {
	installation: SkillInstallationRecord;
	store: SkillsStore;
}): Promise<{ manifest: SkillManifest; pkg: SkillPackageRecord } | null> {
	const pkg = await packageForInstallation(input);
	if (!pkg) return null;
	return { manifest: manifestFromPackage(pkg), pkg };
}

async function resolveStoredSkillByInstallation(input: {
	ctx: TurnContext;
	installationId: string;
	ref: ActiveSkillRef;
	store: SkillsStore;
}): Promise<ActiveSkillResolution> {
	const installation = await input.store.installations.get(
		input.installationId,
	);
	if (!installation) return { status: "missing", ref: input.ref };
	// The container gate (was the organization gate): the installation's boundary must be one this
	// context stands inside — before status and grants, mirroring the old check order.
	if (!withinScope(input.ctx, installation)) {
		return { status: "out_of_scope", ref: input.ref };
	}
	if (!statusAllowsActivation(installation)) {
		return { status: "unavailable", ref: input.ref };
	}
	if (
		!(await hasActivationGrant({
			ctx: input.ctx,
			installation,
			store: input.store,
		}))
	) {
		return { status: "forbidden", ref: input.ref };
	}
	const pkg = await packageForInstallation({
		installation,
		store: input.store,
	});
	if (!pkg) return { status: "missing", ref: input.ref };
	return { status: "ok", manifest: manifestFromPackage(pkg), ref: input.ref };
}

// Resolve a skillId within the given boundaries — enabled installations first, then trusted, the
// same precedence the old per-organization lookup had.
async function resolveStoredSkillInScopes(input: {
	ctx: TurnContext;
	ref: ActiveSkillRef;
	skillId: string;
	scopes: ReadonlyArray<{ scope: string; scopeId: string }>;
	store: SkillsStore;
}): Promise<ActiveSkillResolution> {
	let forbidden = false;
	for (const status of ["enabled", "trusted"] as const) {
		for (const pair of input.scopes) {
			const installations = await input.store.installations.listForScope({
				status,
				scope: pair.scope,
				scopeId: pair.scopeId,
			});
			for (const installation of installations) {
				const pkg = await packageForInstallation({
					installation,
					store: input.store,
				});
				if (!pkg) continue;
				const manifest = manifestFromPackage(pkg);
				if (manifest.id !== input.skillId) continue;
				if (
					await hasActivationGrant({
						ctx: input.ctx,
						installation,
						store: input.store,
					})
				) {
					return { status: "ok", manifest, ref: input.ref };
				}
				forbidden = true;
			}
		}
	}
	return forbidden
		? { status: "forbidden", ref: input.ref }
		: { status: "missing", ref: input.ref };
}

export async function resolveActiveSkill(input: {
	ctx: TurnContext;
	ref: ActiveSkillRef;
	skillById: Map<string, SkillManifest>;
	store: SkillsStore | undefined;
}): Promise<ActiveSkillResolution> {
	if (typeof input.ref === "string") {
		const manifest = input.skillById.get(input.ref);
		if (manifest) return { status: "ok", manifest, ref: input.ref };
		if (!input.store) return { status: "missing", ref: input.ref };
		// A bare skillId searches the context's own boundaries (an org-less context reaches its
		// personal skills — no organization is required to resolve stored skills any more).
		return resolveStoredSkillInScopes({
			ctx: input.ctx,
			ref: input.ref,
			skillId: input.ref,
			scopes: contextScopePairs(input.ctx),
			store: input.store,
		});
	}
	if (!input.store) return { status: "missing", ref: input.ref };
	const installationRef = parseInstallationRef(input.ref);
	if (installationRef) {
		return resolveStoredSkillByInstallation({
			ctx: input.ctx,
			installationId: installationRef.installationId,
			ref: input.ref,
			store: input.store,
		});
	}
	const scopeRef = parseScopeRef(input.ref);
	if (!scopeRef) return { status: "missing", ref: input.ref };
	// A pinned boundary the context cannot stand inside short-circuits (was the ctx-org mismatch).
	if (!withinScope(input.ctx, scopeRef)) {
		return { status: "out_of_scope", ref: input.ref };
	}
	return resolveStoredSkillInScopes({
		ctx: input.ctx,
		ref: input.ref,
		skillId: scopeRef.skillId,
		scopes: [{ scope: scopeRef.scope, scopeId: scopeRef.scopeId }],
		store: input.store,
	});
}

function activationRefs(
	records: readonly SkillActivationRecord[],
): ActiveSkillRef[] {
	return records.map((record) => ({ installationId: record.installationId }));
}

// Activation rows only SHORTLIST installation refs — each ref still passes the full container +
// grant gates at resolve time, so this match is anchoring (right claw/thread), not authorization.
function activationMatchesContext(
	record: SkillActivationRecord,
	ctx: TurnContext,
): boolean {
	const clawId = contextString(ctx, CLAW_ID_CONTEXT_KEY);
	if (clawId !== undefined && record.clawId !== clawId) return false;
	const threadId = contextString(ctx, THREAD_ID_CONTEXT_KEY);
	return threadId === undefined || record.threadId === threadId;
}

function scopedActivationRefs(
	records: readonly SkillActivationRecord[],
	ctx: TurnContext,
): ActiveSkillRef[] {
	return activationRefs(
		records.filter((record) => activationMatchesContext(record, ctx)),
	);
}

export async function recordedActiveSkillRefs(input: {
	ctx: TurnContext;
	store: SkillsStore | undefined;
}): Promise<ActiveSkillRef[]> {
	if (!input.store) return [];
	const runId = contextString(input.ctx, RUN_ID_CONTEXT_KEY);
	if (runId !== undefined) {
		const runRefs = scopedActivationRefs(
			await input.store.activations.listForRun(runId),
			input.ctx,
		);
		if (runRefs.length > 0) return runRefs;
	}
	const threadId = contextString(input.ctx, THREAD_ID_CONTEXT_KEY);
	return threadId === undefined
		? []
		: scopedActivationRefs(
				await input.store.activations.listForThread(threadId),
				input.ctx,
			);
}
