// Durable dedup reads behind deterministic placeholders: findByHash is container-scoped, and the
// subject junction is a set (re-linking on reuse never duplicates rows).
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createPiiMappingStore } from "../src/pii";

const at = "2026-07-12T00:00:00.000Z";

describe("createPiiMappingStore.findByHash", () => {
	it("resolves by hash only within the SAME container", async () => {
		const store = createPiiMappingStore(memoryAdapter());
		await store.save({
			placeholder: "{{pii:email:aaa}}",
			original: "a@b.com",
			originalHash: "h1",
			kind: "email",
			scope: "claw",
			scopeId: "a",
			createdAt: at,
		});
		await store.save({
			placeholder: "{{pii:email:bbb}}",
			original: "a@b.com",
			originalHash: "h1",
			kind: "email",
			scope: "claw",
			scopeId: "b",
			createdAt: at,
		});

		const inA = await store.findByHash("h1", { scope: "claw", scopeId: "a" });
		expect(inA?.placeholder).toBe("{{pii:email:aaa}}");
		const inB = await store.findByHash("h1", { scope: "claw", scopeId: "b" });
		expect(inB?.placeholder).toBe("{{pii:email:bbb}}");
		expect(await store.findByHash("h1")).toBeNull();
		expect(
			await store.findByHash("nope", { scope: "claw", scopeId: "a" }),
		).toBeNull();
	});

	it("erased hashes stay erased: deleteForSubject removes the dedup row too", async () => {
		const store = createPiiMappingStore(memoryAdapter());
		await store.save(
			{
				placeholder: "{{pii:email:ccc}}",
				original: "c@d.com",
				originalHash: "h2",
				kind: "email",
				scope: "claw",
				scopeId: "a",
				createdAt: at,
			},
			["s1"],
		);
		await store.deleteForSubject("s1");
		expect(
			await store.findByHash("h2", { scope: "claw", scopeId: "a" }),
		).toBeNull();
	});
});

describe("createPiiMappingStore container-scoped erasure", () => {
	it("erases a subject in its OWN container, sparing a same-code token elsewhere", async () => {
		// Word-code placeholders are unique only within a container, so two containers can carry the
		// SAME token for different values. Erasure must delete the right one, never the namesake.
		const store = createPiiMappingStore(memoryAdapter());
		const shared = "{{pii:name:river-eager}}";
		await store.save(
			{
				placeholder: shared,
				original: "Zoe",
				originalHash: "hz",
				kind: "name",
				scope: "claw",
				scopeId: "a",
				createdAt: at,
			},
			["s1"],
		);
		await store.save(
			{
				placeholder: shared,
				original: "Yan",
				originalHash: "hy",
				kind: "name",
				scope: "claw",
				scopeId: "b",
				createdAt: at,
			},
			["s2"],
		);

		await store.deleteForSubject("s1");

		expect(await store.resolve(shared, { scope: "claw", scopeId: "a" })).toBeNull();
		expect(await store.resolve(shared, { scope: "claw", scopeId: "b" })).toBe("Yan");
		// The spared container keeps its dedup row and junction link too.
		expect(
			(await store.findByHash("hy", { scope: "claw", scopeId: "b" }))?.original,
		).toBe("Yan");
	});
});

describe("createPiiMappingStore subject junction", () => {
	it("dedups (placeholder, subject) links on re-save", async () => {
		const db = memoryAdapter();
		const store = createPiiMappingStore(db);
		const mapping = {
			placeholder: "{{pii:email:ddd}}",
			original: "d@e.com",
			originalHash: "h3",
			kind: "email" as const,
			scope: "claw",
			scopeId: "a",
			createdAt: at,
		};
		await store.save(mapping, ["s1"]);
		// Deterministic reuse re-saves the same mapping with a possibly-new subject.
		await store.save(mapping, ["s1", "s2"]);
		await store.save(mapping, ["s1"]);

		const rows = await db.findMany({
			model: "pii_subject",
			where: [{ field: "placeholder", value: mapping.placeholder }],
		});
		expect(rows).toHaveLength(2); // s1 once, s2 once — never three
	});
});
