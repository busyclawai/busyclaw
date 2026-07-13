import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createRegistryStores } from "../src/registry";

const stamps = () => {
	let n = 0;
	return () => `2026-01-01T00:00:0${n++}Z`;
};

describe("createRegistryStores — authz_change (append-only log)", () => {
	it("append stamps id + at and round-trips the summary", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		const record = await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			summary: { slice: "reads-only" },
			by: "user:admin",
		});
		expect(record.id).toMatch(/^[0-9a-f]{32}$/);
		expect(record.at).toBe("2026-01-01T00:00:00Z");
		const listed = await authzChanges.listByOrganization("org-a");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			kind: "policy_changed",
			summary: { slice: "reads-only" },
			by: "user:admin",
		});
	});

	it("append works without a summary (optional)", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		const record = await authzChanges.append({
			organizationId: "org-a",
			kind: "spec_registered",
			by: "user:alice",
		});
		expect(record.summary).toBeUndefined();
	});

	it("count reflects appends and only grows (monotonic)", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		expect(await authzChanges.count("org-a")).toBe(0); // no changes yet → the shared bundle
		await authzChanges.append({
			organizationId: "org-a",
			kind: "overlay_changed",
			by: "user:admin",
		});
		expect(await authzChanges.count("org-a")).toBe(1);
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			by: "user:admin",
		});
		expect(await authzChanges.count("org-a")).toBe(2);
	});

	it("count is scoped by org — org A's appends never change org B's count", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			by: "user:admin",
		});
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			by: "user:admin",
		});
		expect(await authzChanges.count("org-a")).toBe(2);
		expect(await authzChanges.count("org-b")).toBe(0);
	});

	it("listByOrganization returns the history oldest-first, scoped by org", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		await authzChanges.append({
			organizationId: "org-a",
			kind: "spec_registered",
			summary: { source: "petstore" },
			by: "user:alice",
		});
		await authzChanges.append({
			organizationId: "org-b",
			kind: "policy_changed",
			by: "user:bob",
		});
		await authzChanges.append({
			organizationId: "org-a",
			kind: "policy_changed",
			summary: { slice: "guard" },
			by: "user:alice",
		});
		const a = await authzChanges.listByOrganization("org-a");
		expect(a.map((c) => c.kind)).toEqual(["spec_registered", "policy_changed"]);
		expect(a.every((c) => c.organizationId === "org-a")).toBe(true);
	});

	it("rejects a malformed stored change row (out-of-enum kind)", async () => {
		const adapter = memoryAdapter();
		const { authzChanges } = createRegistryStores(adapter);
		await adapter.create({
			model: "authz_change",
			data: {
				id: "bad",
				organizationId: "org-bad",
				kind: "mystery", // not a known change kind
				at: "t",
				by: "user:a",
			},
		});
		await expect(authzChanges.listByOrganization("org-bad")).rejects.toThrow(
			"authz_change record invalid",
		);
	});
});

const slice = (organizationId: string, name: string) => ({
	organizationId,
	name,
	cedar: `forbid(principal, action == Action::"x", resource);`,
	mode: "enforce" as const,
	updatedBy: "user:admin",
});

const overlay = (organizationId: string, actionId: string) => ({
	organizationId,
	actionId,
	access: "read" as const,
	updatedBy: "user:admin",
});

describe("authz changes are appended on every mutation", () => {
	it("a policy-slice upsert appends policy_changed and bumps the count", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.upsert(slice("org-a", "guard"));
		expect(await authzChanges.count("org-a")).toBe(1);
		const [change] = await authzChanges.listByOrganization("org-a");
		expect(change).toMatchObject({
			kind: "policy_changed",
			summary: { slice: "guard" },
			by: "user:admin",
		});
	});

	it("editing a slice (upsert same name) appends again — every edit bumps the count", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.upsert(slice("org-a", "guard"));
		await policySlices.upsert(slice("org-a", "guard")); // an edit — a replace, still a change
		expect(await authzChanges.count("org-a")).toBe(2);
	});

	it("a policy-slice delete APPENDS (never removes log rows) — the count bumps", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		const created = await policySlices.upsert(slice("org-a", "guard"));
		await policySlices.delete(created.organizationId, created.id);
		expect(await authzChanges.count("org-a")).toBe(2); // upsert + delete = 2 events
		const kinds = (await authzChanges.listByOrganization("org-a")).map(
			(c) => c.kind,
		);
		expect(kinds).toEqual(["policy_changed", "policy_changed"]);
	});

	it("deleting the OLDER of two slices still bumps the count — the case max(updatedAt) misses", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
			{
				now: stamps(),
			},
		);
		const a = await policySlices.upsert(slice("org-a", "a")); // older row
		await policySlices.upsert(slice("org-a", "b")); // newer row — holds the MAX updatedAt
		expect(await authzChanges.count("org-a")).toBe(2);
		await policySlices.delete(a.organizationId, a.id); // delete the NON-newest row
		// max(updatedAt) is unchanged (b is still newest) → a stale key; append-only count bumps:
		expect(await authzChanges.count("org-a")).toBe(3);
	});

	it("a no-op delete (row already gone) does NOT append", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.delete("org-a", "does-not-exist");
		expect(await authzChanges.count("org-a")).toBe(0);
	});

	it("a facts-overlay upsert and delete each append overlay_changed", async () => {
		const { factsOverlay, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		const created = await factsOverlay.upsert(
			overlay("org-a", "petstore.getPet"),
		);
		expect(await authzChanges.count("org-a")).toBe(1);
		await factsOverlay.deleteById(created.id);
		expect(await authzChanges.count("org-a")).toBe(2);
		const kinds = (await authzChanges.listByOrganization("org-a")).map(
			(c) => c.kind,
		);
		expect(kinds).toEqual(["overlay_changed", "overlay_changed"]);
	});

	it("appends are org-scoped — org A's mutations never change org B's count", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.upsert(slice("org-a", "guard"));
		expect(await authzChanges.count("org-b")).toBe(0);
	});
});
