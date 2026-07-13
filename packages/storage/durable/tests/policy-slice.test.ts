import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createRegistryStores } from "../src/registry";

const sliceInput = (
	organizationId: string,
	name = "reads-only",
	mode: "enforce" | "shadow" | "off" = "enforce",
) => ({
	organizationId,
	name,
	cedar: `forbid(principal, action == Action::"petstore.removePet", resource);`,
	mode,
	updatedBy: "user:admin",
});

const stamps = () => {
	let n = 0;
	return () => `2026-01-01T00:00:0${n++}Z`;
};

describe("createRegistryStores — policy_slice", () => {
	it("round-trips a slice through storage", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter());
		const created = await policySlices.upsert(sliceInput("org-a"));
		expect(created.id).toMatch(/^[0-9a-f]{32}$/);
		const listed = await policySlices.listByOrganization("org-a");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			name: "reads-only",
			mode: "enforce",
			cedar: sliceInput("org-a").cedar,
			updatedBy: "user:admin",
		});
	});

	it("upsert REPLACES in place by (organizationId, name) — id + createdAt preserved", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		const first = await policySlices.upsert(sliceInput("org-a", "guard"));
		const second = await policySlices.upsert({
			...sliceInput("org-a", "guard"),
			cedar: `permit(principal, action, resource);`,
			mode: "shadow",
			updatedBy: "user:bob",
		});
		expect(second.id).toBe(first.id); // replace-in-place, not a new row
		expect(second.createdAt).toBe(first.createdAt); // createdAt preserved
		expect(second.updatedAt).not.toBe(first.updatedAt); // updatedAt bumped
		const listed = await policySlices.listByOrganization("org-a");
		expect(listed).toHaveLength(1); // one row per (org, name)
		expect(listed[0]?.mode).toBe("shadow");
		expect(listed[0]?.updatedBy).toBe("user:bob");
	});

	it("distinct names in one org coexist", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter());
		await policySlices.upsert(sliceInput("org-a", "a", "enforce"));
		await policySlices.upsert(sliceInput("org-a", "b", "shadow"));
		const listed = await policySlices.listByOrganization("org-a");
		expect(listed.map((s) => s.name).sort()).toEqual(["a", "b"]);
	});

	it("delete removes the row (org-scoped)", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter());
		const created = await policySlices.upsert(sliceInput("org-a"));
		// A wrong-org delete is a no-op — a caller cannot remove another org's slice by id.
		await policySlices.delete("org-b", created.id);
		expect(await policySlices.listByOrganization("org-a")).toHaveLength(1);
		await policySlices.delete("org-a", created.id);
		expect(await policySlices.listByOrganization("org-a")).toEqual([]);
	});

	it("lists are scoped by organizationId — org A's slices never leak into org B", async () => {
		const stores = createRegistryStores(memoryAdapter());
		await stores.policySlices.upsert(sliceInput("org-a"));
		await stores.policySlices.upsert(sliceInput("org-b"));
		const a = await stores.policySlices.listByOrganization("org-a");
		expect(a).toHaveLength(1);
		expect(a.every((s) => s.organizationId === "org-a")).toBe(true);
		const b = await stores.policySlices.listByOrganization("org-b");
		expect(b.every((s) => s.organizationId === "org-b")).toBe(true);
	});

	it("rejects a malformed stored slice row (required cedar missing)", async () => {
		const adapter = memoryAdapter();
		const { policySlices } = createRegistryStores(adapter);
		await adapter.create({
			model: "policy_slice",
			data: {
				id: "bad",
				organizationId: "org-bad",
				name: "x",
				mode: "enforce",
				updatedBy: "user:a",
				createdAt: "t",
				updatedAt: "t",
			},
		});
		await expect(policySlices.listByOrganization("org-bad")).rejects.toThrow(
			"policy_slice record invalid",
		);
	});

	it("rejects a stored slice with an out-of-enum mode", async () => {
		const adapter = memoryAdapter();
		const { policySlices } = createRegistryStores(adapter);
		await adapter.create({
			model: "policy_slice",
			data: {
				id: "bad",
				organizationId: "org-bad",
				name: "x",
				cedar: "permit(principal, action, resource);",
				mode: "sometimes", // not enforce|shadow|off
				updatedBy: "user:a",
				createdAt: "t",
				updatedAt: "t",
			},
		});
		await expect(policySlices.listByOrganization("org-bad")).rejects.toThrow(
			"policy_slice record invalid",
		);
	});
});
