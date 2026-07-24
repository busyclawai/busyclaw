import { type as ark, type Type } from "arktype";
import type { JsonObject, JsonValue } from "./common";
import {
	jsonObject as jsonObjectSchema,
	jsonValue as jsonValueSchema,
} from "./common";
import {
	type Principal,
	principal as principalSchema,
} from "./governance/principal";
import type { FieldAttribute, FieldType } from "./storage";

// A field's PERSISTED meta IS the storage protocol's FieldAttribute — one definition, extended (never
// forked) so the DSL and the schema format can never drift. (`immutable`: set once at create, never
// changed by an update — enforced at the storage layer and dropped from the derived update input;
// distinct from `input: false`, which is set by the store, not the caller.) The doc pair below is
// DESCRIPTOR-ONLY: carried on the field like the flags, attached to the arktype types the derived
// schemas materialize (see `documentedField`), and never projected by `entity().storage` — docs are
// validator/doc-consumer metadata, not migration input. EntityField below layers the compile-time
// extras on top: the kind/value generics and the ark validators.
export type EntityFieldType = FieldType;
export type EntityFieldMeta = FieldAttribute & {
	/** Terse noun phrase for the field — becomes the derived schemas' `.describe()` text, so it
	 *  reads as the validation error ("must be <description>") and lands as standard JSON-Schema
	 *  `description` wherever a derived schema emits `toJsonSchema()`. */
	description?: string;
	/** Rich behavioral prose — rides the euroclaw doc meta channel (`{ euroclaw: { doc } }`,
	 *  governance/doc.ts) on the materialized field type, read via `docOf`; never part of
	 *  validation error messages. */
	doc?: string;
};

type FieldKind =
	| "string"
	| "number"
	| "boolean"
	| "jsonObject"
	| "jsonValue"
	| "json"
	| "enum"
	| "principal";

// The base/constraint form leaves `Value` as `unknown`: `Record<string, EntityField>` (the bound
// every entity helper carries) must admit fields whose value type isn't pure JSON — a schema-first
// `field.json(schema)` column can infer, say, `ToolGovernance` (an optional `gate: Function` that is
// never present at rest but lives in the type). Concrete field types always pass `Value` explicitly
// through `makeField`, so this default is only ever the constraint bound, never a real field's type.
export type EntityField<
	Kind extends FieldKind = FieldKind,
	Values extends readonly string[] = readonly string[],
	Value = unknown,
> = EntityFieldMeta & {
	kind: Kind;
	values?: Values;
	ark: unknown;
	optionalArk: unknown;
	readonly __value: Value;
};

type FieldValue<F> = F extends { readonly __value: infer Value }
	? Value
	: never;

type EmptyFieldMeta = Record<never, never>;

type JsonEntityFieldMeta = Omit<EntityFieldMeta, "type"> & {
	ark?: unknown;
	optionalArk?: unknown;
};

type JsonEntityStorageMeta<Meta> = Omit<Meta, "ark" | "optionalArk"> & {
	type: "json";
};

type RequiredKeys<Fields extends Record<string, EntityField>> = {
	[K in keyof Fields]: Fields[K]["required"] extends true ? K : never;
}[keyof Fields];

type OptionalKeys<Fields extends Record<string, EntityField>> = Exclude<
	keyof Fields,
	RequiredKeys<Fields>
>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type EntityRecord<Fields extends Record<string, EntityField>> = Simplify<
	{ [K in RequiredKeys<Fields>]: FieldValue<Fields[K]> } & {
		[K in OptionalKeys<Fields>]?: FieldValue<Fields[K]>;
	}
>;

export type EntityInput<
	Fields extends Record<string, EntityField>,
	Omitted extends keyof Fields = never,
	Optional extends Exclude<keyof Fields, Omitted> = never,
> = Simplify<
	{
		[K in Exclude<RequiredKeys<Fields>, Omitted | Optional>]: FieldValue<
			Fields[K]
		>;
	} & {
		[K in Exclude<OptionalKeys<Fields>, Omitted> | Optional]?: FieldValue<
			Fields[K]
		>;
	}
>;

export type EntitySchemaOptions<Fields extends Record<string, EntityField>> = {
	omit?: readonly (keyof Fields & string)[];
	optional?: readonly (keyof Fields & string)[];
	pick?: readonly (keyof Fields & string)[];
};

type OptionKeys<
	Options,
	Key extends keyof EntitySchemaOptions<Record<string, EntityField>>,
> =
	Options extends Record<Key, readonly (infer Value)[]>
		? Extract<Value, string>
		: never;

type PickedKeys<
	Fields extends Record<string, EntityField>,
	Options,
> = Options extends { pick: readonly (infer Value)[] }
	? Extract<Value, keyof Fields>
	: keyof Fields;

type SchemaKeys<Fields extends Record<string, EntityField>, Options> = Exclude<
	PickedKeys<Fields, Options>,
	Extract<OptionKeys<Options, "omit">, keyof Fields>
>;

type SchemaRequiredKeys<
	Fields extends Record<string, EntityField>,
	Options,
> = Exclude<
	Extract<RequiredKeys<Fields>, SchemaKeys<Fields, Options>>,
	Extract<OptionKeys<Options, "optional">, keyof Fields>
>;

type SchemaOptionalKeys<
	Fields extends Record<string, EntityField>,
	Options,
> = Exclude<SchemaKeys<Fields, Options>, SchemaRequiredKeys<Fields, Options>>;

export type EntitySchemaInput<
	Fields extends Record<string, EntityField>,
	Options extends EntitySchemaOptions<Fields>,
> = Simplify<
	{ [K in SchemaRequiredKeys<Fields, Options>]: FieldValue<Fields[K]> } & {
		[K in SchemaOptionalKeys<Fields, Options>]?: FieldValue<Fields[K]>;
	}
>;

/** Keys eligible for an update patch: not `immutable` (storage-mutable) and caller-facing
 * (`input !== false`). Field factories const-capture meta, so these flags are readable literals. */
type UpdatableKeys<Fields extends Record<string, EntityField>> = {
	[K in keyof Fields]: Fields[K]["immutable"] extends true
		? never
		: Fields[K]["input"] extends false
			? never
			: K;
}[keyof Fields];

/**
 * The update-patch shape derived from the fields themselves — every mutable, caller-facing field, all
 * optional. Mutability lives on the field (the same `immutable` flag the storage layer enforces) instead
 * of a hand-kept pick/optional list: mark identity/immutable columns `immutable: true` and
 * server-managed ones (e.g. updatedAt) `input: false`, and the patch shape follows. `Omitted` drops
 * otherwise-mutable columns from a SPECIFIC patch surface without marking the field immutable — used where
 * a column is storage-mutable but not mass-assignable through a given api (the claw `scope`/`scopeId`
 * access boundary, which changes only through a governed sharing transition, never an `updateClaw` patch).
 */
export type EntityUpdateInput<
	Fields extends Record<string, EntityField>,
	Omitted extends keyof Fields = never,
> = Simplify<{
	[K in Exclude<UpdatableKeys<Fields>, Omitted>]?: FieldValue<Fields[K]>;
}>;

function enumExpression(values: readonly string[]): string {
	return values.map((value) => `'${value}'`).join(" | ");
}

function optionalExpression(expression: string): string {
	return `${expression} | undefined`;
}

function makeField<
	const Kind extends FieldKind,
	const Values extends readonly string[],
	Value,
	const Meta extends EntityFieldMeta,
>(
	input: Meta & {
		kind: Kind;
		values?: Values;
		ark: unknown;
		optionalArk: unknown;
	},
): EntityField<Kind, Values, Value> & Meta {
	return input as EntityField<Kind, Values, Value> & Meta;
}

export const field = {
	string: <const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta>(
		meta?: Meta,
	) =>
		makeField<"string", readonly string[], string, Meta & { type: "string" }>({
			...(meta ?? ({} as Meta)),
			type: "string",
			kind: "string",
			ark: "string",
			optionalArk: "string | undefined",
		}),
	number: <const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta>(
		meta?: Meta,
	) =>
		makeField<"number", readonly string[], number, Meta & { type: "number" }>({
			...(meta ?? ({} as Meta)),
			type: "number",
			kind: "number",
			ark: "number",
			optionalArk: "number | undefined",
		}),
	boolean: <const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta>(
		meta?: Meta,
	) =>
		makeField<
			"boolean",
			readonly string[],
			boolean,
			Meta & { type: "boolean" }
		>({
			...(meta ?? ({} as Meta)),
			type: "boolean",
			kind: "boolean",
			ark: "boolean",
			optionalArk: "boolean | undefined",
		}),
	jsonObject: <
		Value = JsonObject,
		const Meta extends JsonEntityFieldMeta = EmptyFieldMeta,
	>(
		meta?: Meta,
	) => {
		const { ark, optionalArk, ...fieldMeta } = meta ?? {};
		const input = {
			...fieldMeta,
			type: "json",
			kind: "jsonObject",
			ark: ark ?? jsonObjectSchema,
			optionalArk: optionalArk ?? jsonObjectSchema.or("undefined"),
		} as JsonEntityStorageMeta<Meta> & {
			kind: "jsonObject";
			ark: unknown;
			optionalArk: unknown;
		};
		return makeField<
			"jsonObject",
			readonly string[],
			Value,
			JsonEntityStorageMeta<Meta>
		>(input);
	},
	jsonValue: <
		Value = JsonValue,
		const Meta extends JsonEntityFieldMeta = EmptyFieldMeta,
	>(
		meta?: Meta,
	) => {
		const { ark, optionalArk, ...fieldMeta } = meta ?? {};
		const input = {
			...fieldMeta,
			type: "json",
			kind: "jsonValue",
			ark: ark ?? jsonValueSchema,
			optionalArk: optionalArk ?? jsonValueSchema.or("undefined"),
		} as JsonEntityStorageMeta<Meta> & {
			kind: "jsonValue";
			ark: unknown;
			optionalArk: unknown;
		};
		return makeField<
			"jsonValue",
			readonly string[],
			Value,
			JsonEntityStorageMeta<Meta>
		>(input);
	},
	// Schema-first json: ONE arktype `Type` drives BOTH the record type (`Value = S["infer"]`) and
	// the boundary validator (`ark = schema`), so the two can never drift the way a hand-set
	// `jsonObject<T>({ ark })` pair can. The store read IS the boundary — with a real `ark`, the
	// entity's record schema validates this column on every read, not just "is it json". Use this
	// where euroclaw OWNS the shape; keep `jsonObject`/`jsonValue` for genuinely opaque payloads.
	// The persisted shape is unchanged (`type: "json"`) — this is a type+validation change, not a
	// migration. The schema dictates the root, so one constructor covers object- and value-rooted
	// shapes alike.
	json: <
		S extends Type,
		const Meta extends Omit<
			JsonEntityFieldMeta,
			"ark" | "optionalArk"
		> = EmptyFieldMeta,
	>(
		schema: S,
		meta?: Meta,
	) => {
		const input = {
			...(meta ?? ({} as Meta)),
			type: "json",
			kind: "json",
			ark: schema,
			optionalArk: schema.or("undefined"),
		} as JsonEntityStorageMeta<Meta> & {
			kind: "json";
			ark: unknown;
			optionalArk: unknown;
		};
		return makeField<
			"json",
			readonly string[],
			S["infer"],
			JsonEntityStorageMeta<Meta>
		>(input);
	},
	enum: <
		const Values extends readonly [string, ...string[]],
		const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta,
	>(
		values: Values,
		meta?: Meta,
	) => {
		const expression = enumExpression(values);
		return makeField<"enum", Values, Values[number], Meta & { type: "string" }>(
			{
				...(meta ?? ({} as Meta)),
				type: "string",
				kind: "enum",
				values,
				ark: expression,
				optionalArk: optionalExpression(expression),
			},
		);
	},
	// Schema-first principal — the accountability-STAMP analog of `field.json`. The value is the
	// `Principal` tagged string and the `ark` is the shared `principal` narrow, so a stamp column
	// (createdBy / updatedBy / by / …) validates a raw principal string BOTH at the create boundary
	// (the input schema) and on every durable read (the record schema, the store's read boundary) —
	// an untagged or unauthorizable value can never enter or leave the column. It persists as a plain
	// `string` (the tagged form IS the stored form), so retyping a `field.string` stamp column to
	// `field.principal` is a type + validation change, NOT a migration.
	principal: <
		const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta,
	>(
		meta?: Meta,
	) =>
		makeField<
			"principal",
			readonly string[],
			Principal,
			Meta & { type: "string" }
		>({
			...(meta ?? ({} as Meta)),
			type: "string",
			kind: "principal",
			ark: principalSchema,
			optionalArk: principalSchema.or("undefined"),
		}),
};

// Materialize a field's ark DEFINITION as a Type: an arktype Type is its own callable and passes
// through untouched (never re-parsed — schema-first morph roots included); string expressions and
// literal definitions go through the one generic `type()` call, whose typed overloads can't accept
// an `unknown` definition — hence the single cast alias.
const parseDefinition = ark as unknown as (definition: unknown) => Type;
function materializeArk(definition: unknown): Type {
	return typeof definition === "function"
		? (definition as Type)
		: parseDefinition(definition);
}

/**
 * A doc-carrying field materialized as an arktype Type with its docs attached. `description`
 * describes the INNER type BEFORE the `| undefined` union: a required-field error then reads
 * "must be <description>", an optional union keeps arktype's branch rendering ("… or undefined",
 * unchanged from an undocumented field), and JSON-Schema emission carries the description on the
 * typed branch instead of spamming the union wrapper. `doc` configures the euroclaw meta channel
 * on the FULL property type — `docOf` reads it off exactly what the derived shape holds. The
 * optional form composes from `ark` (every builder constructs `optionalArk` as `ark | undefined`,
 * so this is the same union); fields without docs never reach this — they stay on the raw
 * `ark`/`optionalArk` fast path in `shapeFor`.
 */
function documentedField(field: EntityField, optional: boolean): Type {
	let materialized = materializeArk(field.ark);
	if (field.description !== undefined) {
		materialized = materialized.describe(field.description);
	}
	if (optional) materialized = materialized.or("undefined");
	if (field.doc !== undefined) {
		materialized = materialized.configure({ euroclaw: { doc: field.doc } });
	}
	return materialized;
}

function shapeFor(
	fields: Record<string, EntityField>,
	input: {
		omit?: readonly string[];
		optional?: readonly string[];
		pick?: readonly string[];
	} = {},
): Record<string, unknown> {
	const omit = new Set(input.omit ?? []);
	const pick = input.pick ? new Set(input.pick) : undefined;
	const optional = new Set(input.optional ?? []);
	const shape: Record<string, unknown> = {};
	for (const [name, field] of Object.entries(fields)) {
		if (omit.has(name)) continue;
		if (pick && !pick.has(name)) continue;
		const required = field.required === true && !optional.has(name);
		const documented =
			field.description !== undefined || field.doc !== undefined;
		shape[required ? name : `${name}?`] = documented
			? documentedField(field, !required)
			: required
				? field.ark
				: field.optionalArk;
	}
	return shape;
}

// Parsed values never carry present-but-undefined keys: optional fields admit `| undefined` for
// caller ergonomics (flat literals — `description: maybeUndefined`), and this morph normalizes
// them away, so stores can spread parsed values straight into rows (absent stays absent at the
// adapter) instead of conditionally spreading field by field. Builds fresh — never mutates the
// caller's object. Typed T → T so the pipe is TYPE-TRANSPARENT: it rides the entity bridge cast
// below without widening it. The `as T` is sound because the morph runs on a VALIDATED value:
// required props can't hold undefined (the validator rejected that), so only optional keys drop —
// the result still satisfies T.
function dropUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as T;
}

export function entity<const Fields extends Record<string, EntityField>>(
	name: string,
	fields: Fields,
) {
	// `shapeFor` assembles the validator from each field's `ark` expression, but it returns
	// `Record<string, unknown>`, so arktype can't recover the precise shape and `.infer` would be
	// lossy. Re-annotate the (runtime-correct) validator to the field-derived record type, so every
	// caller gets a precise `EntityRecord<Fields> | ArkErrors` from `record(x)` — no cast at the parse
	// site. This single assertion is the one place that bridge lives (the dropUndefined pipe's type
	// erasure is absorbed by the same annotation).
	const record = ark(shapeFor(fields)).pipe(dropUndefined) as unknown as Type<
		EntityRecord<Fields>
	>;
	// Project each DSL field onto the storage FieldAttribute — same type, but the projection strips
	// the compile-time extras (kind/values/ark validators) so schema declarations stay serializable.
	const storage = {
		[name]: {
			fields: Object.fromEntries(
				Object.entries(fields).map(([fieldName, field]) => [
					fieldName,
					{
						type: field.type,
						required: field.required,
						unique: field.unique,
						index: field.index,
						references: field.references,
						fieldName: field.fieldName,
						input: field.input,
						returned: field.returned,
						immutable: field.immutable,
						pii: field.pii,
						retention: field.retention,
						defaultValue: field.defaultValue,
						onUpdate: field.onUpdate,
					},
				]),
			),
		},
	};
	return {
		fields,
		name,
		record,
		storage,
		schema: <
			const Options extends EntitySchemaOptions<Fields> = EmptyFieldMeta,
		>(
			input?: Options,
		) =>
			// Same bridge as `record` above: re-annotate the runtime-correct validator to the precise
			// field-derived input type, so `schema(opts)(x)` yields `EntitySchemaInput<Fields, Options>
			// | ArkErrors` with no cast at the parse site.
			ark(shapeFor(fields, input)).pipe(dropUndefined) as unknown as Type<
				EntitySchemaInput<Fields, Options>
			>,
		// The update-patch validator, derived from the fields' own `immutable`/`input` flags rather than a
		// hand-listed pick/optional set — the same source of truth the storage layer enforces (see
		// EntityUpdateInput). Every mutable, caller-facing field, all optional. The rest `omit` args drop
		// columns that are storage-mutable but not mass-assignable through THIS patch surface (e.g. the
		// claw `scope`/`scopeId` boundary, changed only by a governed sharing transition) — the omitted
		// key is then a compile error in the derived input, not a runtime override.
		updateSchema: <const Omitted extends keyof Fields & string = never>(
			...omit: Omitted[]
		) => {
			const omitted = new Set<string>(omit);
			const keys = Object.entries(fields)
				.filter(
					([key, field]) =>
						!field.immutable && field.input !== false && !omitted.has(key),
				)
				.map(([key]) => key);
			return ark(shapeFor(fields, { pick: keys, optional: keys })).pipe(
				dropUndefined,
			) as unknown as Type<EntityUpdateInput<Fields, Omitted>>;
		},
	};
}
