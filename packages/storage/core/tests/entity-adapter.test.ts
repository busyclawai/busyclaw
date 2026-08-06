import { entity, field, isConflict } from "@busyclaw/contracts";
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

// The adapter CONTRACT, not a nicety. "Try to create, treat a conflict as somebody-got-there-first" is
// how the registry claims a tuple, how the redactor settles a mint race, and how the channel inbox
// claims a delivery. All of it rests on the second insert LOSING — and the memory adapter's create was
// an unconditional push, so in every test in this repository the losing branch was unreachable and the
// claim silently always succeeded.
describe("declared uniqueness is enforced even where the engine cannot", () => {
	const composite = entity("pair", {
		left: field.string({ required: true, primaryKey: true }),
		right: field.string({ required: true, primaryKey: true }),
		note: field.string(),
	} as const);

	it("rejects a second row on the same single-column key", async () => {
		const db = entityAdapter(memoryAdapter(), models);
		await db.create({ model: "thing", data: record });
		await expect(
			db.create({ model: "thing", data: { ...record, label: "two" } }),
		).rejects.toThrow(/unique constraint violated/);
		// …and the first row is untouched: a losing write changes nothing.
		expect(
			await db.findOne({
				model: "thing",
				where: [{ field: "id", value: "t1" }],
			}),
		).toMatchObject({ label: "one" });
	});

	it("rejects a duplicate COMPOSITE primary key, and allows a different one", async () => {
		const db = entityAdapter(memoryAdapter(), { pair: composite });
		await db.create({ model: "pair", data: { left: "a", right: "b" } });
		await expect(
			db.create({ model: "pair", data: { left: "a", right: "b", note: "x" } }),
		).rejects.toThrow(/unique constraint violated/);
		// Sharing one half is not sharing the key.
		await expect(
			db.create({ model: "pair", data: { left: "a", right: "c" } }),
		).resolves.toMatchObject({ right: "c" });
	});

	it("is a typed conflict, so try-create → on-conflict reads the same everywhere", async () => {
		const db = entityAdapter(memoryAdapter(), models);
		await db.create({ model: "thing", data: record });
		// The shape a claim actually branches on — the same one a real driver's violation normalizes to.
		const conflict = await db
			.create({ model: "thing", data: record })
			.then(() => undefined)
			.catch((error: unknown) => error);
		expect(isConflict(conflict)).toBe(true);
	});
});

describe("boolean columns", () => {
	// The coercion is driven by the ADAPTER's declaration, so an adapter that says nothing must be
	// left alone — booleans in, booleans out, no 0/1 anywhere. This is the half a fix aimed at SQLite
	// could quietly break for everyone else.
	const fields = {
		id: field.string({ required: true, primaryKey: true, unique: true }),
		flag: field.boolean(),
	} as const;

	it("passes a boolean through untouched on an adapter with native booleans", async () => {
		const adapter = memoryAdapter();
		expect(adapter.booleans).toBeUndefined();
		const db = entityDb(adapter, { thing: { fields } });

		const created = await db.create({
			model: "thing",
			data: { id: "1", flag: true },
		});
		expect(created.flag).toBe(true);
		expect(
			(await adapter.findMany({ model: "thing", where: [] }))[0],
		).toMatchObject({ flag: true });

		const found = await db.findMany({
			model: "thing",
			where: [{ field: "flag", value: true }],
		});
		expect(found.map((row) => row.id)).toEqual(["1"]);
	});

	it("reads 0/1 back as a boolean whatever the adapter declares", async () => {
		// The read side normalizes unconditionally, because reading needs to know what the column
		// MEANS while writing needs to know what the driver ACCEPTS. A store that hands back 1 for a
		// declared boolean would otherwise fail read validation.
		const adapter = memoryAdapter();
		await adapter.create({ model: "thing", data: { id: "1", flag: 1 } });
		const db = entityDb(adapter, { thing: { fields } });

		expect(
			(
				await db.findOne({
					model: "thing",
					where: [{ field: "id", value: "1" }],
				})
			)?.flag,
		).toBe(true);
	});
});
