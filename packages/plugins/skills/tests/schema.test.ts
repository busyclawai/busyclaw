import { type } from "arktype";
import { describe, expect, it } from "vitest";
import {
	skillManifest,
	skillPackageRecord,
	skillsSchema,
} from "../src/core/index";

describe("euroclaw core skills", () => {
	it("validates manifest contracts", () => {
		const valid = skillManifest({
			id: "summarize-thread",
			description: "Summarize a thread",
			allowedTools: ["summarize"],
			pii: { reads: ["email"], writes: [] },
		});

		expect(valid).toMatchObject({
			allowedTools: ["summarize"],
			id: "summarize-thread",
		});
		// allowedTools is optional in v2 — a minimal manifest is valid.
		expect(
			skillManifest({ id: "minimal", description: "Minimal" }),
		).toMatchObject({ id: "minimal" });
		// An undeclared field is rejected (closed manifest surface).
		expect(
			skillManifest({
				id: "bad",
				description: "Invalid",
				instructions: "not a manifest field",
			}),
		).toBeInstanceOf(type.errors);
	});

	it("derives skill storage schemas from entity fields", () => {
		expect(skillsSchema.skill_package.fields.manifest).toMatchObject({
			pii: "redacted",
			required: true,
			type: "json",
		});
		expect(skillsSchema.skill_installation.fields.scope).toMatchObject({
			index: true,
			required: true,
			type: "string",
		});
		expect(skillsSchema.skill_installation.fields.createdBy).toMatchObject({
			index: true,
			required: true,
			type: "string",
		});
		// The bespoke skill_acl table is retired — grants live in the CORE access_grant table now, so
		// the plugin no longer contributes a skill_acl model to its own schema.
		expect(skillsSchema.skill_acl).toBeUndefined();
	});

	it("validates skill package records", () => {
		const record = skillPackageRecord({
			id: "pkg-1",
			packageId: "builtin.summarize-thread",
			version: "1.0.0",
			digest: "sha256:abc",
			manifest: {
				id: "summarize-thread",
				description: "Summarize a thread",
				allowedTools: ["summarize"],
			},
			source: "builtin",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(record).toMatchObject({
			digest: "sha256:abc",
			packageId: "builtin.summarize-thread",
		});
	});
});
