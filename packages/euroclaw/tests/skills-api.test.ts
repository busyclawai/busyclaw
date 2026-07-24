import { govern } from "@euroclaw/contracts";
import { governedSkillsPlugin, skillsPlugin } from "@euroclaw/skills";
import { describe, expect, it } from "vitest";
import { createClaw, getEuroclawTables } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	owned,
	textModel,
} from "./fixtures";

const summarizeSkill = {
	id: "summarize-thread",
	description: "Summarize a thread",
	allowedTools: ["summarize"],
} as const;

describe("createClaw plugin APIs", () => {
	it("exposes skills plugin API namespaces on claw.api", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
			plugins: [
				governedSkillsPlugin({
					activationContext: {
						activatedBy: "user:actor-1",
						teamId: "team-1",
						organizationId: "organization-1",
					},
					active: [summarizeSkill.id],
					skills: [summarizeSkill],
				}),
			],
		});

		const pkg = await claw.api.skills.packages.create({
			packageId: "builtin.summarize-thread",
			version: "1.0.0",
			digest: "sha256:abc",
			manifest: summarizeSkill,
			source: "builtin",
		});
		expect(await claw.api.skills.packages.get({ id: pkg.id })).toMatchObject({
			digest: "sha256:abc",
		});

		const installation = await claw.api.skills.installations.create({
			packageId: pkg.packageId,
			status: "enabled",
			version: pkg.version,
			digest: pkg.digest,
			createdBy: "user:admin-1",
			scope: "team",
			scopeId: "team-1",
		});
		expect(
			await claw.api.skills.grantActivation({
				installationId: installation.id,
				principalType: "team",
				principalId: "team-1",
				grantedBy: "user:admin-1",
			}),
		).toMatchObject({ permission: "use" });
		expect(
			await claw.api.skills.activate({
				clawId: "claw-1",
				installationId: installation.id,
				source: "user",
			}),
		).toMatchObject({ skillId: summarizeSkill.id });
	});

	it("allows static-only skills without a SkillsStore", () => {
		const claw = owned({
			model: textModel("done"),
			plugins: [
				governedSkillsPlugin({
					active: [summarizeSkill.id],
					skills: [summarizeSkill],
				}),
			],
		});

		expect(claw.api.skills).toBeDefined();
	});

	it("rejects duplicate plugin API namespaces", () => {
		const plugin = (id: string) => ({
			id,
			$Api: {} as { skills: { marker: string } },
			api: () => ({ skills: { marker: id } }),
		});

		expect(() =>
			createClaw({
				model: textModel("done"),
				plugins: [plugin("a"), plugin("b")],
			}),
		).toThrow(/duplicate euroclaw plugin api namespace/);
	});

	it("resolves database-backed skill gates from createClaw database wiring", async () => {
		let toolSaw = "";
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			organization: () => "organization-1",
			plugins: [
				governedSkillsPlugin({
					activationContext: {
						activatedBy: "user:actor-1",
						organizationId: "organization-1",
					},
					skills: [],
				}),
			],
			tools: {
				send_email: govern(
					emailTool({
						onExecute: (to) => {
							toolSaw = to;
							return { sent: true };
						},
					}),
					{ gate: () => ({ decision: "permit" }) },
				),
			},
		});
		await claw.api.createClaw({
			id: "claw-1",
			createdBy: "user:actor-1",
		});
		await claw.api.createThread({
			id: "thread-1",
			clawId: "claw-1",
		});

		const pkg = await claw.api.skills.packages.create({
			id: "pkg-email",
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
		const installation = await claw.api.skills.installations.create({
			id: "install-email",
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			createdBy: "user:admin-1",
			scope: "organization",
			scopeId: "organization-1",
			status: "enabled",
		});
		await claw.api.skills.grantActivation({
			installationId: "install-email",
			principalType: "organization",
			principalId: "organization-1",
			grantedBy: "user:admin-1",
		});
		await claw.api.skills.activate({
			clawId: "claw-1",
			installationId: installation.id,
			runId: "run-skill",
			threadId: "thread-1",
		});

		await expect(
			claw.api.sendMessage({
				clawId: "claw-1",
				message: "email alice@personal.com",
				runId: "run-skill",
				threadId: "thread-1",
			}),
		).resolves.toMatchObject({ result: { status: "completed" } });
		expect(toolSaw).toBe("alice@personal.com");
	});

	it("collects the skills plugin's owned tables through getEuroclawTables", () => {
		const tables = getEuroclawTables({
			plugins: [skillsPlugin({ skills: [] })],
		});
		for (const model of [
			"skill_package",
			"skill_installation",
			"skill_activation",
			"skill_read",
			"skill_proposal",
		]) {
			expect(tables[model]).toBeDefined();
		}
		// a persisted skills column survives the round-trip through the plugin's declaration
		expect(tables.skill_installation?.fields.scope).toBeDefined();
		// core tables are still intact alongside the plugin's — incl. the generic access_grant ACL
		// the skills grants now live in (retired skill_acl is gone; access_grant is a CORE table).
		expect(tables.claw).toBeDefined();
		expect(tables.access_grant).toBeDefined();
		expect(tables.skill_acl).toBeUndefined();
	});
});
