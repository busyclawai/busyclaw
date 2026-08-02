import { userPrincipal } from "@busyclaw/contracts";
import { memoryAdapter } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createAccessGrantStore } from "../src/grant";

const stamps = () => {
	let n = 0;
	return () => `2026-01-01T00:00:0${n++}Z`;
};

describe("createAccessGrantStore — the generic shareable-resource ACL", () => {
	it("create stamps id + createdAt and round-trips the row", async () => {
		const store = createAccessGrantStore(memoryAdapter(), { now: stamps() });
		const record = await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: userPrincipal("bob"),
			permission: "use",
			grantedBy: userPrincipal("alice"),
		});
		expect(record.id).toMatch(/^[0-9a-f]{32}$/);
		expect(record.createdAt).toBe("2026-01-01T00:00:00Z");
		expect(record).toMatchObject({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: userPrincipal("bob"),
			permission: "use",
			grantedBy: userPrincipal("alice"),
		});
	});

	it("listForResources projects permission → level and is scoped to (resourceKind, resourceId)", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: userPrincipal("bob"),
			permission: "manage",
			grantedBy: userPrincipal("alice"),
		});
		// A grant on a DIFFERENT resource of the same kind must not leak in.
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-2",
			principalRef: userPrincipal("carol"),
			permission: "read",
			grantedBy: userPrincipal("alice"),
		});
		// A grant of a DIFFERENT kind, same id, must not leak in either (kinds are opaque + distinct).
		await store.create({
			resourceKind: "thread",
			resourceId: "claw-1",
			principalRef: "public",
			permission: "read",
			grantedBy: userPrincipal("alice"),
		});

		const grants = await store.listForResources([
			{ resourceKind: "claw", resourceId: "claw-1" },
		]);
		// The PEP-facing projection: { principalRef, level } only — audit columns stay in the store.
		expect(grants.get("claw")?.get("claw-1")).toEqual([
			{ principalRef: userPrincipal("bob"), level: "manage" },
		]);
		// Neither the same-kind sibling nor the same-id other kind came along.
		expect(grants.get("claw")?.get("claw-2")).toBeUndefined();
		expect(grants.get("thread")).toBeUndefined();
	});

	it("answers for many resources across kinds in one call", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		for (const row of [
			{
				resourceKind: "claw",
				resourceId: "claw-1",
				principalRef: userPrincipal("bob"),
			},
			{
				resourceKind: "claw",
				resourceId: "claw-2",
				principalRef: userPrincipal("carol"),
			},
			{ resourceKind: "thread", resourceId: "t-1", principalRef: "public" },
			// Not asked for — must not come back even though its kind is.
			{
				resourceKind: "claw",
				resourceId: "claw-9",
				principalRef: userPrincipal("mallory"),
			},
		]) {
			await store.create({
				...row,
				permission: "read",
				grantedBy: userPrincipal("alice"),
			});
		}

		const grants = await store.listForResources([
			{ resourceKind: "claw", resourceId: "claw-1" },
			{ resourceKind: "claw", resourceId: "claw-2" },
			{ resourceKind: "thread", resourceId: "t-1" },
			// A key with no grants at all is ABSENT, not an empty array.
			{ resourceKind: "claw", resourceId: "claw-nothing" },
		]);
		expect(grants.get("claw")?.get("claw-1")).toEqual([
			{ principalRef: userPrincipal("bob"), level: "read" },
		]);
		expect(grants.get("claw")?.get("claw-2")).toEqual([
			{ principalRef: userPrincipal("carol"), level: "read" },
		]);
		expect(grants.get("thread")?.get("t-1")).toEqual([
			{ principalRef: "public", level: "read" },
		]);
		expect(grants.get("claw")?.get("claw-9")).toBeUndefined();
		expect(grants.get("claw")?.get("claw-nothing")).toBeUndefined();
	});

	it("returns nothing for an empty key set without touching the database", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		expect((await store.listForResources([])).size).toBe(0);
	});

	it("delete revokes EVERY level a grantee held on the resource, by the natural key", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: userPrincipal("bob"),
			permission: "read",
			grantedBy: userPrincipal("alice"),
		});
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: userPrincipal("bob"),
			permission: "manage",
			grantedBy: userPrincipal("alice"),
		});
		// A grant to a DIFFERENT principal on the same resource must survive the unshare.
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: "public",
			permission: "read",
			grantedBy: userPrincipal("alice"),
		});

		const removed = await store.delete({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: userPrincipal("bob"),
		});
		expect(removed).toBe(2);
		expect(
			(
				await store.listForResources([
					{ resourceKind: "claw", resourceId: "claw-1" },
				])
			)
				.get("claw")
				?.get("claw-1"),
		).toEqual([{ principalRef: "public", level: "read" }]);
	});

	it("rejects a malformed grant at the create boundary", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		await expect(
			// permission is not a valid level
			store.create({
				resourceKind: "claw",
				resourceId: "claw-1",
				principalRef: userPrincipal("bob"),
				permission: "activate" as never,
				grantedBy: userPrincipal("alice"),
			}),
		).rejects.toThrow();
	});
});
