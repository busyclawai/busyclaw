import type { WhereClause } from "@euroclaw/contracts";
import {
	configurationError,
	errorMessage,
	isWhereGroup,
	sortByList,
	validationError,
} from "@euroclaw/contracts";
import type {
	Adapter,
	FieldAttribute,
	SchemaDeclaration,
	SortBy,
	Where,
} from "./index";

export type SchemaAdapterOptions = {
	/** Store JSON fields as serialized text by default; use native only when the backing adapter returns native JSON. */
	json?: "string" | "native";
	/** Unknown models/fields fail by default instead of silently bypassing schema transforms. */
	strict?: boolean;
};

type FieldMapping = {
	logical: string;
	physical: string;
	meta: FieldAttribute;
};

type ModelMapping = {
	logical: string;
	physical: string;
	fields: Record<string, FieldMapping>;
	fieldsByPhysical: Record<string, FieldMapping>;
};

type PreparedSchema = Record<string, ModelMapping>;

function prepareSchema(schema: SchemaDeclaration): PreparedSchema {
	const out: PreparedSchema = {};
	const physicalModels = new Map<string, string>();
	for (const [logicalModel, table] of Object.entries(schema)) {
		if (!logicalModel) {
			throw configurationError("storage schema contains an empty model name");
		}
		const physicalModel = table.modelName ?? logicalModel;
		const existingModel = physicalModels.get(physicalModel);
		if (existingModel && existingModel !== logicalModel) {
			throw configurationError("storage schema maps two models to one table", {
				model: logicalModel,
				otherModel: existingModel,
				modelName: physicalModel,
			});
		}
		physicalModels.set(physicalModel, logicalModel);

		const fields: Record<string, FieldMapping> = {};
		const fieldsByPhysical: Record<string, FieldMapping> = {};
		for (const [logicalField, meta] of Object.entries(table.fields)) {
			const physicalField = meta.fieldName ?? logicalField;
			if (fieldsByPhysical[physicalField]) {
				throw configurationError(
					"storage schema maps two fields to one column",
					{
						model: logicalModel,
						field: logicalField,
						otherField: fieldsByPhysical[physicalField]?.logical,
						fieldName: physicalField,
					},
				);
			}
			const mapping = {
				logical: logicalField,
				physical: physicalField,
				meta,
			} satisfies FieldMapping;
			fields[logicalField] = mapping;
			fieldsByPhysical[physicalField] = mapping;
		}
		out[logicalModel] = {
			logical: logicalModel,
			physical: physicalModel,
			fields,
			fieldsByPhysical,
		};
	}
	return out;
}

function applyFieldDefault(meta: FieldAttribute): unknown {
	return typeof meta.defaultValue === "function"
		? (meta.defaultValue as () => unknown)()
		: meta.defaultValue;
}

function encodeJsonValue(value: unknown, label: string): string {
	try {
		const json = JSON.stringify(value);
		if (typeof json !== "string") {
			throw validationError(label, "must be JSON-serializable");
		}
		return json;
	} catch (err) {
		if (err instanceof Error && err.name === "EuroclawError") throw err;
		throw validationError(label, errorMessage(err));
	}
}

function decodeJsonValue(value: unknown, label: string): unknown {
	if (typeof value !== "string") {
		throw validationError(label, "expected serialized JSON string");
	}
	try {
		return JSON.parse(value) as unknown;
	} catch (err) {
		throw validationError(label, errorMessage(err));
	}
}

function encodeFieldValue(input: {
	value: unknown;
	field: FieldMapping;
	jsonMode: "string" | "native";
	model: string;
}): unknown {
	if (input.value === undefined) return undefined;
	if (input.field.meta.type !== "json" || input.jsonMode === "native") {
		return input.value;
	}
	return encodeJsonValue(
		input.value,
		`storage field ${input.model}.${input.field.logical}`,
	);
}

function decodeFieldValue(input: {
	value: unknown;
	field: FieldMapping;
	jsonMode: "string" | "native";
	model: string;
}): unknown {
	if (input.value === undefined) return undefined;
	if (input.value === null && input.field.meta.required !== true)
		return undefined;
	if (input.field.meta.type !== "json" || input.jsonMode === "native") {
		return input.value;
	}
	if (input.value === null) return null;
	return decodeJsonValue(
		input.value,
		`storage field ${input.model}.${input.field.logical}`,
	);
}

function ensureKnownModel(input: {
	models: PreparedSchema;
	model: string;
	strict: boolean;
}): ModelMapping | undefined {
	const mapping = input.models[input.model];
	if (!mapping && input.strict) {
		throw configurationError("storage schema unknown model", {
			model: input.model,
		});
	}
	return mapping;
}

function ensureKnownField(input: {
	model: ModelMapping;
	field: string;
	strict: boolean;
	action: string;
}): FieldMapping | undefined {
	const mapping = input.model.fields[input.field];
	if (!mapping && input.strict) {
		throw configurationError("storage schema unknown field", {
			action: input.action,
			model: input.model.logical,
			field: input.field,
		});
	}
	return mapping;
}

function transformSelect(input: {
	model: ModelMapping | undefined;
	select: string[] | undefined;
	strict: boolean;
}): string[] | undefined {
	if (!input.select || !input.model) return input.select;
	const model = input.model;
	return input.select.map((field) => {
		const mapping = ensureKnownField({
			action: "select",
			field,
			model,
			strict: input.strict,
		});
		return mapping?.physical ?? field;
	});
}

function transformWhere(input: {
	model: ModelMapping | undefined;
	where: Where[] | undefined;
	strict: boolean;
	jsonMode: "string" | "native";
	action: string;
}): Where[] | undefined {
	if (!input.where || !input.model) return input.where;
	const model = input.model;
	const transformNode = (node: Where): Where => {
		// Groups recurse — the field mapping/encoding applies at the leaves.
		if (isWhereGroup(node)) {
			return "and" in node && node.and !== undefined
				? { ...node, and: node.and.map(transformNode) }
				: { ...node, or: (node.or ?? []).map(transformNode) };
		}
		const mapping = ensureKnownField({
			action: input.action,
			field: node.field,
			model,
			strict: input.strict,
		});
		if (!mapping) return node;
		let value = node.value;
		if (mapping.meta.type === "json" && input.jsonMode === "string") {
			if (
				Array.isArray(value) &&
				(node.operator === "in" || node.operator === "not_in")
			) {
				value = value.map((item) =>
					encodeFieldValue({
						field: mapping,
						jsonMode: input.jsonMode,
						model: model.logical,
						value: item,
					}),
				) as string[];
			} else if (value !== null) {
				value = encodeFieldValue({
					field: mapping,
					jsonMode: input.jsonMode,
					model: model.logical,
					value,
				}) as WhereClause["value"];
			}
		}
		return { ...node, field: mapping.physical, value };
	};
	return input.where.map(transformNode);
}

function transformSortBy(input: {
	model: ModelMapping | undefined;
	sortBy: SortBy | readonly SortBy[] | undefined;
	strict: boolean;
}): SortBy[] | undefined {
	if (!input.sortBy) return undefined;
	const model = input.model;
	const list = sortByList(input.sortBy);
	if (!model) return list;
	return list.map((sort) => {
		const mapping = ensureKnownField({
			action: "sortBy",
			field: sort.field,
			model,
			strict: input.strict,
		});
		return mapping ? { ...sort, field: mapping.physical } : sort;
	});
}

function transformCreateData(input: {
	model: ModelMapping | undefined;
	data: Record<string, unknown>;
	strict: boolean;
	jsonMode: "string" | "native";
}): Record<string, unknown> {
	if (!input.model) return input.data;
	for (const key of Object.keys(input.data)) {
		ensureKnownField({
			action: "create",
			field: key,
			model: input.model,
			strict: input.strict,
		});
	}
	const out: Record<string, unknown> = {};
	for (const field of Object.values(input.model.fields)) {
		let value = Object.hasOwn(input.data, field.logical)
			? input.data[field.logical]
			: undefined;
		if (value === undefined && field.meta.defaultValue !== undefined) {
			value = applyFieldDefault(field.meta);
		}
		if (field.meta.required === true && value === undefined) {
			throw validationError(
				`storage field ${input.model.logical}.${field.logical}`,
				"is required",
			);
		}
		const encoded = encodeFieldValue({
			field,
			jsonMode: input.jsonMode,
			model: input.model.logical,
			value,
		});
		if (encoded !== undefined) out[field.physical] = encoded;
	}
	return out;
}

function transformUpdateData(input: {
	model: ModelMapping | undefined;
	update: Record<string, unknown>;
	strict: boolean;
	jsonMode: "string" | "native";
}): Record<string, unknown> {
	if (!input.model) return input.update;
	for (const key of Object.keys(input.update)) {
		const mapping = ensureKnownField({
			action: "update",
			field: key,
			model: input.model,
			strict: input.strict,
		});
		if (mapping?.meta.immutable === true) {
			throw validationError(
				`storage field ${input.model.logical}.${mapping.logical}`,
				"is immutable (set at create, not updatable)",
			);
		}
	}
	const out: Record<string, unknown> = {};
	for (const field of Object.values(input.model.fields)) {
		let value = Object.hasOwn(input.update, field.logical)
			? input.update[field.logical]
			: undefined;
		if (value === undefined && field.meta.onUpdate) {
			value = field.meta.onUpdate();
		}
		const encoded = encodeFieldValue({
			field,
			jsonMode: input.jsonMode,
			model: input.model.logical,
			value,
		});
		if (encoded !== undefined) out[field.physical] = encoded;
	}
	return out;
}

function decodeRow(input: {
	model: ModelMapping | undefined;
	row: unknown;
	select?: string[];
	jsonMode: "string" | "native";
	strict: boolean;
}): Record<string, unknown> {
	if (!input.model) return input.row as Record<string, unknown>;
	if (input.row === null || typeof input.row !== "object") {
		throw validationError(
			`storage model ${input.model.logical}`,
			"expected object row",
		);
	}
	const row = input.row as Record<string, unknown>;
	const selected = input.select ? new Set(input.select) : undefined;
	const out: Record<string, unknown> = {};
	for (const field of Object.values(input.model.fields)) {
		if (field.meta.returned === false) continue;
		if (selected && !selected.has(field.logical)) continue;
		if (!Object.hasOwn(row, field.physical)) continue;
		const value = decodeFieldValue({
			field,
			jsonMode: input.jsonMode,
			model: input.model.logical,
			value: row[field.physical],
		});
		if (value !== undefined) out[field.logical] = value;
	}
	if (!input.strict) {
		for (const [key, value] of Object.entries(row)) {
			if (!input.model.fieldsByPhysical[key]) out[key] = value;
		}
	}
	return out;
}

/** The port's reads return `unknown` (honest — the DB holds whatever it holds); a row must be an
 *  object before it can be decoded. A non-object here is an adapter bug — fail loud. */
function asRow(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw configurationError("storage adapter returned a non-object row", {
			received: typeof value,
		});
	}
	return value as Record<string, unknown>;
}

/**
 * Wrap a physical Adapter with schema-aware model/field mapping, JSON encoding, defaults, and
 * on-update values. Stores keep using logical euroclaw names; the wrapped adapter talks to the
 * backing database in its physical table/column shape.
 */
export function schemaAdapter(
	adapter: Adapter,
	schema: SchemaDeclaration,
	options: SchemaAdapterOptions = {},
): Adapter {
	const models = prepareSchema(schema);
	const jsonMode = options.json ?? "string";
	const strict = options.strict ?? true;
	const runTransaction = adapter.transaction;
	const modelFor = (model: string) =>
		ensureKnownModel({ model, models, strict });

	return {
		id: `${adapter.id}:schema`,

		async create({ model, data, select }) {
			const mapped = modelFor(model);
			const row = asRow(
				await adapter.create({
					data: transformCreateData({ data, jsonMode, model: mapped, strict }),
					model: mapped?.physical ?? model,
					select: transformSelect({ model: mapped, select, strict }),
				}),
			);
			return decodeRow({
				jsonMode,
				model: mapped,
				row,
				select,
				strict,
			});
		},

		async findOne({ model, where, select }) {
			const mapped = modelFor(model);
			const row = await adapter.findOne({
				model: mapped?.physical ?? model,
				select: transformSelect({ model: mapped, select, strict }),
				where:
					transformWhere({
						action: "findOne",
						jsonMode,
						model: mapped,
						strict,
						where,
					}) ?? [],
			});
			return row == null
				? null
				: decodeRow({
						jsonMode,
						model: mapped,
						row: asRow(row),
						select,
						strict,
					});
		},

		async findMany({ model, where, limit, offset, sortBy, select }) {
			const mapped = modelFor(model);
			const rows = await adapter.findMany({
				limit,
				model: mapped?.physical ?? model,
				offset,
				select: transformSelect({ model: mapped, select, strict }),
				sortBy: transformSortBy({ model: mapped, sortBy, strict }),
				where: transformWhere({
					action: "findMany",
					jsonMode,
					model: mapped,
					strict,
					where,
				}),
			});
			return rows.map((row) =>
				decodeRow({ jsonMode, model: mapped, row: asRow(row), select, strict }),
			);
		},

		async count({ model, where }) {
			const mapped = modelFor(model);
			return adapter.count({
				model: mapped?.physical ?? model,
				where: transformWhere({
					action: "count",
					jsonMode,
					model: mapped,
					strict,
					where,
				}),
			});
		},

		async update({ model, where, update }) {
			const mapped = modelFor(model);
			const row = await adapter.update({
				model: mapped?.physical ?? model,
				update: transformUpdateData({
					jsonMode,
					model: mapped,
					strict,
					update,
				}),
				where:
					transformWhere({
						action: "update",
						jsonMode,
						model: mapped,
						strict,
						where,
					}) ?? [],
			});
			return row == null
				? null
				: decodeRow({ jsonMode, model: mapped, row: asRow(row), strict });
		},

		async updateMany({ model, where, update }) {
			const mapped = modelFor(model);
			return adapter.updateMany({
				model: mapped?.physical ?? model,
				update: transformUpdateData({
					jsonMode,
					model: mapped,
					strict,
					update,
				}),
				where:
					transformWhere({
						action: "updateMany",
						jsonMode,
						model: mapped,
						strict,
						where,
					}) ?? [],
			});
		},

		async delete({ model, where }) {
			const mapped = modelFor(model);
			await adapter.delete({
				model: mapped?.physical ?? model,
				where:
					transformWhere({
						action: "delete",
						jsonMode,
						model: mapped,
						strict,
						where,
					}) ?? [],
			});
		},

		async deleteMany({ model, where }) {
			const mapped = modelFor(model);
			return adapter.deleteMany({
				model: mapped?.physical ?? model,
				where:
					transformWhere({
						action: "deleteMany",
						jsonMode,
						model: mapped,
						strict,
						where,
					}) ?? [],
			});
		},

		async consumeOne({ model, where }) {
			const mapped = modelFor(model);
			const row = await adapter.consumeOne({
				model: mapped?.physical ?? model,
				where:
					transformWhere({
						action: "consumeOne",
						jsonMode,
						model: mapped,
						strict,
						where,
					}) ?? [],
			});
			return row == null
				? null
				: decodeRow({ jsonMode, model: mapped, row: asRow(row), strict });
		},

		transaction: runTransaction
			? <R>(fn: (tx: Adapter) => Promise<R>) =>
					runTransaction((tx) => fn(schemaAdapter(tx, schema, options)))
			: undefined,
	};
}
