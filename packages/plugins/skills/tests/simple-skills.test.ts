import {
	PRINCIPAL_CONTEXT_KEY,
	CLAW_ID_CONTEXT_KEY,
	ORGANIZATION_CONTEXT_KEY,
	RUN_ID_CONTEXT_KEY,
	TEAM_CONTEXT_KEY,
	THREAD_ID_CONTEXT_KEY,
} from "@euroclaw/contracts";
import { createGovernance, createMemoryAudit } from "@euroclaw/core";
import { entityAdapter, memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { skillsModels } from "../src/core/index";
import {
	assertSkillManifest,
	createSimpleSkillsApi,
	createSkillsStore,
	defineSkill,
	RESERVED_TOOL_PREFIX,
	skillManifestLimits,
	skillsPlugin,
} from "../src/index";

// Stores take the schema-aware adapter the assembly provides; tests wrap manually.
const db = () => entityAdapter(memoryAdapter(), skillsModels);

describe("@euroclaw/skills (simple)", () => {
	it("rejects unsafe manifest ids", () => {
		expect(() =>
			defineSkill({
				id: "Email Only",
				description: "Email only",
				allowedTools: ["send_email"],
			}),
		).toThrow(/id must be matched by/);
	});

	it("rejects duplicate allowed tools", () => {
		expect(() =>
			defineSkill({
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email", "send_email"],
			}),
		).toThrow(/allowedTools must be no duplicate/);
	});

	it("rejects oversized manifest text and tool lists", () => {
		expect(() =>
			defineSkill({
				id: "email-only",
				description: "x".repeat(skillManifestLimits.maxDescriptionLength + 1),
				allowedTools: ["send_email"],
			}),
		).toThrow(/description must be at most length/);

		expect(() =>
			defineSkill({
				id: "email-only",
				description: "Email only",
				allowedTools: Array.from(
					{ length: skillManifestLimits.maxAllowedTools + 1 },
					(_, index) => `tool_${index}`,
				),
			}),
		).toThrow(/allowedTools must be at most/);
	});

	it("rejects fields outside the v2 manifest surface", () => {
		expect(() =>
			defineSkill({
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
				// `instructions` is no longer a manifest field — it lives in the skill body.
				instructions: "Use the approved template.",
			} as never),
		).toThrow(/instructions must be removed/);
	});

	it("rejects unknown manifest fields", () => {
		expect(() =>
			assertSkillManifest({
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
				secretOverride: "anything",
			}),
		).toThrow(/secretOverride must be removed/);
	});

	it("rejects reserved-namespace tool names in allowedTools", () => {
		expect(() =>
			defineSkill({
				id: "email-only",
				description: "Email only",
				allowedTools: [`${RESERVED_TOOL_PREFIX}skill_activate`],
			}),
		).toThrow(/reserved tool name/);
	});

	it("returns compact static catalog entries without instructions", async () => {
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			name: "Email Only",
			allowedTools: ["send_email"],
		});
		const api = createSimpleSkillsApi(undefined, { staticSkills: [skill] });

		await expect(api.catalog()).resolves.toEqual([
			expect.objectContaining({
				allowedTools: ["send_email"],
				description: "Email only",
				id: "email-only",
				kind: "static",
				name: "Email Only",
			}),
		]);
		const [entry] = await api.catalog();
		expect("instructions" in entry).toBe(false);
	});

	it("reads a static skill manifest through the simple read API", async () => {
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const api = createSimpleSkillsApi(undefined, { staticSkills: [skill] });

		await expect(api.read({ id: "email-only" })).resolves.toMatchObject({
			id: "email-only",
			kind: "static",
			manifest: {
				description: "Email only",
			},
		});
	});

	it("creates and reads private personal skills through read ACL", async () => {
		// No organization anywhere: a personal skill is created and read org-free (org is additive).
		const api = createSimpleSkillsApi(createSkillsStore(db()), {
			readContext: {
				readBy: "actor-1",
			},
		});
		const personal = await api.createPersonal({
			createdBy: "actor-1",
			digest: "sha256:read-personal",
			manifest: {
				id: "read-personal",
				description: "Read personal",
				allowedTools: ["send_email"],
			},
			packageId: "actor-1.read-personal",
			version: "1.0.0",
		});
		expect(personal.installation).toMatchObject({
			createdBy: "actor-1",
			enabledBy: "actor-1",
			scope: "personal",
			scopeId: "actor-1",
			status: "enabled",
		});
		expect(personal.grant).toMatchObject({
			permission: "activate",
			principalId: "actor-1",
			principalType: "actor",
		});
		expect(personal.readGrant).toMatchObject({ permission: "read" });

		const read = await api.read({
			clawId: "claw-1",
			installationId: personal.installation.id,
			runId: "run-1",
			source: "user",
			threadId: "thread-1",
		});
		expect(read).toMatchObject({
			id: "read-personal",
			installation: { id: personal.installation.id, status: "enabled" },
			kind: "installed",
			manifest: { description: "Read personal" },
			read: {
				clawId: "claw-1",
				readBy: "actor-1",
				runId: "run-1",
				skillId: "read-personal",
				source: "user",
				threadId: "thread-1",
			},
		});
	});

	it("activates personal skills through the simple API", async () => {
		const store = createSkillsStore(db(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		// An org-less activation context: personal skills need no organization at all.
		const api = createSimpleSkillsApi(store, {
			activationContext: {
				activatedBy: "actor-1",
			},
		});
		const personal = await api.createPersonal({
			createdBy: "actor-1",
			digest: "sha256:activate",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			packageId: "actor-1.email-only",
			version: "1.0.0",
		});

		expect(
			await api.activate({
				clawId: "claw-1",
				installationId: personal.installation.id,
				runId: "run-1",
			}),
		).toMatchObject({
			digest: personal.package.digest,
			runId: "run-1",
			skillId: "email-only",
		});
	});

	it("does not authorize activation from caller-supplied principal fields", async () => {
		const api = createSimpleSkillsApi(createSkillsStore(db()), {
			activationContext: {
				activatedBy: "actor-1",
			},
		});
		const personal = await api.createPersonal({
			createdBy: "actor-2",
			digest: "sha256:spoof",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			packageId: "actor-2.email-only",
			version: "1.0.0",
		});

		// The caller claims to be actor-2 in the INPUT; the trusted context says actor-1, who cannot
		// stand inside personal:actor-2 — out-of-boundary reads as "not found" (existence-hiding).
		await expect(
			api.activate({
				activatedBy: "actor-2",
				clawId: "claw-1",
				installationId: personal.installation.id,
			} as never),
		).rejects.toThrow(/installation not found/);
	});

	it("requires trusted activation context", async () => {
		const api = createSimpleSkillsApi(createSkillsStore(db()));

		await expect(
			api.activate({
				clawId: "claw-1",
				installationId: "install-1",
			}),
		).rejects.toThrow(/requires activationContext/);
	});

	it("constructs plugin API without a store for static-only skills", () => {
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const plugin = skillsPlugin({ active: ["email-only"], skills: [skill] });

		// The api is the RUNTIME half now — configure (no adapter ⇒ static-only) yields it.
		const runtime = plugin.configure?.({});
		expect(runtime?.api?.({}).skills).toBeDefined();
	});

	it("permits tools declared by active skills", async () => {
		let ran = false;
		const sendCandidateEmail = defineSkill({
			id: "send-candidate-email",
			description: "Send a candidate email",
			allowedTools: ["send_email"],
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					enforceAllowedTools: true,
					skills: [sendCandidateEmail],
					active: ["send-candidate-email"],
				}),
			],
			resolveContext: (ctx) => ({
				...ctx,
				[ORGANIZATION_CONTEXT_KEY]: "organization-1",
			}),
			runTool: () => {
				ran = true;
				return { ok: true };
			},
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toEqual({ status: "ok", output: { ok: true } });
		expect(ran).toBe(true);
	});

	it("denies tools not declared by active skills", async () => {
		let ran = false;
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					skills: [skill],
					active: ["email-only"],
					enforceAllowedTools: true,
				}),
			],
			runTool: () => {
				ran = true;
				return { ok: true };
			},
		});

		await expect(
			ec.handleToolCall({ name: "shell_exec", args: {} }),
		).resolves.toMatchObject({
			gateId: "skills:allowed-tools",
			reasonCode: "SKILL_TOOL_NOT_ALLOWED",
			status: "denied",
		});
		expect(ran).toBe(false);
	});

	it("fails closed when no skill is active", async () => {
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const ec = createGovernance({
			plugins: [skillsPlugin({ skills: [skill], enforceAllowedTools: true })],
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({
			reasonCode: "NO_ACTIVE_SKILL",
			status: "denied",
		});
	});

	it("is additive by default — installing skills does not gate tools", async () => {
		let ran = false;
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		// No enforceAllowedTools: the plugin is installed but contributes no tool gate, so a tool
		// runs even with no active skill — authorization is the policy engine's job.
		const ec = createGovernance({
			plugins: [skillsPlugin({ skills: [skill] })],
			runTool: () => {
				ran = true;
				return { ok: true };
			},
		});

		await expect(
			ec.handleToolCall({ name: "anything", args: {} }),
		).resolves.toEqual({ status: "ok", output: { ok: true } });
		expect(ran).toBe(true);
	});

	it("contributes no gate unless enforceAllowedTools is set", () => {
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		expect(skillsPlugin({ skills: [skill] }).gates).toEqual([]);
		expect(
			skillsPlugin({ skills: [skill], enforceAllowedTools: true }).gates,
		).toHaveLength(1);
	});

	it("supports active skill resolution from trusted context", async () => {
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					enforceAllowedTools: true,
					skills: [skill],
					active: (ctx) =>
						ctx.activateEmailSkill === true ? ["email-only"] : undefined,
				}),
			],
		});

		await expect(
			ec.handleToolCall(
				{ name: "send_email", args: {} },
				{ activateEmailSkill: true },
			),
		).resolves.toMatchObject({ status: "ok" });
		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({
			reasonCode: "NO_ACTIVE_SKILL",
			status: "denied",
		});
	});

	it("permits tools from enabled database-backed skill installations", async () => {
		let ran = false;
		const store = createSkillsStore(db(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const pkg = await store.packages.create({
			id: "pkg-organization-email",
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:email",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await store.installations.create({
			id: "install-email",
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			createdBy: "admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "enabled",
		});
		await store.acl.grant({
			installationId: installation.id,
			permission: "activate",
			principalId: "organization-1",
			principalType: "organization",
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					enforceAllowedTools: true,
					active: [{ installationId: installation.id }],
					skills: [],
					store,
				}),
			],
			resolveContext: (ctx) => ({
				...ctx,
				[ORGANIZATION_CONTEXT_KEY]: "organization-1",
			}),
			runTool: () => {
				ran = true;
				return { ok: true };
			},
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toEqual({ status: "ok", output: { ok: true } });
		expect(ran).toBe(true);
	});

	it("permits database-backed skills through actor, team, organization, and public ACL grants", async () => {
		for (const principalType of [
			"actor",
			"team",
			"organization",
			"public",
		] as const) {
			const store = createSkillsStore(db());
			const pkg = await store.packages.create({
				packageId: `team.${principalType}.email-only`,
				version: "1.0.0",
				digest: `sha256:${principalType}`,
				manifest: {
					id: "email-only",
					description: "Email only",
					allowedTools: ["send_email"],
				},
				source: "upload",
			});
			const installation = await store.installations.create({
				id: `install-${principalType}`,
				packageId: pkg.packageId,
				version: pkg.version,
				digest: pkg.digest,
				createdBy: "admin-1",
				scope: "organization",
				scopeId: "organization-1",
				status: "enabled",
			});
			await store.acl.grant({
				installationId: installation.id,
				permission: "activate",
				...(principalType === "actor" ? { principalId: "actor-1" } : {}),
				...(principalType === "team" ? { principalId: "team-1" } : {}),
				...(principalType === "organization"
					? { principalId: "organization-1" }
					: {}),
				principalType,
			});
			const ec = createGovernance({
				plugins: [
					skillsPlugin({
						enforceAllowedTools: true,
						active: [{ installationId: installation.id }],
						skills: [],
						store,
					}),
				],
				resolveContext: (ctx) => ({
					...ctx,
					[PRINCIPAL_CONTEXT_KEY]: "actor-1",
					[TEAM_CONTEXT_KEY]: "team-1",
					[ORGANIZATION_CONTEXT_KEY]: "organization-1",
				}),
			});

			await expect(
				ec.handleToolCall({ name: "send_email", args: {} }),
			).resolves.toMatchObject({ status: "ok" });
		}
	});

	it("uses recorded run activations when active selection is omitted", async () => {
		let ran = false;
		const store = createSkillsStore(db());
		const foreignPkg = await store.packages.create({
			packageId: "team.foreign-email",
			version: "1.0.0",
			digest: "sha256:foreign-recorded",
			manifest: {
				id: "foreign-email",
				description: "Foreign email",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const foreignInstallation = await store.installations.create({
			id: "install-foreign-recorded",
			packageId: foreignPkg.packageId,
			version: foreignPkg.version,
			digest: foreignPkg.digest,
			createdBy: "admin-2",
			scope: "organization",
			scopeId: "organization-2",
			status: "enabled",
		});
		const unscopedPkg = await store.packages.create({
			packageId: "team.unscoped-email",
			version: "1.0.0",
			digest: "sha256:unscoped-recorded",
			manifest: {
				id: "unscoped-email",
				description: "Unscoped email",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const unscopedInstallation = await store.installations.create({
			id: "install-unscoped-recorded",
			packageId: unscopedPkg.packageId,
			version: unscopedPkg.version,
			digest: unscopedPkg.digest,
			createdBy: "admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "enabled",
		});
		const pkg = await store.packages.create({
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:recorded",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await store.installations.create({
			id: "install-recorded",
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			createdBy: "admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "enabled",
		});
		await store.acl.grant({
			installationId: installation.id,
			permission: "activate",
			principalId: "organization-1",
			principalType: "organization",
		});
		await store.activations.create({
			activatedBy: "actor-2",
			clawId: "claw-2",
			digest: foreignPkg.digest,
			installationId: foreignInstallation.id,
			runId: "run-1",
			skillId: "foreign-email",
			source: "user",
			threadId: "thread-2",
		});
		await store.activations.create({
			activatedBy: "actor-1",
			clawId: "claw-1",
			digest: unscopedPkg.digest,
			installationId: unscopedInstallation.id,
			runId: "run-1",
			skillId: "unscoped-email",
			source: "user",
		});
		await store.activations.create({
			activatedBy: "actor-1",
			clawId: "claw-1",
			digest: pkg.digest,
			installationId: installation.id,
			runId: "run-1",
			skillId: "email-only",
			source: "user",
			threadId: "thread-1",
		});
		const ec = createGovernance({
			plugins: [skillsPlugin({ skills: [], store, enforceAllowedTools: true })],
			resolveContext: (ctx) => ({
				...ctx,
				[CLAW_ID_CONTEXT_KEY]: "claw-1",
				[RUN_ID_CONTEXT_KEY]: "run-1",
				[ORGANIZATION_CONTEXT_KEY]: "organization-1",
				[THREAD_ID_CONTEXT_KEY]: "thread-1",
			}),
			runTool: () => {
				ran = true;
				return { ok: true };
			},
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toEqual({ status: "ok", output: { ok: true } });
		expect(ran).toBe(true);
	});

	it("resolves bare skill ids past unauthorized matching installations", async () => {
		const store = createSkillsStore(db());
		const firstPkg = await store.packages.create({
			packageId: "team.first-email",
			version: "1.0.0",
			digest: "sha256:first-email",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		await store.installations.create({
			id: "install-first-email",
			packageId: firstPkg.packageId,
			version: firstPkg.version,
			digest: firstPkg.digest,
			createdBy: "admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "enabled",
		});
		const secondPkg = await store.packages.create({
			packageId: "team.second-email",
			version: "1.0.0",
			digest: "sha256:second-email",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const secondInstallation = await store.installations.create({
			id: "install-second-email",
			packageId: secondPkg.packageId,
			version: secondPkg.version,
			digest: secondPkg.digest,
			createdBy: "admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "enabled",
		});
		await store.acl.grant({
			installationId: secondInstallation.id,
			permission: "activate",
			principalId: "organization-1",
			principalType: "organization",
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					enforceAllowedTools: true,
					active: ["email-only"],
					skills: [],
					store,
				}),
			],
			resolveContext: (ctx) => ({
				...ctx,
				[ORGANIZATION_CONTEXT_KEY]: "organization-1",
			}),
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({ status: "ok" });
	});

	it("denies database-backed skills without an activate ACL grant", async () => {
		const store = createSkillsStore(db());
		const pkg = await store.packages.create({
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:no-acl",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await store.installations.create({
			id: "install-no-acl",
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			createdBy: "admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "enabled",
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					enforceAllowedTools: true,
					active: [{ installationId: installation.id }],
					skills: [],
					store,
				}),
			],
			resolveContext: (ctx) => ({
				...ctx,
				[ORGANIZATION_CONTEXT_KEY]: "organization-1",
			}),
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({
			reasonCode: "ACTIVE_SKILL_FORBIDDEN",
			status: "denied",
		});
	});

	it("denies scope-pinned refs outside the caller's boundaries", async () => {
		const store = createSkillsStore(db());
		// The ref pins organization:organization-1, but the context carries no organization fact —
		// it cannot stand inside that boundary.
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					enforceAllowedTools: true,
					active: [
						{
							skillId: "email-only",
							scope: "organization",
							scopeId: "organization-1",
						},
					],
					skills: [],
					store,
				}),
			],
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({
			reasonCode: "ACTIVE_SKILL_OUT_OF_SCOPE",
			status: "denied",
		});
	});

	it("denies untrusted database-backed skill installations", async () => {
		const store = createSkillsStore(db());
		const pkg = await store.packages.create({
			id: "pkg-untrusted",
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:untrusted",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await store.installations.create({
			id: "install-untrusted",
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			createdBy: "admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "installed",
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					enforceAllowedTools: true,
					active: [{ installationId: installation.id }],
					skills: [],
					store,
				}),
			],
			resolveContext: (ctx) => ({
				...ctx,
				[ORGANIZATION_CONTEXT_KEY]: "organization-1",
			}),
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({
			reasonCode: "ACTIVE_SKILL_UNAVAILABLE",
			status: "denied",
		});
	});

	it("denies unknown active skills", async () => {
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const ec = createGovernance({
			plugins: [
				skillsPlugin({
					skills: [skill],
					active: ["missing"],
					enforceAllowedTools: true,
				}),
			],
		});

		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({
			reasonCode: "UNKNOWN_ACTIVE_SKILL",
			status: "denied",
		});
	});

	it("rejects duplicate skill ids", () => {
		const first = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const second = defineSkill({
			id: "email-only",
			description: "Duplicate",
			allowedTools: ["other"],
		});

		expect(() =>
			skillsPlugin({ skills: [first, second], active: "all" }),
		).toThrow(/duplicate skill id/);
	});

	it("exempts reserved-namespace meta-tools from the allowed-tools gate", async () => {
		let ran = "";
		const skill = defineSkill({
			id: "email-only",
			description: "Email only",
			allowedTools: ["send_email"],
		});
		const ec = createGovernance({
			plugins: [skillsPlugin({ skills: [skill], enforceAllowedTools: true })],
			runTool: (call) => {
				ran = call.name;
				return { ok: true };
			},
		});

		// A normal tool is denied: no skill is active.
		await expect(
			ec.handleToolCall({ name: "send_email", args: {} }),
		).resolves.toMatchObject({
			reasonCode: "NO_ACTIVE_SKILL",
			status: "denied",
		});
		expect(ran).toBe("");

		// A reserved-namespace meta-tool is NOT subject to the allowed-tools gate.
		const metaTool = `${RESERVED_TOOL_PREFIX}skill_catalog`;
		await expect(
			ec.handleToolCall({ name: metaTool, args: {} }),
		).resolves.toMatchObject({ status: "ok" });
		expect(ran).toBe(metaTool);
	});

	it("still audits reserved-namespace meta-tools the gate exempted", async () => {
		const audit = createMemoryAudit();
		const ec = createGovernance({
			plugins: [skillsPlugin({ skills: [], enforceAllowedTools: true })],
			audit,
			runTool: () => ({ ok: true }),
		});

		await ec.handleToolCall({
			name: `${RESERVED_TOOL_PREFIX}skill_catalog`,
			args: {},
		});

		// Exemption is only from the allowed-tools before-gate; audit (a sealed after-gate)
		// still records the call.
		expect(audit.entries()).toHaveLength(1);
	});
});
