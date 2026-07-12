import { type } from "arktype";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	approvalSchema,
	effectRecord,
	effectSchema,
	entity,
	field,
	type JsonObject,
	piiMappingSchema,
} from "../src/index";

describe("euroclaw core — entity-derived schemas", () => {
	it("derives approval/effect/PII storage schemas from entity fields", () => {
		expect(approvalSchema.approval.fields.args).toMatchObject({
			type: "json",
			required: true,
		});
		expect(effectSchema.effect.fields.leaseTokenHash).toMatchObject({
			type: "string",
			returned: false,
		});
		expect(piiMappingSchema.pii_mapping.fields.original).toMatchObject({
			type: "string",
			required: true,
			pii: "contains",
		});
	});

	it("keeps custom JSON field validation on entity records", () => {
		const invalid = effectRecord({
			id: "effect-1",
			status: "started",
			toolName: "send_email",
			inputHash: "hash",
			compensation: { args: {} },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(invalid).toBeInstanceOf(type.errors);
	});

	it("derives the update-patch schema from field flags (immutable / input:false drop out)", () => {
		const thing = entity("thing", {
			id: field.string({ required: true, unique: true, immutable: true }),
			name: field.string({ required: true }),
			tag: field.string(),
			createdAt: field.string({ required: true, immutable: true }),
			updatedAt: field.string({ required: true, input: false }),
		});
		const update = thing.updateSchema();

		// a mutable field is accepted, and every field is optional (a patch sets any subset)
		expect(update({ name: "renamed", tag: "vip" })).not.toBeInstanceOf(
			type.errors,
		);
		expect(update({})).not.toBeInstanceOf(type.errors);
		// wrong type is still rejected — it's a real validator, not a passthrough
		expect(update({ name: 123 })).toBeInstanceOf(type.errors);

		// the immutable flag flows into the storage declaration the update path enforces
		expect(thing.storage.thing.fields.id.immutable).toBe(true);
		expect(thing.storage.thing.fields.name.immutable).toBeUndefined();
	});
});

describe("field.json — one schema drives BOTH the record type and the validator", () => {
	const point = type({ x: "number", y: "number" });
	const thing = entity("thing", {
		id: field.string({ required: true }),
		// schema-first: typed AND validated from one source
		point: field.json(point, { required: true }),
		// value-rooted schema (array) — the schema dictates the root
		tags: field.json(type("string[]")),
		// opaque JSON stays opaque — the contrast the DSL now forces
		bag: field.jsonObject(),
	} as const);
	type Rec = (typeof thing.record)["infer"];

	it("infers the record type from the schema (typed json), leaving jsonObject opaque", () => {
		expectTypeOf<Rec["point"]>().toEqualTypeOf<{ x: number; y: number }>();
		expectTypeOf<Rec["tags"]>().toEqualTypeOf<string[] | undefined>();
		// the untyped column is still just JsonObject — proof both forms coexist
		expectTypeOf<Rec["bag"]>().toEqualTypeOf<JsonObject | undefined>();
	});

	it("validates the column on read/parse — a bad shape fails loud, not silently cast", () => {
		expect(thing.record({ id: "a", point: { x: 1, y: 2 } })).not.toBeInstanceOf(
			type.errors,
		);
		// missing `y` — the record schema rejects it (the read boundary is now honest)
		expect(thing.record({ id: "a", point: { x: 1 } })).toBeInstanceOf(
			type.errors,
		);
		expect(
			thing.record({ id: "a", point: { x: 1, y: 2 }, tags: ["a", "b"] }),
		).not.toBeInstanceOf(type.errors);
		// a non-string[] stored value fails, even though it is valid JSON
		expect(
			thing.record({ id: "a", point: { x: 1, y: 2 }, tags: [1] }),
		).toBeInstanceOf(type.errors);
	});

	it("validates the input schema too — create rejects a bad shape", () => {
		const create = thing.schema({ omit: ["id"] });
		expect(create({ point: { x: 1, y: 2 } })).not.toBeInstanceOf(type.errors);
		expect(create({ point: "nope" as unknown as never })).toBeInstanceOf(
			type.errors,
		);
	});
});

describe("entity schemas — undefined-valued keys drop at the parse", () => {
	const thing = entity("thing", {
		id: field.string({ required: true, unique: true, immutable: true }),
		label: field.string({ required: true }),
		note: field.string(),
		count: field.number(),
	} as const);

	it("schema() parses flat literals: present-but-undefined optionals come out ABSENT", () => {
		const input = thing.schema({ omit: ["id"] })({
			label: "a",
			note: undefined,
			count: undefined,
		});
		expect(input).not.toBeInstanceOf(type.errors);
		expect(input).toEqual({ label: "a" });
		expect(Object.keys(input)).toEqual(["label"]);
	});

	it("updateSchema() does the same for patches, and never mutates the caller's object", () => {
		const patch = { label: "b", note: undefined };
		const parsed = thing.updateSchema()(patch);
		expect(parsed).not.toBeInstanceOf(type.errors);
		expect(Object.keys(parsed)).toEqual(["label"]);
		expect(Object.keys(patch)).toEqual(["label", "note"]); // caller untouched
	});

	it("record parsing normalizes adapter rows the same way", () => {
		const row = thing.record({
			id: "t1",
			label: "a",
			note: undefined,
		});
		expect(row).not.toBeInstanceOf(type.errors);
		expect(Object.keys(row)).toEqual(["id", "label"]);
	});

	it("required fields still reject undefined — dropping never masks a missing required value", () => {
		expect(
			thing.schema({ omit: ["id"] })({ label: undefined, note: "x" }),
		).toBeInstanceOf(type.errors);
	});
});
