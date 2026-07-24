import { asPrincipal, endpoints, validationError } from "@euroclaw/contracts";
import { type as ark } from "arktype";
import type { SkillsApiOptions } from "../common/contracts";
import { SKILL_RESOURCE_KIND } from "../common/grants";
import { assertSkillManifest } from "../common/manifest";
import { requireSkillsStore } from "../common/plugin";
import type {
	CreateSkillInstallationInput,
	CreateSkillPackageInput,
	CreateSkillProposalInput,
	SkillInstallationRecord,
	SkillInstallationStatus,
	SkillInstallationStatusPatch,
	SkillPackageRecord,
	SkillPackageSource,
	SkillProposalRecord,
	SkillProposalStatus,
	SkillProposalStatusPatch,
	SkillsStore,
} from "../core";
import {
	createSkillInstallationInput,
	createSkillPackageInput,
	createSkillProposalInput,
} from "../core";
import { simpleSkillsEndpoints } from "../simple/api";
import type {
	EnableSkillInstallationInput,
	GrantActivationInput,
	GrantSkillInput,
	InstallSkillInput,
	RequestShareInput,
	ShareSkillInput,
	ShareSkillResult,
	SkillsApi,
	TrustSkillInstallationInput,
} from "./contracts";
import {
	assertGrantActivationInput,
	assertGrantSkillInput,
	assertRequestShareInput,
	assertShareSkillInput,
} from "./grants";
import {
	enableSkillInstallationInput,
	grantActivationInput,
	grantSkillInput,
	installSkillInput,
	listSkillGrantsForInstallationInput,
	listSkillInstallationsInput,
	listSkillPackagesInput,
	listSkillProposalsInput,
	requestShareInput,
	shareSkillInput,
	shareSkillResult,
	skillPackageDigestLookupInput,
	skillPackageVersionLookupInput,
	skillRowLookupInput,
	skillRunLookupInput,
	skillThreadLookupInput,
	trustSkillInstallationInput,
	updateSkillInstallationStatusInput,
	updateSkillProposalStatusInput,
} from "./schema";

/** Map the split grantee (principalType + principalId, the shape the skills API and proposals speak)
 *  to the unified `access_grant.principalRef`: `public`; an `actor` is already a `user:<id>` principal
 *  (verbatim); `team`/`organization` label their opaque id. This is the ONE write-time mapping — the
 *  API surface keeps the split grantee, only the persisted row is unified. */
function principalRefOf(grantee: {
	principalType: "actor" | "team" | "organization" | "public";
	principalId?: string;
}): string {
	if (grantee.principalType === "public") return "public";
	if (grantee.principalId === undefined) {
		// grantPrincipal enforces a principalId for every non-public type — unreachable past the schema.
		throw validationError(
			"grant input invalid",
			`principalId is required for a ${grantee.principalType} grant`,
		);
	}
	return grantee.principalType === "actor"
		? grantee.principalId
		: `${grantee.principalType}:${grantee.principalId}`;
}

function assertInstallSkillInput(input: unknown): InstallSkillInput {
	const valid = installSkillInput(input);
	if (valid instanceof ark.errors) {
		throw validationError("install skill input invalid", valid.summary);
	}
	return valid;
}

function assertTrustSkillInstallationInput(
	input: unknown,
): TrustSkillInstallationInput {
	const valid = trustSkillInstallationInput(input) as
		| TrustSkillInstallationInput
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError(
			"trust skill installation input invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertEnableSkillInstallationInput(
	input: unknown,
): EnableSkillInstallationInput {
	const valid = enableSkillInstallationInput(input) as
		| EnableSkillInstallationInput
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError(
			"enable skill installation input invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertShareSkillResult(input: unknown): ShareSkillResult {
	const valid = shareSkillResult(input);
	if (valid instanceof ark.errors) {
		throw validationError("share skill result invalid", valid.summary);
	}
	return valid;
}

async function packageForInstall(input: {
	install: InstallSkillInput;
	store: SkillsStore;
}): Promise<SkillPackageRecord> {
	const byDigest = input.install.digest
		? await input.store.packages.getByDigest(input.install.digest)
		: null;
	const byVersion = input.install.version
		? await input.store.packages.getByPackageVersion({
				packageId: input.install.packageId,
				version: input.install.version,
			})
		: null;
	const pkg = byDigest ?? byVersion;
	if (
		!pkg ||
		pkg.packageId !== input.install.packageId ||
		(input.install.version !== undefined &&
			pkg.version !== input.install.version) ||
		(input.install.digest !== undefined && pkg.digest !== input.install.digest)
	) {
		throw validationError(
			"install skill input invalid",
			"skill package not found",
		);
	}
	return pkg;
}

// By-id reach, the claws shape — the old caller-supplied organization match was a claim, not
// authorization; real access policy over these lifecycle methods is app-authz's.
async function requireInstallation(input: {
	installationId: string;
	label: string;
	store: SkillsStore;
}): Promise<SkillInstallationRecord> {
	const installation = await input.store.installations.get(
		input.installationId,
	);
	if (!installation) {
		throw validationError(input.label, "installation not found");
	}
	return installation;
}

async function createShareProposal(input: {
	share: RequestShareInput;
	store: SkillsStore;
}): Promise<SkillProposalRecord> {
	const installation = await requireInstallation({
		installationId: input.share.installationId,
		label: "request share input invalid",
		store: input.store,
	});
	return input.store.proposals.create({
		kind: "share",
		proposerActorId: asPrincipal(input.share.requestedBy),
		state: {
			installationId: installation.id,
			permission: "activate",
			principalType: input.share.principalType,
			requestedBy: input.share.requestedBy,
			version: "skills.share.v1",
			...(input.share.principalId !== undefined
				? { principalId: input.share.principalId }
				: {}),
			...(input.share.reason !== undefined
				? { reason: input.share.reason }
				: {}),
		},
		targetInstallationId: installation.id,
		// The review inbox is the target installation's boundary — derived from the row, never a
		// caller claim.
		scope: installation.scope,
		scopeId: installation.scopeId,
	});
}

async function grantShare(input: {
	share: ShareSkillInput;
	approvedBy: string;
	store: SkillsStore;
}) {
	const installation = await requireInstallation({
		installationId: input.share.installationId,
		label: "share skill input invalid",
		store: input.store,
	});
	// The approved share becomes an access_grant at the `use` level (activation), attributed to the
	// approver. The grantee's split principal maps to the unified principalRef at this one write site.
	return input.store.grants.create({
		resourceKind: SKILL_RESOURCE_KIND,
		resourceId: installation.id,
		principalRef: principalRefOf(input.share),
		permission: "use",
		grantedBy: asPrincipal(input.approvedBy),
	});
}

export function createGovernedSkillsApi(
	store: SkillsStore | undefined,
	options: SkillsApiOptions = {},
): SkillsApi {
	const resolvedStore = () => requireSkillsStore(store);
	// ONE endpoints() call over the whole surface — the simple DEFS spread in (never the built
	// namespace, whose metadata a spread would drop), the lifecycle methods beside them, and the raw
	// substores as GROUPS (`/skills/packages/create` and friends fall out of the group keys).
	return endpoints({
		...simpleSkillsEndpoints(store, options),
		install: {
			input: installSkillInput,
			handler: async (input: InstallSkillInput) => {
				const valid = assertInstallSkillInput(input);
				const pkg = await packageForInstall({
					install: valid,
					store: resolvedStore(),
				});
				return resolvedStore().installations.create({
					createdBy: asPrincipal(valid.createdBy),
					digest: pkg.digest,
					packageId: pkg.packageId,
					scope: valid.scope,
					scopeId: valid.scopeId,
					status: valid.initialStatus ?? "installed",
					version: pkg.version,
				});
			},
		},
		trustInstallation: {
			input: trustSkillInstallationInput,
			handler: async (input: TrustSkillInstallationInput) => {
				const valid = assertTrustSkillInstallationInput(input);
				const installation = await requireInstallation({
					installationId: valid.installationId,
					label: "trust skill installation input invalid",
					store: resolvedStore(),
				});
				if (
					installation.status !== "installed" &&
					installation.status !== "quarantined"
				) {
					throw validationError(
						"trust skill installation input invalid",
						"installation must be installed or quarantined",
					);
				}
				const updated = await resolvedStore().installations.updateStatus(
					installation.id,
					{
						status: "trusted",
						trustedBy: asPrincipal(valid.trustedBy),
					},
				);
				if (!updated)
					throw validationError(
						"trust skill installation input invalid",
						"installation not found",
					);
				return updated;
			},
		},
		enableInstallation: {
			input: enableSkillInstallationInput,
			handler: async (input: EnableSkillInstallationInput) => {
				const valid = assertEnableSkillInstallationInput(input);
				const installation = await requireInstallation({
					installationId: valid.installationId,
					label: "enable skill installation input invalid",
					store: resolvedStore(),
				});
				if (installation.status !== "trusted") {
					throw validationError(
						"enable skill installation input invalid",
						"installation must be trusted",
					);
				}
				const updated = await resolvedStore().installations.updateStatus(
					installation.id,
					{
						enabledBy: asPrincipal(valid.enabledBy),
						status: "enabled",
					},
				);
				if (!updated)
					throw validationError(
						"enable skill installation input invalid",
						"installation not found",
					);
				return updated;
			},
		},
		grantActivation: {
			input: grantActivationInput,
			handler: async (input: GrantActivationInput) => {
				const valid = assertGrantActivationInput(input);
				const installation = await requireInstallation({
					installationId: valid.installationId,
					label: "grant activation input invalid",
					store: resolvedStore(),
				});
				return resolvedStore().grants.create({
					resourceKind: SKILL_RESOURCE_KIND,
					resourceId: installation.id,
					principalRef: principalRefOf(valid),
					permission: "use",
					grantedBy: asPrincipal(valid.grantedBy),
				});
			},
		},
		requestShare: {
			input: requestShareInput,
			handler: async (input: RequestShareInput) => {
				const valid = assertRequestShareInput(input);
				return createShareProposal({
					share: valid,
					store: resolvedStore(),
				});
			},
		},
		share: {
			input: shareSkillInput,
			handler: async (input: ShareSkillInput) => {
				const valid = assertShareSkillInput(input);
				// Governed share requires explicit approval: with no approver, emit a proposal for
				// review; an approver short-circuits straight to the grant.
				if (valid.approvedBy === undefined) {
					return assertShareSkillResult({
						proposal: await createShareProposal({
							share: valid,
							store: resolvedStore(),
						}),
						status: "proposed",
					});
				}
				return assertShareSkillResult({
					grant: await grantShare({
						share: valid,
						approvedBy: valid.approvedBy,
						store: resolvedStore(),
					}),
					status: "granted",
				});
			},
		},
		packages: {
			create: {
				input: createSkillPackageInput,
				handler: async (input: CreateSkillPackageInput) => {
					return resolvedStore().packages.create({
						...input,
						manifest: assertSkillManifest(input.manifest),
					});
				},
			},
			get: {
				input: skillRowLookupInput,
				handler: ({ id }: { id: string }) => resolvedStore().packages.get(id),
			},
			getByDigest: {
				input: skillPackageDigestLookupInput,
				handler: ({ digest }: { digest: string }) =>
					resolvedStore().packages.getByDigest(digest),
			},
			getByPackageVersion: {
				input: skillPackageVersionLookupInput,
				handler: (input: { packageId: string; version: string }) =>
					resolvedStore().packages.getByPackageVersion(input),
			},
			list: {
				input: listSkillPackagesInput,
				handler: (input?: {
					publisher?: string;
					source?: SkillPackageSource;
				}) => resolvedStore().packages.list(input),
			},
		},
		installations: {
			create: {
				input: createSkillInstallationInput,
				handler: (input: CreateSkillInstallationInput) =>
					resolvedStore().installations.create(input),
			},
			get: {
				input: skillRowLookupInput,
				handler: ({ id }: { id: string }) =>
					resolvedStore().installations.get(id),
			},
			listForScope: {
				input: listSkillInstallationsInput,
				handler: (input: {
					status?: SkillInstallationStatus;
					scope: string;
					scopeId: string;
				}) => resolvedStore().installations.listForScope(input),
			},
			updateStatus: {
				input: updateSkillInstallationStatusInput,
				handler: ({
					id,
					patch,
				}: {
					id: string;
					patch: SkillInstallationStatusPatch;
				}) => resolvedStore().installations.updateStatus(id, patch),
			},
		},
		// The raw generic-grant surface (the migrated `acl` group): grant writes an `access_grant` row
		// for the installation; listForInstallation projects its grants to the `{ principalRef, level }`
		// shape. Rows are immutable — no id-get / by-principal listing (both dropped with skill_acl).
		grants: {
			grant: {
				input: grantSkillInput,
				handler: async (input: GrantSkillInput) => {
					const valid = assertGrantSkillInput(input);
					const installation = await requireInstallation({
						installationId: valid.installationId,
						label: "grant skill input invalid",
						store: resolvedStore(),
					});
					return resolvedStore().grants.create({
						resourceKind: SKILL_RESOURCE_KIND,
						resourceId: installation.id,
						principalRef: principalRefOf(valid),
						permission: valid.permission,
						grantedBy: asPrincipal(valid.grantedBy),
					});
				},
			},
			listForInstallation: {
				input: listSkillGrantsForInstallationInput,
				handler: ({ installationId }: { installationId: string }) =>
					resolvedStore().grants.listForResource(
						SKILL_RESOURCE_KIND,
						installationId,
					),
			},
		},
		activations: {
			get: {
				input: skillRowLookupInput,
				handler: ({ id }: { id: string }) =>
					resolvedStore().activations.get(id),
			},
			listForRun: {
				input: skillRunLookupInput,
				handler: ({ runId }: { runId: string }) =>
					resolvedStore().activations.listForRun(runId),
			},
			listForThread: {
				input: skillThreadLookupInput,
				handler: ({ threadId }: { threadId: string }) =>
					resolvedStore().activations.listForThread(threadId),
			},
		},
		reads: {
			get: {
				input: skillRowLookupInput,
				handler: ({ id }: { id: string }) => resolvedStore().reads.get(id),
			},
			listForRun: {
				input: skillRunLookupInput,
				handler: ({ runId }: { runId: string }) =>
					resolvedStore().reads.listForRun(runId),
			},
			listForThread: {
				input: skillThreadLookupInput,
				handler: ({ threadId }: { threadId: string }) =>
					resolvedStore().reads.listForThread(threadId),
			},
		},
		proposals: {
			create: {
				input: createSkillProposalInput,
				handler: (input: CreateSkillProposalInput) =>
					resolvedStore().proposals.create(input),
			},
			get: {
				input: skillRowLookupInput,
				handler: ({ id }: { id: string }) => resolvedStore().proposals.get(id),
			},
			listForScope: {
				input: listSkillProposalsInput,
				handler: (input: {
					status?: SkillProposalStatus;
					scope: string;
					scopeId: string;
				}) => resolvedStore().proposals.listForScope(input),
			},
			updateStatus: {
				input: updateSkillProposalStatusInput,
				handler: ({
					id,
					patch,
				}: {
					id: string;
					patch: SkillProposalStatusPatch;
				}) => resolvedStore().proposals.updateStatus(id, patch),
			},
		},
	});
}
