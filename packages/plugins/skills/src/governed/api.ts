import { validationError } from "@euroclaw/contracts";
import { type as ark } from "arktype";
import type { SkillsApiOptions } from "../common/contracts";
import { assertSkillManifest } from "../common/manifest";
import { requireSkillsStore } from "../common/plugin";
import type {
	SkillInstallationRecord,
	SkillPackageRecord,
	SkillProposalRecord,
	SkillsStore,
} from "../core";
import { createSimpleSkillsApi } from "../simple/api";
import type {
	EnableSkillInstallationInput,
	InstallSkillInput,
	RequestShareInput,
	ShareSkillInput,
	ShareSkillResult,
	SkillsApi,
	TrustSkillInstallationInput,
} from "./contracts";
import {
	assertGrantActivationInput,
	assertRequestShareInput,
	assertShareSkillInput,
} from "./grants";
import {
	enableSkillInstallationInput,
	installSkillInput,
	shareSkillResult,
	trustSkillInstallationInput,
} from "./schema";

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
		proposerActorId: input.share.requestedBy,
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
	share: ShareSkillInput | RequestShareInput;
	store: SkillsStore;
}) {
	const installation = await requireInstallation({
		installationId: input.share.installationId,
		label: "share skill input invalid",
		store: input.store,
	});
	return input.store.acl.grant({
		installationId: installation.id,
		permission: "activate",
		principalId: input.share.principalId,
		principalType: input.share.principalType,
	});
}

export function createGovernedSkillsApi(
	store: SkillsStore | undefined,
	options: SkillsApiOptions = {},
): SkillsApi {
	const resolvedStore = () => requireSkillsStore(store);
	return {
		...createSimpleSkillsApi(store, options),
		async install(input) {
			const valid = assertInstallSkillInput(input);
			const pkg = await packageForInstall({
				install: valid,
				store: resolvedStore(),
			});
			return resolvedStore().installations.create({
				createdBy: valid.createdBy,
				digest: pkg.digest,
				packageId: pkg.packageId,
				scope: valid.scope,
				scopeId: valid.scopeId,
				status: valid.initialStatus ?? "installed",
				version: pkg.version,
			});
		},
		async trustInstallation(input) {
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
					trustedBy: valid.trustedBy,
				},
			);
			if (!updated)
				throw validationError(
					"trust skill installation input invalid",
					"installation not found",
				);
			return updated;
		},
		async enableInstallation(input) {
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
					enabledBy: valid.enabledBy,
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
		async grantActivation(input) {
			const valid = assertGrantActivationInput(input);
			await requireInstallation({
				installationId: valid.installationId,
				label: "grant activation input invalid",
				store: resolvedStore(),
			});
			return resolvedStore().acl.grant({
				installationId: valid.installationId,
				permission: "activate",
				principalId: valid.principalId,
				principalType: valid.principalType,
			});
		},
		async requestShare(input) {
			const valid = assertRequestShareInput(input);
			return createShareProposal({
				share: valid,
				store: resolvedStore(),
			});
		},
		async share(input) {
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
					store: resolvedStore(),
				}),
				status: "granted",
			});
		},
		packages: {
			async create(input) {
				return resolvedStore().packages.create({
					...input,
					manifest: assertSkillManifest(input.manifest),
				});
			},
			get: ({ id }) => resolvedStore().packages.get(id),
			getByDigest: ({ digest }) => resolvedStore().packages.getByDigest(digest),
			getByPackageVersion: (input) =>
				resolvedStore().packages.getByPackageVersion(input),
			list: (input) => resolvedStore().packages.list(input),
		},
		installations: {
			create: (input) => resolvedStore().installations.create(input),
			get: ({ id }) => resolvedStore().installations.get(id),
			listForScope: (input) =>
				resolvedStore().installations.listForScope(input),
			updateStatus: ({ id, patch }) =>
				resolvedStore().installations.updateStatus(id, patch),
		},
		acl: {
			grant: (input) => resolvedStore().acl.grant(input),
			get: ({ id }) => resolvedStore().acl.get(id),
			listForInstallation: ({ installationId }) =>
				resolvedStore().acl.listForInstallation(installationId),
			listForPrincipal: (input) => resolvedStore().acl.listForPrincipal(input),
		},
		activations: {
			get: ({ id }) => resolvedStore().activations.get(id),
			listForRun: ({ runId }) => resolvedStore().activations.listForRun(runId),
			listForThread: ({ threadId }) =>
				resolvedStore().activations.listForThread(threadId),
		},
		reads: {
			get: ({ id }) => resolvedStore().reads.get(id),
			listForRun: ({ runId }) => resolvedStore().reads.listForRun(runId),
			listForThread: ({ threadId }) =>
				resolvedStore().reads.listForThread(threadId),
		},
		proposals: {
			create: (input) => resolvedStore().proposals.create(input),
			get: ({ id }) => resolvedStore().proposals.get(id),
			listForScope: (input) => resolvedStore().proposals.listForScope(input),
			updateStatus: ({ id, patch }) =>
				resolvedStore().proposals.updateStatus(id, patch),
		},
	};
}
