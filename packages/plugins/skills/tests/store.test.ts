import { entityAdapter, memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { skillsModels } from "../src/core/index";
import { createSkillsStore } from "../src/store/store";

// Stores take the schema-aware adapter the assembly provides; tests wrap manually.
const db = () => entityAdapter(memoryAdapter(), skillsModels);

const manifest = {
	id: "summarize-thread",
	description: "Summarize a thread",
	allowedTools: ["summarize"],
};

describe("createSkillsStore", () => {
	it("stores packages, installations, acl, activations, reads, and proposals", async () => {
		const store = createSkillsStore(db(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		const pkg = await store.packages.create({
			id: "pkg-1",
			packageId: "builtin.summarize-thread",
			version: "1.0.0",
			digest: "sha256:abc",
			manifest,
			source: "builtin",
		});
		expect(pkg).toMatchObject({
			createdAt: "2026-01-01T00:00:00.000Z",
			digest: "sha256:abc",
		});
		expect(await store.packages.getByDigest("sha256:abc")).toMatchObject({
			id: "pkg-1",
		});

		const installation = await store.installations.create({
			id: "install-1",
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			createdBy: "actor-1",
			scope: "team",
			scopeId: "team-1",
		});
		expect(installation).toMatchObject({
			status: "installed",
			createdBy: "actor-1",
			scope: "team",
			scopeId: "team-1",
		});
		expect(
			await store.installations.updateStatus("install-1", {
				status: "trusted",
				trustedBy: "admin-1",
			}),
		).toMatchObject({ status: "trusted", trustedBy: "admin-1" });
		expect(
			await store.installations.listForScope({
				status: "trusted",
				scope: "team",
				scopeId: "team-1",
			}),
		).toHaveLength(1);

		const acl = await store.acl.grant({
			id: "acl-1",
			installationId: "install-1",
			principalType: "team",
			principalId: "team-1",
			permission: "activate",
		});
		expect(acl).toMatchObject({ permission: "activate" });
		expect(
			await store.acl.listForPrincipal({
				permission: "activate",
				principalId: "team-1",
				principalType: "team",
			}),
		).toMatchObject([{ id: "acl-1" }]);

		const activation = await store.activations.create({
			id: "activation-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			installationId: "install-1",
			skillId: manifest.id,
			digest: pkg.digest,
			activatedBy: "actor-1",
			source: "user",
		});
		expect(activation).toMatchObject({ skillId: "summarize-thread" });
		expect(await store.activations.listForRun("run-1")).toMatchObject([
			{ id: "activation-1" },
		]);

		const read = await store.reads.create({
			id: "read-1",
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-1",
			installationId: "install-1",
			skillId: manifest.id,
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			readBy: "actor-1",
			source: "user",
		});
		expect(read).toMatchObject({ skillId: "summarize-thread" });
		expect(await store.reads.listForRun("run-1")).toMatchObject([
			{ id: "read-1" },
		]);
		expect(await store.reads.listForThread("thread-1")).toMatchObject([
			{ id: "read-1" },
		]);

		const proposal = await store.proposals.create({
			id: "proposal-1",
			scope: "team",
			scopeId: "team-1",
			targetInstallationId: "install-1",
			proposerActorId: "actor-1",
			kind: "patch",
			state: { manifestPatch: { allowedTools: ["summarize"] } },
		});
		expect(proposal).toMatchObject({ status: "pending" });
		expect(
			await store.proposals.listForScope({ scope: "team", scopeId: "team-1" }),
		).toMatchObject([{ id: "proposal-1" }]);
		expect(
			await store.proposals.updateStatus("proposal-1", {
				status: "approved",
			}),
		).toMatchObject({ status: "approved" });
	});

	it("rejects malformed package manifests", async () => {
		const store = createSkillsStore(db());

		await expect(
			store.packages.create({
				packageId: "bad",
				version: "1.0.0",
				digest: "sha256:bad",
				// Invalid id (uppercase/space) — rejected by the schema-first manifest column, which
				// validates the manifest as part of the create-input boundary (no separate re-parse).
				manifest: { id: "Bad Id", description: "Bad" },
				source: "upload",
			}),
		).rejects.toThrow(/create skill package input invalid/);
	});
});
