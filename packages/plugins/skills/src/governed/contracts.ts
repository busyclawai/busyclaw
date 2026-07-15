import type {
	AccessGrant,
	AccessGrantRecord,
	EuroclawPlugin,
} from "@euroclaw/contracts";
import type {
	CreateSkillInstallationInput,
	CreateSkillPackageInput,
	CreateSkillProposalInput,
	SkillActivationRecord,
	SkillInstallationRecord,
	SkillInstallationStatus,
	SkillInstallationStatusPatch,
	SkillManifest,
	SkillPackageRecord,
	SkillPackageSource,
	SkillProposalRecord,
	SkillProposalStatus,
	SkillProposalStatusPatch,
	SkillReadRecord,
} from "../core";
import type { SimpleSkillsApi } from "../simple/contracts";
import type {
	enableSkillInstallationInput,
	grantActivationInput,
	grantSkillInput,
	installSkillInput,
	requestShareInput,
	shareSkillInput,
	shareSkillResult,
	trustSkillInstallationInput,
} from "./schema";

export type InstallSkillInput = typeof installSkillInput.infer;
export type TrustSkillInstallationInput =
	typeof trustSkillInstallationInput.infer;
export type EnableSkillInstallationInput =
	typeof enableSkillInstallationInput.infer;
export type GrantActivationInput = typeof grantActivationInput.infer;
export type GrantSkillInput = typeof grantSkillInput.infer;
export type RequestShareInput = typeof requestShareInput.infer;
export type ShareSkillInput = typeof shareSkillInput.infer;
export type ShareSkillResult = typeof shareSkillResult.infer;

/**
 * The full governed skills surface: the additive {@link SimpleSkillsApi} plus the install / trust /
 * enable / grant / share lifecycle and the raw substore accessors.
 */
export type SkillsApi = SimpleSkillsApi & {
	install: (input: InstallSkillInput) => Promise<SkillInstallationRecord>;
	trustInstallation: (
		input: TrustSkillInstallationInput,
	) => Promise<SkillInstallationRecord>;
	enableInstallation: (
		input: EnableSkillInstallationInput,
	) => Promise<SkillInstallationRecord>;
	grantActivation: (input: GrantActivationInput) => Promise<AccessGrantRecord>;
	requestShare: (input: RequestShareInput) => Promise<SkillProposalRecord>;
	share: (input: ShareSkillInput) => Promise<ShareSkillResult>;
	packages: {
		create: (input: CreateSkillPackageInput) => Promise<SkillPackageRecord>;
		get: (input: { id: string }) => Promise<SkillPackageRecord | null>;
		getByDigest: (input: {
			digest: string;
		}) => Promise<SkillPackageRecord | null>;
		getByPackageVersion: (input: {
			packageId: string;
			version: string;
		}) => Promise<SkillPackageRecord | null>;
		list: (input?: {
			publisher?: string;
			source?: SkillPackageSource;
		}) => Promise<SkillPackageRecord[]>;
	};
	installations: {
		create: (
			input: CreateSkillInstallationInput,
		) => Promise<SkillInstallationRecord>;
		get: (input: { id: string }) => Promise<SkillInstallationRecord | null>;
		listForScope: (input: {
			status?: SkillInstallationStatus;
			scope: string;
			scopeId: string;
		}) => Promise<SkillInstallationRecord[]>;
		updateStatus: (input: {
			id: string;
			patch: SkillInstallationStatusPatch;
		}) => Promise<SkillInstallationRecord | null>;
	};
	grants: {
		grant: (input: GrantSkillInput) => Promise<AccessGrantRecord>;
		listForInstallation: (input: {
			installationId: string;
		}) => Promise<AccessGrant[]>;
	};
	activations: {
		get: (input: { id: string }) => Promise<SkillActivationRecord | null>;
		listForRun: (input: { runId: string }) => Promise<SkillActivationRecord[]>;
		listForThread: (input: {
			threadId: string;
		}) => Promise<SkillActivationRecord[]>;
	};
	reads: {
		get: (input: { id: string }) => Promise<SkillReadRecord | null>;
		listForRun: (input: { runId: string }) => Promise<SkillReadRecord[]>;
		listForThread: (input: { threadId: string }) => Promise<SkillReadRecord[]>;
	};
	proposals: {
		create: (input: CreateSkillProposalInput) => Promise<SkillProposalRecord>;
		get: (input: { id: string }) => Promise<SkillProposalRecord | null>;
		listForScope: (input: {
			status?: SkillProposalStatus;
			scope: string;
			scopeId: string;
		}) => Promise<SkillProposalRecord[]>;
		updateStatus: (input: {
			id: string;
			patch: SkillProposalStatusPatch;
		}) => Promise<SkillProposalRecord | null>;
	};
};

export type GovernedSkillsPlugin<
	Skills extends readonly SkillManifest[] = readonly SkillManifest[],
> = EuroclawPlugin<
	"no-cron",
	readonly string[],
	{ readonly skills: SkillsApi }
> & {
	readonly $Infer?: {
		readonly skills: Skills[number];
	};
};
