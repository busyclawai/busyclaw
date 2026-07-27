import { type } from "arktype";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	approvalSchema,
	docOf,
	effectRecord,
	effectSchema,
	entity,
	factsOverlaySchema,
	field,
	type JsonObject,
	piiMappingSchema,
	policySliceSchema,
	specRegistrationSchema,
	uniqueConstraints,
} from "../src/index";

/** Guard-narrowed error summary — the test fails loud when validation unexpectedly passed. */
function summaryOf(result: unknown): string {
	if (result instanceof type.errors) return result.summary;
	throw new Error("expected validation to fail");
}

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

	it("every replace-by-tuple config table enforces that tuple", () => {
		// Each of these already SAID it — in a section header or an upsert docstring — while the
		// database agreed to none of it. Their ids are generated, so two concurrent writers collide on
		// nothing and leave two rows for one logical registration: later reads pick an arbitrary one,
		// and an update lands on only one. For policy_slice that is an authz fact.
		expect(specRegistrationSchema.spec_registration.uniques).toEqual([
			["scope", "scopeId", "source"],
		]);
		expect(factsOverlaySchema.facts_overlay.uniques).toEqual([
			["scope", "scopeId", "actionId"],
		]);
		expect(policySliceSchema.policy_slice.uniques).toEqual([
			["scope", "scopeId", "name"],
		]);
	});

	it("pii_mapping is unique on the VALUE per container, not on the placeholder", () => {
		// The tuple is load-bearing and is exactly the kind of thing that gets 'simplified' into the
		// primary key. placeholder + scope + scopeId ARE the primary key, so a unique over those states
		// nothing new — and it would not catch the race it appears to, because two concurrent writers
		// mint two DIFFERENT placeholders. What they collide on is the value, which originalHash names.
		expect(piiMappingSchema.pii_mapping.uniques).toEqual([
			["scope", "scopeId", "originalHash"],
		]);
		expect(
			uniqueConstraints("pii_mapping", piiMappingSchema.pii_mapping),
		).toEqual([
			{
				name: "pii_mapping_scope_scopeId_originalHash_uq",
				columns: ["scope", "scopeId", "originalHash"],
			},
		]);
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

describe("field docs — description/doc ride every derived schema", () => {
	// Twin entities differing ONLY in docs — the storage/wording comparisons below lean on that.
	const documented = entity("thing", {
		id: field.string({ required: true, unique: true, immutable: true }),
		name: field.string({
			required: true,
			description: "the display name shown in listings",
			doc: "Renamable at any time; listings sort by it.",
		}),
		note: field.string({ description: "a short free-form note" }),
		mode: field.enum(["fast", "safe"], {
			doc: "Safe mode re-checks every write.",
		}),
		point: field.json(type({ x: "number", y: "number" }), {
			required: true,
			description: "a 2d point",
		}),
	} as const);
	const bare = entity("thing", {
		id: field.string({ required: true, unique: true, immutable: true }),
		name: field.string({ required: true }),
		note: field.string(),
		mode: field.enum(["fast", "safe"]),
		point: field.json(type({ x: "number", y: "number" }), { required: true }),
	} as const);
	const valid = { id: "a", name: "n", point: { x: 1, y: 2 } };

	it("the derived create-input's toJsonSchema() carries the property description", () => {
		const create = documented.schema({ omit: ["id"] });
		// The exact emission options the OpenAPI generator uses (adapter-core schemaJson).
		const emitted = create.toJsonSchema({
			dialect: null,
			fallback: (ctx) => ctx.base,
		}) as {
			properties: Record<
				string,
				{ description?: string; anyOf?: { description?: string }[] }
			>;
		};
		expect(emitted.properties.name?.description).toBe(
			"the display name shown in listings",
		);
		expect(emitted.properties.point?.description).toBe("a 2d point");
		// Optional composition: the description is described onto the INNER type before the
		// `| undefined` union, so it rides the typed branch — not the union wrapper.
		expect(emitted.properties.note?.anyOf?.[0]?.description).toBe(
			"a short free-form note",
		);
	});

	it("a described field's validation error reads 'must be <description>'", () => {
		expect(summaryOf(documented.record({ ...valid, name: 5 }))).toBe(
			"name must be the display name shown in listings (was a number)",
		);
		// docs never change what validates — only how a failure reads
		expect(documented.record(valid)).not.toBeInstanceOf(type.errors);
	});

	it("optional described fields keep the union rendering; undocumented fields are unchanged", () => {
		// The inner-describe composition leaves the optional union's baked branch rendering
		// intact — byte-identical to the undocumented twin (never "must be undefined"-corrupted).
		const wrongNote = { ...valid, note: 5 };
		expect(summaryOf(documented.record(wrongNote))).toBe(
			"note must be a string or undefined (was a number)",
		);
		expect(summaryOf(documented.record(wrongNote))).toBe(
			summaryOf(bare.record(wrongNote)),
		);
		// an undocumented field errors identically on both twins
		const missingId = { name: "n", point: { x: 1, y: 2 } };
		expect(summaryOf(documented.record(missingId))).toBe(
			summaryOf(bare.record(missingId)),
		);
	});

	it("docOf reads the doc off the materialized field types the derived shapes hold", () => {
		// The record validator's input side holds exactly what shapeFor materialized; its props
		// carry the per-field types (the access path a field-level doc consumer would walk).
		const props = (
			documented.record as unknown as {
				in: { props: readonly { key: string; value: unknown }[] };
			}
		).in.props;
		const fieldTypeOf = (key: string): unknown => {
			const prop = props.find((entry) => entry.key === key);
			if (!prop) throw new Error(`missing prop ${key}`);
			return prop.value;
		};
		expect(docOf(fieldTypeOf("name"))).toBe(
			"Renamable at any time; listings sort by it.",
		);
		// optional union: the doc is configured on the FULL property type, so it reads here too
		expect(docOf(fieldTypeOf("mode"))).toBe("Safe mode re-checks every write.");
		// describe-only required field: docOf falls back to the described text
		expect(docOf(fieldTypeOf("point"))).toBe("a 2d point");
		expect(docOf(fieldTypeOf("id"))).toBeUndefined();
	});

	it("the storage projection is byte-identical with and without docs", () => {
		// Docs are validator/doc-consumer metadata, never migration input: the generate-CLI
		// SchemaDeclaration must not move when prose is added.
		expect(JSON.stringify(documented.storage)).toBe(
			JSON.stringify(bare.storage),
		);
		expect(documented.storage).toEqual(bare.storage);
	});
});

describe("entity() — table-level composite uniques", () => {
	const fields = {
		placeholder: field.string({ required: true }),
		scope: field.string({ required: true }),
		scopeId: field.string({ required: true }),
		original: field.string({ required: true }),
	} as const;

	it("carries `uniques` through to the storage declaration", () => {
		const declared = entity("pii_mapping", fields, {
			uniques: [["scope", "scopeId", "placeholder"]],
		});
		expect(declared.storage.pii_mapping?.uniques).toEqual([
			["scope", "scopeId", "placeholder"],
		]);
	});

	it("omits the key entirely when a table declares none", () => {
		// The option is additive: the 38 existing call sites pass nothing and must be unchanged.
		const declared = entity("pii_mapping", fields);
		expect(declared.storage.pii_mapping).not.toHaveProperty("uniques");
	});

	it("resolves a constraint to physical columns and a derived name", () => {
		const declared = entity(
			"pii_mapping",
			{
				...fields,
				scopeId: field.string({ required: true, fieldName: "scope_id" }),
			} as const,
			{ uniques: [["scope", "scopeId"]] },
		);

		expect(
			uniqueConstraints("pii_mapping", declared.storage.pii_mapping as never),
		).toEqual([
			{ name: "pii_mapping_scope_scope_id_uq", columns: ["scope", "scope_id"] },
		]);
	});

	it("throws when a constraint names a field the table does not have", () => {
		const declared = entity("pii_mapping", fields, {
			uniques: [["scope", "nope"] as never],
		});
		expect(() =>
			uniqueConstraints("pii_mapping", declared.storage.pii_mapping as never),
		).toThrow(/names "nope", which is not a field/);
	});
});
