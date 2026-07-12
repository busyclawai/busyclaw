// The entity-validating storage layer — the fix for the Adapter port's unchecked generics.
// `db.findOne<SomeRecord>(…)` types a row on the caller's say-so: the type parameter and the model
// string are uncorrelated, so nothing stops `findOne<ApprovalRecord>({ model: "registered_tool" })`,
// and the row is never checked against the claimed type. Here the type is COMPUTED from the model
// argument (`findOne({ model: "approval" })` returns the approval record type) and made TRUE at
// runtime: every row crossing back from the adapter is parsed through the model's derived record
// schema — the generalization of the hand-rolled `validateRecord` pattern the durable stores grew.
//
// Three exports, two layers:
//   entityAdapter — the RUNTIME layer: Adapter-shaped, wraps schemaAdapter (storage projection
//     derived from the same fields), validates create data (write schema) and every returned row
//     (read schema = fields minus `returned: false`, matching what decodeRow strips). Carries an
//     `entityModels` marker so the typed lens can verify it wraps a validating adapter. This is
//     what the assembly hands plugins as the configure-context adapter.
//   entityView — the STATIC layer: a zero-cost typed lens over an entity-validating adapter for
//     the models a caller owns. Pure type refinement + a fail-loud membership check, so a plugin
//     store naming a model it forgot to declare in `plugin.schema` fails at configure time, not at
//     first read. The one bridge cast below is made honest by entityAdapter's runtime validation.
//   entityDb — both in one call, for owners of a RAW adapter (the durable stores, the sql engine).

import type {
	Adapter,
	EntityField,
	EntityRecord,
	SchemaDeclaration,
	WhereClause,
} from "@euroclaw/contracts";
import {
	configurationError,
	entity,
	validationError,
} from "@euroclaw/contracts";
import { type } from "arktype";
import { type SchemaAdapterOptions, schemaAdapter } from "./schema-adapter";

/** What a model contributes: its entity DSL fields (an `entity()` object satisfies this shape),
 *  plus an optional physical table-name override (the SchemaDeclaration `modelName` passthrough). */
export type EntityModelMap = Record<
	string,
	{ fields: Record<string, EntityField>; modelName?: string }
>;

/** The read view of a field map: `returned: false` columns never come back from the adapter
 *  (decodeRow drops them), so they are absent from read records and read validation alike. */
type ReadFields<Fields extends Record<string, EntityField>> = {
	[K in keyof Fields as Fields[K]["returned"] extends false
		? never
		: K]: Fields[K];
};

export type EntityReadRecord<Fields extends Record<string, EntityField>> =
	EntityRecord<ReadFields<Fields>>;

/** A single predicate whose field name must belong to the model. */
export type EntityWhereClause<Fields> = Omit<WhereClause, "field"> & {
	field: keyof Fields & string;
};

/** A where node whose field names must belong to the model — a typo'd column is a compile error.
 *  Mirrors the port's Where tree: a clause, or a nested and/or group of further typed nodes. */
export type EntityWhere<Fields> =
	| EntityWhereClause<Fields>
	| {
			and: readonly EntityWhere<Fields>[];
			or?: never;
			connector?: "AND" | "OR";
	  }
	| {
			or: readonly EntityWhere<Fields>[];
			and?: never;
			connector?: "AND" | "OR";
	  };

export type EntitySortBy<Fields> = {
	field: keyof Fields & string;
	direction: "asc" | "desc";
};

/** An update patch: any subset of the model's columns; `null` clears a column at the adapter. */
export type EntityPatch<Fields extends Record<string, EntityField>> = {
	[K in keyof EntityRecord<Fields>]?: EntityRecord<Fields>[K] | null;
};

/**
 * The typed, validated store surface over a set of entity models. Method types are computed from
 * the `model` argument; runtime validation (in entityAdapter) makes them true.
 */
export type EntityDb<Models extends EntityModelMap> = {
	id: string;
	/** The registered model names — the marker entityView verifies. */
	entityModels: ReadonlySet<string>;
	create: <M extends keyof Models & string>(input: {
		model: M;
		data: EntityRecord<Models[M]["fields"]>;
	}) => Promise<EntityReadRecord<Models[M]["fields"]>>;
	findOne: <M extends keyof Models & string>(input: {
		model: M;
		where: readonly EntityWhere<Models[M]["fields"]>[];
	}) => Promise<EntityReadRecord<Models[M]["fields"]> | null>;
	findMany: <M extends keyof Models & string>(input: {
		model: M;
		where?: readonly EntityWhere<Models[M]["fields"]>[];
		limit?: number;
		offset?: number;
		sortBy?:
			| EntitySortBy<Models[M]["fields"]>
			| readonly EntitySortBy<Models[M]["fields"]>[];
	}) => Promise<EntityReadRecord<Models[M]["fields"]>[]>;
	count: <M extends keyof Models & string>(input: {
		model: M;
		where?: readonly EntityWhere<Models[M]["fields"]>[];
	}) => Promise<number>;
	/** The patch is field-typed but NOT parsed — stores stamp server-managed columns a caller-input
	 *  schema excludes. The RESULT row is read-validated, so a malformed patch still fails loud. */
	update: <M extends keyof Models & string>(input: {
		model: M;
		where: readonly EntityWhere<Models[M]["fields"]>[];
		update: EntityPatch<Models[M]["fields"]>;
	}) => Promise<EntityReadRecord<Models[M]["fields"]> | null>;
	updateMany: <M extends keyof Models & string>(input: {
		model: M;
		where: readonly EntityWhere<Models[M]["fields"]>[];
		update: EntityPatch<Models[M]["fields"]>;
	}) => Promise<number>;
	delete: <M extends keyof Models & string>(input: {
		model: M;
		where: readonly EntityWhere<Models[M]["fields"]>[];
	}) => Promise<void>;
	deleteMany: <M extends keyof Models & string>(input: {
		model: M;
		where: readonly EntityWhere<Models[M]["fields"]>[];
	}) => Promise<number>;
	consumeOne: <M extends keyof Models & string>(input: {
		model: M;
		where: readonly EntityWhere<Models[M]["fields"]>[];
	}) => Promise<EntityReadRecord<Models[M]["fields"]> | null>;
	transaction?: <R>(fn: (tx: EntityDb<Models>) => Promise<R>) => Promise<R>;
};

/** An Adapter that validates rows against registered entity models (entityAdapter's return). */
export type EntityValidatedAdapter = Adapter & {
	entityModels: ReadonlySet<string>;
};

// Runtime-callable view of an arktype validator — the record schemas are precisely typed at their
// definition sites; this layer only needs "call it, check for errors".
type Validator = (value: unknown) => unknown;

type ModelValidators = {
	names: ReadonlySet<string>;
	read: ReadonlyMap<string, Validator>;
	write: ReadonlyMap<string, Validator>;
};

function readFieldsOf(
	fields: Record<string, EntityField>,
): Record<string, EntityField> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, field]) => field.returned !== false),
	);
}

function parseWith(
	validators: ModelValidators,
	side: "read" | "write",
	model: string,
	value: unknown,
): unknown {
	const validator = (side === "read" ? validators.read : validators.write).get(
		model,
	);
	if (!validator) {
		throw configurationError(
			`model "${model}" is not registered with the entity adapter`,
			{ model, registered: [...validators.names] },
		);
	}
	const parsed = validator(value);
	if (parsed instanceof type.errors) {
		throw validationError(`${model} record invalid`, parsed.summary, {
			model,
		});
	}
	return parsed;
}

function ensureModel(validators: ModelValidators, model: string): void {
	if (!validators.names.has(model)) {
		throw configurationError(
			`model "${model}" is not registered with the entity adapter`,
			{ model, registered: [...validators.names] },
		);
	}
}

// The validating wrapper over an already-schema-aware adapter. Split from entityAdapter so the
// transaction path can re-wrap a tx adapter without re-deriving schemas.
function withValidation(
	inner: Adapter,
	validators: ModelValidators,
): EntityValidatedAdapter {
	const runTransaction = inner.transaction;
	return {
		id: inner.id,
		entityModels: validators.names,

		async create({ model, data, select }) {
			// Writes are validated as full records BEFORE they go down (the parse also drops
			// present-but-undefined keys, so absent stays absent at the adapter).
			const valid = parseWith(validators, "write", model, data) as Record<
				string,
				unknown
			>;
			const row = await inner.create({ model, data: valid, select });
			return parseWith(validators, "read", model, row);
		},

		async findOne(input) {
			const row = await inner.findOne(input);
			return row == null
				? null
				: parseWith(validators, "read", input.model, row);
		},

		async findMany(input) {
			const rows = await inner.findMany(input);
			return rows.map((row) => parseWith(validators, "read", input.model, row));
		},

		async count(input) {
			ensureModel(validators, input.model);
			return inner.count(input);
		},

		async update(input) {
			const row = await inner.update(input);
			return row == null
				? null
				: parseWith(validators, "read", input.model, row);
		},

		async updateMany(input) {
			ensureModel(validators, input.model);
			return inner.updateMany(input);
		},

		async delete(input) {
			ensureModel(validators, input.model);
			await inner.delete(input);
		},

		async deleteMany(input) {
			ensureModel(validators, input.model);
			return inner.deleteMany(input);
		},

		async consumeOne(input) {
			const row = await inner.consumeOne(input);
			return row == null
				? null
				: parseWith(validators, "read", input.model, row);
		},

		transaction: runTransaction
			? <R>(fn: (tx: Adapter) => Promise<R>) =>
					runTransaction((tx) => fn(withValidation(tx, validators)))
			: undefined,
	};
}

/**
 * Wrap a raw Adapter with schema-aware mapping (schemaAdapter, storage projection derived from the
 * same fields) plus per-model row validation. Adapter-shaped — this is what the assembly wraps once
 * over the merged core+plugin models and hands plugins through the configure context; callers with
 * statically-known models get precise types via entityView / entityDb.
 */
export function entityAdapter(
	adapter: Adapter,
	models: EntityModelMap,
	options: SchemaAdapterOptions = {},
): EntityValidatedAdapter {
	const storage: SchemaDeclaration = {};
	const read = new Map<string, Validator>();
	const write = new Map<string, Validator>();
	for (const [name, model] of Object.entries(models)) {
		const built = entity(name, model.fields);
		for (const [tableName, table] of Object.entries(built.storage)) {
			storage[tableName] =
				model.modelName === undefined
					? table
					: { ...table, modelName: model.modelName };
		}
		write.set(name, built.record as Validator);
		read.set(
			name,
			entity(name, readFieldsOf(model.fields)).record as Validator,
		);
	}
	const validators: ModelValidators = {
		names: new Set(read.keys()),
		read,
		write,
	};
	return withValidation(schemaAdapter(adapter, storage, options), validators);
}

/**
 * The typed lens over an entity-validating adapter, for the models the caller owns. Zero runtime
 * cost beyond a fail-loud membership check — validation already lives in entityAdapter. A plugin
 * store opens this over the configure-context adapter with its own field maps.
 */
export function entityView<const Models extends EntityModelMap>(
	adapter: Adapter,
	models: Models,
): EntityDb<Models> {
	const marker = (adapter as { entityModels?: unknown }).entityModels;
	if (!(marker instanceof Set)) {
		throw configurationError(
			"entityView requires an entity-validating adapter (see entityAdapter)",
			{ adapter: adapter.id },
		);
	}
	for (const model of Object.keys(models)) {
		if (!marker.has(model)) {
			throw configurationError(
				`model "${model}" is not registered with the entity adapter`,
				{ model, registered: [...marker] as string[] },
			);
		}
	}
	// The bridge between the Adapter-shaped runtime object and the model-keyed static surface —
	// sound because entityAdapter validates every row against exactly these models' schemas.
	return adapter as unknown as EntityDb<Models>;
}

/**
 * entityAdapter + entityView in one call — for owners of a RAW adapter (the durable stores, the
 * sql engine), replacing `schemaAdapter(adapter, schema)` + hand-rolled read validation.
 */
export function entityDb<const Models extends EntityModelMap>(
	adapter: Adapter,
	models: Models,
	options: SchemaAdapterOptions = {},
): EntityDb<Models> {
	return entityView(entityAdapter(adapter, models, options), models);
}
