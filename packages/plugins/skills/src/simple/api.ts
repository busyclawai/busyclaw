import {
	ACTOR_CONTEXT_KEY,
	configurationError,
	ORGANIZATION_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	type TurnContext,
	validationError,
} from "@euroclaw/contracts";
import { type as ark } from "arktype";
import type {
	ActivateSkillContext,
	ActivateSkillInput,
	ReadSkillContext,
	ReadSkillInput,
	SkillManifest,
	SkillsApiOptions,
} from "../common/contracts";
import {
	hasActivationGrant,
	hasReadGrant,
	withinScope,
} from "../common/grants";
import { assertSkillManifest } from "../common/manifest";
import { requireSkillsStore } from "../common/plugin";
import {
	contextScopePairs,
	packageAndManifestForInstallation,
	statusAllowsActivation,
} from "../common/resolution";
import {
	activateSkillContext,
	activateSkillInput,
	readSkillContext,
	readSkillInput,
} from "../common/schema";
import type {
	SkillInstallationRecord,
	SkillReadRecord,
	SkillsStore,
} from "../core";
import type {
	CreatePersonalSkillInput,
	CreatePersonalSkillResult,
	ReadSkillResult,
	SimpleSkillsApi,
	SkillCatalogEntry,
	SkillCatalogInput,
} from "./contracts";
import {
	createPersonalSkillInput,
	createPersonalSkillResult,
	readSkillResult,
	skillCatalogEntry,
	skillCatalogInput,
} from "./schema";

function assertCreatePersonalSkillInput(
	input: unknown,
): CreatePersonalSkillInput {
	const valid = createPersonalSkillInput(input) as
		| CreatePersonalSkillInput
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("create personal skill input invalid", valid.summary);
	}
	return { ...valid, manifest: assertSkillManifest(valid.manifest) };
}

function assertCreatePersonalSkillResult(
	input: unknown,
): CreatePersonalSkillResult {
	const valid = createPersonalSkillResult(input) as
		| CreatePersonalSkillResult
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError(
			"create personal skill result invalid",
			valid.summary,
		);
	}
	return valid;
}

function assertSkillCatalogInput(input: unknown): SkillCatalogInput {
	const valid = skillCatalogInput(input ?? {}) as
		| SkillCatalogInput
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("skill catalog input invalid", valid.summary);
	}
	return valid;
}

function assertSkillCatalogEntry(input: unknown): SkillCatalogEntry {
	const valid = skillCatalogEntry(input);
	if (valid instanceof ark.errors) {
		throw validationError("skill catalog entry invalid", valid.summary);
	}
	return valid;
}

function assertReadSkillInput(input: unknown): ReadSkillInput {
	const valid = readSkillInput(input);
	if (valid instanceof ark.errors) {
		throw validationError("read skill input invalid", valid.summary);
	}
	return valid;
}

function assertReadSkillContext(input: unknown): ReadSkillContext {
	const valid = readSkillContext(input);
	if (valid instanceof ark.errors) {
		throw validationError("read skill context invalid", valid.summary);
	}
	return valid;
}

function assertReadSkillResult(input: unknown): ReadSkillResult {
	const valid = readSkillResult(input);
	if (valid instanceof ark.errors) {
		throw validationError("read skill result invalid", valid.summary);
	}
	return valid;
}

function staticCatalogEntry(manifest: SkillManifest): SkillCatalogEntry {
	return assertSkillCatalogEntry({
		allowedTools: manifest.allowedTools ?? [],
		description: manifest.description,
		id: manifest.id,
		kind: "static",
		name: manifest.name,
	});
}

function assertActivateSkillInput(input: unknown): ActivateSkillInput {
	const valid = activateSkillInput(input);
	if (valid instanceof ark.errors) {
		throw validationError("activate skill input invalid", valid.summary);
	}
	return valid;
}

function assertActivateSkillContext(input: unknown): ActivateSkillContext {
	const valid = activateSkillContext(input) as
		| ActivateSkillContext
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("activate skill context invalid", valid.summary);
	}
	return valid;
}

async function resolveActivateSkillContext(input: {
	activation: ActivateSkillInput;
	resolver: SkillsApiOptions["activationContext"];
}): Promise<ActivateSkillContext> {
	if (!input.resolver) {
		throw configurationError(
			"claw.api.skills.activate requires activationContext",
			{
				reason:
					"pass activationContext to createSimpleSkillsApi or skillsPlugin so skill authorization uses trusted principal data",
			},
		);
	}
	const value =
		typeof input.resolver === "function"
			? await input.resolver(input.activation)
			: input.resolver;
	return assertActivateSkillContext(value);
}

async function resolveReadSkillContext(input: {
	read: ReadSkillInput;
	resolver: SkillsApiOptions["readContext"];
}): Promise<ReadSkillContext> {
	if (!input.resolver) {
		throw configurationError("claw.api.skills.read requires readContext", {
			reason:
				"pass readContext to createSimpleSkillsApi or skillsPlugin so skill reads use trusted principal data",
		});
	}
	const value =
		typeof input.resolver === "function"
			? await input.resolver(input.read)
			: input.resolver;
	return assertReadSkillContext(value);
}

function activationTurnContext(input: ActivateSkillContext): TurnContext {
	return {
		[ACTOR_CONTEXT_KEY]: input.activatedBy,
		...(input.teamId !== undefined ? { [TEAM_CONTEXT_KEY]: input.teamId } : {}),
		...(input.organizationId !== undefined
			? { [ORGANIZATION_CONTEXT_KEY]: input.organizationId }
			: {}),
	};
}

function readTurnContext(input: ReadSkillContext): TurnContext {
	return {
		[ACTOR_CONTEXT_KEY]: input.readBy,
		...(input.teamId !== undefined ? { [TEAM_CONTEXT_KEY]: input.teamId } : {}),
		...(input.organizationId !== undefined
			? { [ORGANIZATION_CONTEXT_KEY]: input.organizationId }
			: {}),
	};
}

async function assertActivatableInstallation(input: {
	activation: ActivateSkillInput;
	activationContext: ActivateSkillContext;
	store: SkillsStore;
}): Promise<{
	installation: SkillInstallationRecord;
	manifest: ReturnType<typeof assertSkillManifest>;
}> {
	const installation = await input.store.installations.get(
		input.activation.installationId,
	);
	// Out-of-boundary reads as "not found" (existence-hiding, as the old organization gate had it).
	if (
		!installation ||
		!withinScope(activationTurnContext(input.activationContext), installation)
	) {
		throw validationError(
			"activate skill input invalid",
			"installation not found",
		);
	}
	if (!statusAllowsActivation(installation)) {
		throw validationError(
			"activate skill input invalid",
			"installation is not enabled or trusted",
		);
	}
	const resolved = await packageAndManifestForInstallation({
		installation,
		store: input.store,
	});
	if (!resolved) {
		throw validationError(
			"activate skill input invalid",
			"skill package not found for installation",
		);
	}
	if (
		!(await hasActivationGrant({
			ctx: activationTurnContext(input.activationContext),
			installation,
			store: input.store,
		}))
	) {
		throw validationError(
			"activate skill input invalid",
			"actor cannot activate this skill",
		);
	}
	return { installation, manifest: resolved.manifest };
}

export async function createReadRecord(input: {
	digest?: string;
	installationId?: string;
	packageId?: string;
	read: ReadSkillInput;
	readBy: string;
	skillId: string;
	store: SkillsStore;
	version?: string;
}): Promise<SkillReadRecord> {
	return input.store.reads.create({
		clawId: input.read.clawId,
		digest: input.digest,
		installationId: input.installationId,
		packageId: input.packageId,
		readBy: input.readBy,
		runId: input.read.runId,
		skillId: input.skillId,
		source: input.read.source ?? "user",
		threadId: input.read.threadId,
		version: input.version,
	});
}

async function readInstalledSkill(input: {
	installation: SkillInstallationRecord;
	read: ReadSkillInput;
	readContext: ReadSkillContext;
	store: SkillsStore;
}): Promise<ReadSkillResult> {
	// Out-of-boundary reads as "not found" (existence-hiding, as the old organization gate had it).
	if (!withinScope(readTurnContext(input.readContext), input.installation)) {
		throw validationError("read skill input invalid", "installation not found");
	}
	if (!statusAllowsActivation(input.installation)) {
		throw validationError(
			"read skill input invalid",
			"installation is not enabled or trusted",
		);
	}
	const resolved = await packageAndManifestForInstallation({
		installation: input.installation,
		store: input.store,
	});
	if (!resolved) {
		throw validationError(
			"read skill input invalid",
			"skill package not found for installation",
		);
	}
	if (
		!(await hasReadGrant({
			ctx: readTurnContext(input.readContext),
			installation: input.installation,
			store: input.store,
		}))
	) {
		throw validationError(
			"read skill input invalid",
			"actor cannot read this skill",
		);
	}
	const read = await createReadRecord({
		digest: resolved.pkg.digest,
		installationId: input.installation.id,
		packageId: resolved.pkg.packageId,
		read: input.read,
		readBy: input.readContext.readBy,
		skillId: resolved.manifest.id,
		store: input.store,
		version: resolved.pkg.version,
	});
	return assertReadSkillResult({
		id: resolved.manifest.id,
		installation: input.installation,
		kind: "installed",
		manifest: resolved.manifest,
		package: resolved.pkg,
		read,
	});
}

async function readInstalledSkillById(input: {
	read: ReadSkillInput;
	readContext: ReadSkillContext;
	store: SkillsStore;
}): Promise<ReadSkillResult> {
	if (input.read.installationId !== undefined) {
		const installation = await input.store.installations.get(
			input.read.installationId,
		);
		if (!installation) {
			throw validationError(
				"read skill input invalid",
				"installation not found",
			);
		}
		return readInstalledSkill({
			installation,
			read: input.read,
			readContext: input.readContext,
			store: input.store,
		});
	}
	const skillId = input.read.skillId ?? input.read.id;
	if (skillId === undefined) {
		throw validationError("read skill input invalid", "skill id is required");
	}
	// A bare skillId searches the reader's own boundaries (personal/team/organization from the
	// trusted read context) — enabled first, then trusted, as before.
	let sawMatchingSkill = false;
	const readCtx = readTurnContext(input.readContext);
	for (const status of ["enabled", "trusted"] as const) {
		for (const pair of contextScopePairs(readCtx)) {
			const installations = await input.store.installations.listForScope({
				status,
				scope: pair.scope,
				scopeId: pair.scopeId,
			});
			for (const installation of installations) {
				const resolved = await packageAndManifestForInstallation({
					installation,
					store: input.store,
				});
				if (!resolved || resolved.manifest.id !== skillId) continue;
				sawMatchingSkill = true;
				if (
					await hasReadGrant({
						ctx: readCtx,
						installation,
						store: input.store,
					})
				) {
					const read = await createReadRecord({
						digest: resolved.pkg.digest,
						installationId: installation.id,
						packageId: resolved.pkg.packageId,
						read: input.read,
						readBy: input.readContext.readBy,
						skillId: resolved.manifest.id,
						store: input.store,
						version: resolved.pkg.version,
					});
					return assertReadSkillResult({
						id: resolved.manifest.id,
						installation,
						kind: "installed",
						manifest: resolved.manifest,
						package: resolved.pkg,
						read,
					});
				}
			}
		}
	}
	throw validationError(
		"read skill input invalid",
		sawMatchingSkill ? "actor cannot read this skill" : "skill not found",
	);
}

async function installedCatalogEntries(input: {
	catalog: SkillCatalogInput;
	store: SkillsStore | undefined;
}): Promise<SkillCatalogEntry[]> {
	// Installed entries list ONE boundary at a time — both halves of the pair name it.
	if (
		!input.store ||
		input.catalog.scope === undefined ||
		input.catalog.scopeId === undefined
	) {
		return [];
	}
	const installations = await input.store.installations.listForScope({
		status: input.catalog.status,
		scope: input.catalog.scope,
		scopeId: input.catalog.scopeId,
	});
	const out: SkillCatalogEntry[] = [];
	for (const installation of installations) {
		const resolved = await packageAndManifestForInstallation({
			installation,
			store: input.store,
		});
		if (!resolved) continue;
		if (
			input.catalog.source !== undefined &&
			resolved.pkg.source !== input.catalog.source
		) {
			continue;
		}
		if (
			input.catalog.publisher !== undefined &&
			resolved.pkg.publisher !== input.catalog.publisher
		) {
			continue;
		}
		out.push(
			assertSkillCatalogEntry({
				allowedTools: resolved.manifest.allowedTools ?? [],
				description: resolved.manifest.description,
				digest: resolved.pkg.digest,
				id: resolved.manifest.id,
				installationId: installation.id,
				kind: "installed",
				name: resolved.manifest.name,
				packageId: resolved.pkg.packageId,
				publisher: resolved.pkg.publisher,
				source: resolved.pkg.source,
				status: installation.status,
				scope: installation.scope,
				scopeId: installation.scopeId,
				version: resolved.pkg.version,
			}),
		);
	}
	return out;
}

export function createSimpleSkillsApi(
	store: SkillsStore | undefined,
	options: SkillsApiOptions = {},
): SimpleSkillsApi {
	const resolvedStore = () => requireSkillsStore(store);
	return {
		async catalog(input) {
			const catalog = assertSkillCatalogInput(input);
			const staticEntries =
				catalog.includeStatic === false
					? []
					: (options.staticSkills ?? []).map(staticCatalogEntry);
			return [
				...staticEntries,
				...(await installedCatalogEntries({ catalog, store })),
			];
		},
		async read(input) {
			const read = assertReadSkillInput(input);
			if (read.id !== undefined) {
				const staticManifest = options.staticSkills?.find(
					(skill) => skill.id === read.id,
				);
				if (staticManifest) {
					let record: SkillReadRecord | undefined;
					if (store && options.readContext) {
						const readContext = await resolveReadSkillContext({
							read,
							resolver: options.readContext,
						});
						record = await createReadRecord({
							read,
							readBy: readContext.readBy,
							skillId: staticManifest.id,
							store,
						});
					}
					return assertReadSkillResult({
						id: staticManifest.id,
						kind: "static",
						manifest: staticManifest,
						read: record,
					});
				}
			}
			const readContext = await resolveReadSkillContext({
				read,
				resolver: options.readContext,
			});
			return readInstalledSkillById({
				read,
				readContext,
				store: resolvedStore(),
			});
		},
		async createPersonal(input) {
			const valid = assertCreatePersonalSkillInput(input);
			const pkg = await resolvedStore().packages.create({
				digest: valid.digest,
				manifest: valid.manifest,
				packageId: valid.packageId,
				publisher: valid.createdBy,
				source: valid.source ?? "local",
				version: valid.version,
			});
			// The store defaults the boundary to personal:createdBy — exactly what "personal" means.
			const installation = await resolvedStore().installations.create({
				createdBy: valid.createdBy,
				digest: pkg.digest,
				enabledBy: valid.createdBy,
				packageId: pkg.packageId,
				status: "enabled",
				version: pkg.version,
			});
			const grant = await resolvedStore().acl.grant({
				installationId: installation.id,
				permission: "activate",
				principalId: valid.createdBy,
				principalType: "actor",
			});
			const readGrant = await resolvedStore().acl.grant({
				installationId: installation.id,
				permission: "read",
				principalId: valid.createdBy,
				principalType: "actor",
			});
			return assertCreatePersonalSkillResult({
				grant,
				installation,
				package: pkg,
				readGrant,
			});
		},
		async activate(input) {
			const valid = assertActivateSkillInput(input);
			const activationContext = await resolveActivateSkillContext({
				activation: valid,
				resolver: options.activationContext,
			});
			const { installation, manifest } = await assertActivatableInstallation({
				activationContext,
				activation: valid,
				store: resolvedStore(),
			});
			return resolvedStore().activations.create({
				activatedBy: activationContext.activatedBy,
				clawId: valid.clawId,
				digest: installation.digest,
				installationId: installation.id,
				runId: valid.runId,
				skillId: manifest.id,
				source: valid.source ?? "user",
				threadId: valid.threadId,
			});
		},
	};
}
