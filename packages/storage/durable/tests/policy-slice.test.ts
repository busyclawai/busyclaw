import { userPrincipal } from "@busyclaw/contracts";
import { memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createRegistryStores } from "../src/registry";

const sliceInput = (
	scopeId: string,
	name = "reads-only",
	mode: "enforce" | "shadow" | "off" = "enforce",
) => ({
	scope: "organization",
	scopeId,
	name,
	cedar: `forbid(principal, action == Action::"petstore.removePet", resource);`,
	mode,
	// A stored slice states its plane like a plugin-contributed one does (R-H04). These fixtures are
	// agent-surface policy.
	plane: "tool" as const,
	updatedBy: userPrincipal("admin"),
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
		const listed = await policySlices.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			name: "reads-only",
			mode: "enforce",
			plane: "tool",
			cedar: sliceInput("org-a").cedar,
			updatedBy: userPrincipal("admin"),
		});
	});

	it("upsert REPLACES in place by (scope, scopeId, name) — id + createdAt preserved", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter(), {
			now: stamps(),
		});
		const first = await policySlices.upsert(sliceInput("org-a", "guard"));
		const second = await policySlices.upsert({
			...sliceInput("org-a", "guard"),
			cedar: `permit(principal, action, resource);`,
			mode: "shadow",
			plane: "tool",
			updatedBy: userPrincipal("bob"),
		});
		expect(second.id).toBe(first.id); // replace-in-place, not a new row
		expect(second.createdAt).toBe(first.createdAt); // createdAt preserved
		expect(second.updatedAt).not.toBe(first.updatedAt); // updatedAt bumped
		const listed = await policySlices.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(listed).toHaveLength(1); // one row per (org, name)
		expect(listed[0]?.mode).toBe("shadow");
		expect(listed[0]?.updatedBy).toBe(userPrincipal("bob"));
	});

	// An upsert used to write a hand-picked few columns, so `plane` was accepted by the input schema
	// and silently discarded: a caller moving a slice to the api plane got a success and a read-back
	// still saying "tool", which was honest about a write that never happened. A field the schema
	// takes and the update drops is worse than one it rejects.
	it("upsert REPLACES every column it accepted, not a hand-picked few", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter());
		await policySlices.upsert({
			...sliceInput("org-a", "guard"),
			plane: "tool",
		});
		await policySlices.upsert({
			...sliceInput("org-a", "guard"),
			plane: "api",
			managedBy: "operator",
		});
		const [row] = await policySlices.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(row?.plane).toBe("api");
		expect(row?.managedBy).toBe("operator");
	});

	it("distinct names in one scope coexist", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter());
		await policySlices.upsert(sliceInput("org-a", "a", "enforce"));
		await policySlices.upsert(sliceInput("org-a", "b", "shadow"));
		const listed = await policySlices.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(listed.map((s) => s.name).sort()).toEqual(["a", "b"]);
	});

	it("delete removes the row (scope-keyed)", async () => {
		const { policySlices } = createRegistryStores(memoryAdapter());
		const created = await policySlices.upsert(sliceInput("org-a"));
		// A wrong-org delete is a no-op — a caller cannot remove another org's slice by id.
		await policySlices.delete(
			{ scope: "organization", scopeId: "org-b" },
			created.id,
		);
		expect(
			await policySlices.listForScope({
				scope: "organization",
				scopeId: "org-a",
			}),
		).toHaveLength(1);
		await policySlices.delete(
			{ scope: "organization", scopeId: "org-a" },
			created.id,
		);
		expect(
			await policySlices.listForScope({
				scope: "organization",
				scopeId: "org-a",
			}),
		).toEqual([]);
	});

	it("lists are scoped by (scope, scopeId) — scope A's slices never leak into scope B", async () => {
		const stores = createRegistryStores(memoryAdapter());
		await stores.policySlices.upsert(sliceInput("org-a"));
		await stores.policySlices.upsert(sliceInput("org-b"));
		const a = await stores.policySlices.listForScope({
			scope: "organization",
			scopeId: "org-a",
		});
		expect(a).toHaveLength(1);
		expect(a.every((s) => s.scopeId === "org-a")).toBe(true);
		const b = await stores.policySlices.listForScope({
			scope: "organization",
			scopeId: "org-b",
		});
		expect(b.every((s) => s.scopeId === "org-b")).toBe(true);
	});

	it("rejects a malformed stored slice row (required cedar missing)", async () => {
		const adapter = memoryAdapter();
		const { policySlices } = createRegistryStores(adapter);
		await adapter.create({
			model: "policy_slice",
			data: {
				id: "bad",
				scope: "organization",
				scopeId: "org-bad",
				name: "x",
				mode: "enforce",
				plane: "tool",
				updatedBy: userPrincipal("a"),
				createdAt: "t",
				updatedAt: "t",
			},
		});
		await expect(
			policySlices.listForScope({ scope: "organization", scopeId: "org-bad" }),
		).rejects.toThrow("policy_slice record invalid");
	});

	it("rejects a stored slice with an out-of-enum mode", async () => {
		const adapter = memoryAdapter();
		const { policySlices } = createRegistryStores(adapter);
		await adapter.create({
			model: "policy_slice",
			data: {
				id: "bad",
				scope: "organization",
				scopeId: "org-bad",
				name: "x",
				cedar: "permit(principal, action, resource);",
				mode: "sometimes", // not enforce|shadow|off
				updatedBy: userPrincipal("a"),
				createdAt: "t",
				updatedAt: "t",
			},
		});
		await expect(
			policySlices.listForScope({ scope: "organization", scopeId: "org-bad" }),
		).rejects.toThrow("policy_slice record invalid");
	});
});
