/**
 * @busyclaw/storage-mongodb — the @busyclaw/storage-core Adapter port over a MongoDB database.
 * `consumeOne` uses Mongo's native atomic `findOneAndDelete` — no transaction needed.
 *
 * Modeled on Better Auth's MongoDB adapter: https://github.com/better-auth/better-auth —
 * `packages/mongo-adapter`. The filter/CRUD translation here is busyclaw's own, written against
 * the mongodb driver's public API. MIT, © 2024-present Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import type { Adapter, Where, WhereClause } from "@busyclaw/contracts";
import {
	configurationError,
	isWhereGroup,
	sortByList,
} from "@busyclaw/contracts";
import type { Db, Document, Filter, Sort } from "mongodb";
import { assertMongoIndexes } from "./verify";

const MONGO_OP = {
	ne: "$ne",
	lt: "$lt",
	lte: "$lte",
	gt: "$gt",
	gte: "$gte",
	in: "$in",
	not_in: "$nin",
} as const;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertFieldName(field: string): void {
	if (field.startsWith("$") || field.includes(".") || field.includes("\0")) {
		throw new Error(`storage-mongodb: invalid field name "${field}"`);
	}
}

function assertUpdateKeys(update: Record<string, unknown>): void {
	for (const key of Object.keys(update)) assertFieldName(key);
}

/**
 * A NEGATIVE predicate, narrowed to rows that actually have a value.
 *
 * Mongo's `$ne` and `$nin` match a document whose field is MISSING — reasonable on its own terms, and
 * the opposite of what SQL does, which is what the storage contract settled on. Left alone, "status
 * is not pending" returned every document that had never been given a status, so the same query
 * answered differently depending on which adapter the deployment happened to be wired to.
 *
 * `{ field: { $ne: null } }` is Mongo's own spelling of "present and not null" — it excludes missing
 * fields and explicit nulls together, which is exactly the one state the contract recognises.
 */
const excludingNull = (
	field: string,
	negative: Filter<Document>,
): Filter<Document> => ({ $and: [negative, { [field]: { $ne: null } }] });

/** One Where clause → a Mongo filter fragment. `mode: "insensitive"` maps to a case-insensitive
 *  anchored regex (equality) or the `i` option on the pattern operators. */
function clause(w: WhereClause): Filter<Document> {
	assertFieldName(w.field);
	const op = w.operator ?? "eq";
	// THE NULL TEST — presence, not comparison. Mongo already reads a bare `null` as "null or
	// missing", which is the single state the contract names, so these map straight across. Anything
	// else throws, matching kysely/drizzle/memory rather than inventing an ordering against null.
	if (w.value === null) {
		if (op === "eq") return { [w.field]: null };
		if (op === "ne") return { [w.field]: { $ne: null } };
		throw configurationError(
			`storage-mongodb: where operator "${op}" cannot compare null`,
			{ field: w.field, operator: op },
		);
	}
	const insensitive = w.mode === "insensitive" && typeof w.value === "string";
	const options = insensitive ? { $options: "i" } : {};
	if (op === "contains" || op === "starts_with" || op === "ends_with") {
		const escaped = escapeRegExp(String(w.value));
		const pattern =
			op === "contains"
				? escaped
				: op === "starts_with"
					? `^${escaped}`
					: `${escaped}$`;
		return { [w.field]: { $regex: pattern, ...options } };
	}
	if (insensitive && op === "eq") {
		return {
			[w.field]: { $regex: `^${escapeRegExp(String(w.value))}$`, ...options },
		};
	}
	if (insensitive && op === "ne") {
		return excludingNull(w.field, {
			[w.field]: {
				$not: { $regex: `^${escapeRegExp(String(w.value))}$`, ...options },
			},
		});
	}
	if (op === "eq") return { [w.field]: w.value };
	// `not_in []` is a CONSTANT, not a comparison: the contract fixes it as match-everything, null
	// rows included, so it must not pick up the null narrowing the other negatives get. `$nin: []`
	// already means that to Mongo — the branch exists to keep it from being wrapped.
	if (op === "not_in" && Array.isArray(w.value) && w.value.length === 0) {
		return { [w.field]: { $nin: [] } };
	}
	const fragment: Filter<Document> = { [w.field]: { [MONGO_OP[op]]: w.value } };
	return op === "ne" || op === "not_in"
		? excludingNull(w.field, fragment)
		: fragment;
}

/** A where tree → a Mongo filter: left-fold by each node's connector; a group nests under its own
 *  $and/$or. An empty group fails loud (never a silent match-all/match-none). */
export function toFilter(where: Where[]): Filter<Document> {
	let combined: Filter<Document> | undefined;
	for (const w of where) {
		let c: Filter<Document>;
		if (isWhereGroup(w)) {
			const isAnd = "and" in w && w.and !== undefined;
			const members = isAnd ? (w.and ?? []) : (w.or ?? []);
			if (members.length === 0) {
				throw configurationError("storage-mongodb: where group is empty", {});
			}
			c = {
				[isAnd ? "$and" : "$or"]: members.map((member) => toFilter([member])),
			};
		} else {
			c = clause(w);
		}
		combined =
			combined === undefined
				? c
				: { [w.connector === "OR" ? "$or" : "$and"]: [combined, c] };
	}
	return combined ?? {};
}

/** Strip Mongo's internal `_id` from a returned document (busyclaw rows carry their own `id`). */
function strip<T>(doc: Document | null): T | null {
	if (!doc) return null;
	const { _id, ...rest } = doc;
	return rest as T;
}

/** Adapt a MongoDB `Db` to the storage Adapter port. busyclaw rows carry their own `id` field. */
export function mongoAdapter(db: Db): Adapter {
	const col = (model: string) => db.collection(model);
	return {
		id: "mongodb",

		// Mongo cannot migrate, so it verifies instead — see `Adapter.verifySchema`. The ASSEMBLY
		// calls this with the merged declaration; a schema handed in at construction would be the base
		// models only, and a check that passes because it was asked the wrong question is worse than
		// no check, because someone will have read the code and believed it.
		verifySchema: (schema) => assertMongoIndexes(db, schema),

		async create({ model, data }) {
			await col(model).insertOne({ ...data });
			return data as never;
		},

		async findOne({ model, where }) {
			return strip(await col(model).findOne(toFilter(where))) as never;
		},

		async findMany({ model, where, limit, offset, sortBy }) {
			let cursor = col(model).find(toFilter(where ?? []));
			const sorts = sortByList(sortBy);
			if (sorts.length > 0) {
				const spec: Sort = {};
				for (const sort of sorts) {
					assertFieldName(sort.field);
					(spec as Record<string, 1 | -1>)[sort.field] =
						sort.direction === "desc" ? -1 : 1;
				}
				cursor = cursor.sort(spec);
			}
			if (offset) cursor = cursor.skip(offset);
			if (limit !== undefined) cursor = cursor.limit(limit);
			return (await cursor.toArray()).map((d) => strip(d)) as never;
		},

		async count({ model, where }) {
			return col(model).countDocuments(toFilter(where ?? []));
		},

		async update({ model, where, update }) {
			assertUpdateKeys(update);
			const doc = await col(model).findOneAndUpdate(
				toFilter(where),
				{ $set: update },
				{ returnDocument: "after" },
			);
			return strip(doc) as never;
		},

		async updateMany({ model, where, update }) {
			assertUpdateKeys(update);
			const r = await col(model).updateMany(toFilter(where), { $set: update });
			return r.modifiedCount;
		},

		async delete({ model, where }) {
			await col(model).deleteOne(toFilter(where));
		},

		async deleteMany({ model, where }) {
			const r = await col(model).deleteMany(toFilter(where));
			return r.deletedCount;
		},

		async consumeOne({ model, where }) {
			// Native atomic single-use: findOneAndDelete removes and returns one matching doc in one op.
			return strip(await col(model).findOneAndDelete(toFilter(where))) as never;
		},
	};
}

// The index generator — SchemaDeclaration → the `createIndex` calls a declaration implies. Mongo has
// no DDL, so uniqueness and indexing are the only things a schema can still ask it to enforce;
// `busyclaw db generate --target mongodb` dispatches here.
export type { MongoGenerateOptions, MongoIndexSpec } from "./generate";
export { generateMongoIndexes, mongoIndexes } from "./generate";
export type { MissingMongoIndex } from "./verify";
export {
	assertMongoIndexes,
	missingMongoIndexes,
	requiredMongoIndexes,
} from "./verify";
