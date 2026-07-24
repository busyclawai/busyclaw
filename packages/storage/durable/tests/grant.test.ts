import { memoryAdapter } from "@euroclaw/storage-core";
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
			principalRef: "user:bob",
			permission: "use",
			grantedBy: "user:alice",
		});
		expect(record.id).toMatch(/^[0-9a-f]{32}$/);
		expect(record.createdAt).toBe("2026-01-01T00:00:00Z");
		expect(record).toMatchObject({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: "user:bob",
			permission: "use",
			grantedBy: "user:alice",
		});
	});

	it("listForResource projects permission → level and is scoped to (resourceKind, resourceId)", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: "user:bob",
			permission: "manage",
			grantedBy: "user:alice",
		});
		// A grant on a DIFFERENT resource of the same kind must not leak in.
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-2",
			principalRef: "user:carol",
			permission: "read",
			grantedBy: "user:alice",
		});
		// A grant of a DIFFERENT kind, same id, must not leak in either (kinds are opaque + distinct).
		await store.create({
			resourceKind: "thread",
			resourceId: "claw-1",
			principalRef: "public",
			permission: "read",
			grantedBy: "user:alice",
		});

		const grants = await store.listForResource("claw", "claw-1");
		// The PEP-facing projection: { principalRef, level } only — audit columns stay in the store.
		expect(grants).toEqual([{ principalRef: "user:bob", level: "manage" }]);
	});

	it("delete revokes EVERY level a grantee held on the resource, by the natural key", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: "user:bob",
			permission: "read",
			grantedBy: "user:alice",
		});
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: "user:bob",
			permission: "manage",
			grantedBy: "user:alice",
		});
		// A grant to a DIFFERENT principal on the same resource must survive the unshare.
		await store.create({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: "public",
			permission: "read",
			grantedBy: "user:alice",
		});

		const removed = await store.delete({
			resourceKind: "claw",
			resourceId: "claw-1",
			principalRef: "user:bob",
		});
		expect(removed).toBe(2);
		expect(await store.listForResource("claw", "claw-1")).toEqual([
			{ principalRef: "public", level: "read" },
		]);
	});

	it("rejects a malformed grant at the create boundary", async () => {
		const store = createAccessGrantStore(memoryAdapter());
		await expect(
			// permission is not a valid level
			store.create({
				resourceKind: "claw",
				resourceId: "claw-1",
				principalRef: "user:bob",
				permission: "activate" as never,
				grantedBy: "user:alice",
			}),
		).rejects.toThrow();
	});
});
