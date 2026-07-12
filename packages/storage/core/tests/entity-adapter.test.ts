import { entity, field } from "@euroclaw/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	entityAdapter,
	entityDb,
	entityView,
	memoryAdapter,
} from "../src/index";

const thingEntity = entity("thing", {
	id: field.string({ required: true, unique: true, immutable: true }),
	label: field.string({ required: true }),
	count: field.number(),
	// A storage-only column: written at create, never returned from reads.
	secretHash: field.string({ returned: false }),
	createdAt: field.string({ required: true, immutable: true }),
} as const);

const models = { thing: thingEntity } as const;

const record = {
	id: "t1",
	label: "one",
	count: 1,
	secretHash: "hash",
	createdAt: "2026-01-01T00:00:00.000Z",
};

describe("entityDb — the model name drives the type, validation makes it true", () => {
	it("create validates the record going down and returns the read view", async () => {
		const db = entityDb(memoryAdapter(), models);
		const created = await db.create({ model: "thing", data: record });
		expect(created).toMatchObject({ id: "t1", label: "one" });
		// the returned:false column is stripped from the read view (decodeRow drops it)
		expect("secretHash" in created).toBe(false);
		// the type follows the model argument — no type parameter to get wrong
		expectTypeOf(created.label).toEqualTypeOf<string>();
		expectTypeOf(created.count).toEqualTypeOf<number | undefined>();
		// @ts-expect-error — returned:false columns are absent from the read record type
		created.secretHash;
	});

	it("create rejects a malformed record before it reaches the adapter", async () => {
		const db = entityDb(memoryAdapter(), models);
		await expect(
			db.create({
				model: "thing",
				data: { ...record, label: 7 as unknown as string },
			}),
		).rejects.toThrow(/thing record invalid/);
	});

	it("reads are parsed, not asserted — a tampered row fails loud", async () => {
		const raw = memoryAdapter();
		const db = entityDb(raw, models);
		await db.create({ model: "thing", data: record });
		// Corrupt the stored row behind the entity layer's back (raw adapter, physical row).
		await raw.update({
			model: "thing",
			where: [{ field: "id", value: "t1" }],
			update: { label: 42 },
		});
		await expect(
			db.findOne({ model: "thing", where: [{ field: "id", value: "t1" }] }),
		).rejects.toThrow(/thing record invalid/);
	});

	it("findMany / update round-trip through the read validator", async () => {
		const db = entityDb(memoryAdapter(), models);
		await db.create({ model: "thing", data: record });
		const rows = await db.findMany({ model: "thing" });
		expect(rows).toHaveLength(1);
		const patched = await db.update({
			model: "thing",
			where: [{ field: "id", value: "t1" }],
			update: { label: "renamed" },
		});
		expect(patched?.label).toBe("renamed");
	});

	it("types where fields — a typo'd column is a compile error AND a runtime throw", async () => {
		const db = entityDb(memoryAdapter(), models);
		await db.create({ model: "thing", data: record });
		await expect(
			db.findOne({
				model: "thing",
				// @ts-expect-error — "labell" is not a column of thing (strict schemaAdapter also throws)
				where: [{ field: "labell", value: "one" }],
			}),
		).rejects.toThrow();
	});
});

describe("entityView — the typed lens fails loud on wiring mistakes", () => {
	it("rejects a plain (non-validating) adapter", () => {
		expect(() => entityView(memoryAdapter(), models)).toThrow(
			/entity-validating adapter/,
		);
	});

	it("rejects a model the adapter has not registered", () => {
		const validating = entityAdapter(memoryAdapter(), models);
		const other = entity("other", {
			id: field.string({ required: true }),
		} as const);
		expect(() => entityView(validating, { other })).toThrow(
			/not registered with the entity adapter/,
		);
	});

	it("count/delete on an unregistered model fail loud instead of no-op", async () => {
		const validating = entityAdapter(memoryAdapter(), models);
		await expect(validating.count({ model: "nope" })).rejects.toThrow(
			/not registered with the entity adapter/,
		);
	});
});
