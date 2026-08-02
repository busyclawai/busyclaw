import { userPrincipal } from "@busyclaw/contracts";
import { memoryAdapter } from "@busyclaw/storage-core";
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
			scope: "organization",
			scopeId: "org-a",
			kind: "policy_changed",
			summary: { slice: "reads-only" },
			by: userPrincipal("admin"),
		});
		expect(record.id).toMatch(/^[0-9a-f]{32}$/);
		expect(record.at).toBe("2026-01-01T00:00:00Z");
		const listed = await authzChanges.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			kind: "policy_changed",
			summary: { slice: "reads-only" },
			by: userPrincipal("admin"),
		});
	});

	it("append works without a summary (optional)", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		const record = await authzChanges.append({
			scope: "organization",
			scopeId: "org-a",
			kind: "spec_registered",
			by: userPrincipal("alice"),
		});
		expect(record.summary).toBeUndefined();
	});

	it("count reflects appends and only grows (monotonic)", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(0); // no changes yet → the shared bundle
		await authzChanges.append({
			scope: "organization",
			scopeId: "org-a",
			kind: "overlay_changed",
			by: userPrincipal("admin"),
		});
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(1);
		await authzChanges.append({
			scope: "organization",
			scopeId: "org-a",
			kind: "policy_changed",
			by: userPrincipal("admin"),
		});
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(2);
	});

	it("count is scoped by (scope, scopeId) — scope A's appends never change scope B's count", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter());
		await authzChanges.append({
			scope: "organization",
			scopeId: "org-a",
			kind: "policy_changed",
			by: userPrincipal("admin"),
		});
		await authzChanges.append({
			scope: "organization",
			scopeId: "org-a",
			kind: "policy_changed",
			by: userPrincipal("admin"),
		});
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(2);
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-b" }),
		).toBe(0);
	});

	it("listForScope returns the history oldest-first, scoped by (scope, scopeId)", async () => {
		const { authzChanges } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		await authzChanges.append({
			scope: "organization",
			scopeId: "org-a",
			kind: "spec_registered",
			summary: { source: "petstore" },
			by: userPrincipal("alice"),
		});
		await authzChanges.append({
			scope: "organization",
			scopeId: "org-b",
			kind: "policy_changed",
			by: userPrincipal("bob"),
		});
		await authzChanges.append({
			scope: "organization",
			scopeId: "org-a",
			kind: "policy_changed",
			summary: { slice: "guard" },
			by: userPrincipal("alice"),
		});
		const a = await authzChanges.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(a.map((c) => c.kind)).toEqual(["spec_registered", "policy_changed"]);
		expect(a.every((c) => c.scopeId === "org-a")).toBe(true);
	});

	it("rejects a malformed stored change row (out-of-enum kind)", async () => {
		const adapter = memoryAdapter();
		const { authzChanges } = createRegistryStores(adapter);
		await adapter.create({
			model: "authz_change",
			data: {
				id: "bad",
				scope: "organization",
				scopeId: "org-bad",
				kind: "mystery", // not a known change kind
				at: "t",
				by: userPrincipal("a"),
			},
		});
		await expect(
			authzChanges.listForScope({ scope: "organization", scopeId: "org-bad" }),
		).rejects.toThrow("authz_change record invalid");
	});
});

const slice = (scopeId: string, name: string) => ({
	scope: "organization",
	scopeId,
	name,
	cedar: `forbid(principal, action == Action::"x", resource);`,
	mode: "enforce" as const,
	plane: "tool" as const,
	updatedBy: userPrincipal("admin"),
});

const overlay = (scopeId: string, actionId: string) => ({
	scope: "organization",
	scopeId,
	actionId,
	access: "read" as const,
	updatedBy: userPrincipal("admin"),
});

describe("authz changes are appended on every mutation", () => {
	it("a policy-slice upsert appends policy_changed and bumps the count", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.upsert(slice("org-a", "guard"));
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(1);
		const [change] = await authzChanges.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(change).toMatchObject({
			kind: "policy_changed",
			summary: { slice: "guard" },
			by: userPrincipal("admin"),
		});
	});

	it("editing a slice (upsert same name) appends again — every edit bumps the count", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.upsert(slice("org-a", "guard"));
		await policySlices.upsert(slice("org-a", "guard")); // an edit — a replace, still a change
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(2);
	});

	it("a policy-slice delete APPENDS (never removes log rows) — the count bumps", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		const created = await policySlices.upsert(slice("org-a", "guard"));
		await policySlices.delete(
			{ scope: "organization", scopeId: created.scopeId },
			created.id,
		);
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(2); // upsert + delete = 2 events
		const kinds = (
			await authzChanges.listForScope({
				scope: "organization",
				scopeId: "org-a",
			})
		).map((c) => c.kind);
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
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(2);
		await policySlices.delete(
			{ scope: "organization", scopeId: a.scopeId },
			a.id,
		); // delete the NON-newest row
		// max(updatedAt) is unchanged (b is still newest) → a stale key; append-only count bumps:
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(3);
	});

	it("a no-op delete (row already gone) does NOT append", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.delete(
			{ scope: "organization", scopeId: "org-a" },
			"does-not-exist",
		);
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(0);
	});

	it("a facts-overlay upsert and delete each append overlay_changed", async () => {
		const { factsOverlay, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		const created = await factsOverlay.upsert(
			overlay("org-a", "petstore.getPet"),
		);
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(1);
		await factsOverlay.deleteById(created.id);
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-a" }),
		).toBe(2);
		const kinds = (
			await authzChanges.listForScope({
				scope: "organization",
				scopeId: "org-a",
			})
		).map((c) => c.kind);
		expect(kinds).toEqual(["overlay_changed", "overlay_changed"]);
	});

	it("appends are scope-keyed — scope A's mutations never change scope B's count", async () => {
		const { policySlices, authzChanges } = createRegistryStores(
			memoryAdapter(),
		);
		await policySlices.upsert(slice("org-a", "guard"));
		expect(
			await authzChanges.count({ scope: "organization", scopeId: "org-b" }),
		).toBe(0);
	});
});
