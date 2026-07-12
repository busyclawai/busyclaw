/**
 * @euroclaw/storage-prisma — the @euroclaw/storage-core Adapter port over a Prisma client.
 * Structurally typed (no `@prisma/client` dependency) — pass your generated `PrismaClient`.
 * `consumeOne` runs find + delete-by-`id` inside one interactive `$transaction`.
 *
 * Modeled on Better Auth's Prisma adapter: https://github.com/better-auth/better-auth —
 * `packages/prisma-adapter`. The where/CRUD translation here is euroclaw's own, written against
 * Prisma's public delegate API. MIT, © 2024-present Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import type { Adapter, Where, WhereClause } from "@euroclaw/contracts";
import {
	configurationError,
	isWhereGroup,
	sortByList,
} from "@euroclaw/contracts";

/** The subset of a Prisma model delegate this adapter uses (your generated client satisfies it). */
export type PrismaDelegate = {
	create: <T = unknown>(args: { data: unknown }) => Promise<T>;
	findFirst: <T = unknown>(args: { where?: unknown }) => Promise<T | null>;
	findMany: <T = unknown>(args: {
		where?: unknown;
		orderBy?: unknown;
		take?: number;
		skip?: number;
	}) => Promise<T[]>;
	updateMany: (args: {
		where?: unknown;
		data: unknown;
	}) => Promise<{ count: number }>;
	deleteMany: (args: { where?: unknown }) => Promise<{ count: number }>;
	count: (args: { where?: unknown }) => Promise<number>;
};

/** The subset of a Prisma client this adapter uses: interactive transactions + model delegates. */
export type PrismaLike = {
	$transaction: <R>(fn: (tx: PrismaLike) => Promise<R>) => Promise<R>;
};

const PRISMA_OP = {
	lt: "lt",
	lte: "lte",
	gt: "gt",
	gte: "gte",
	in: "in",
	not_in: "notIn",
	contains: "contains",
	starts_with: "startsWith",
	ends_with: "endsWith",
} as const;

/** One Where clause → a Prisma where fragment. `mode: "insensitive"` rides through as Prisma's
 *  native string-filter mode (support depends on the connector — postgres/mongo yes, sqlite no). */
function clause(w: WhereClause): Record<string, unknown> {
	const op = w.operator ?? "eq";
	const mode =
		w.mode === "insensitive" && typeof w.value === "string"
			? { mode: "insensitive" }
			: {};
	if (op === "eq") {
		return "mode" in mode
			? { [w.field]: { equals: w.value, ...mode } }
			: { [w.field]: w.value };
	}
	if (op === "ne") return { [w.field]: { not: w.value, ...mode } };
	return { [w.field]: { [PRISMA_OP[op]]: w.value, ...mode } };
}

/** A where tree → a Prisma where: left-fold by each node's connector; a group nests under its own
 *  AND/OR. An empty group fails loud (never a silent match-all/match-none). */
export function toWhere(where: Where[]): Record<string, unknown> {
	let combined: Record<string, unknown> | undefined;
	for (const w of where) {
		let c: Record<string, unknown>;
		if (isWhereGroup(w)) {
			const isAnd = "and" in w && w.and !== undefined;
			const members = isAnd ? (w.and ?? []) : (w.or ?? []);
			if (members.length === 0) {
				throw configurationError("storage-prisma: where group is empty", {});
			}
			c = {
				[isAnd ? "AND" : "OR"]: members.map((member) => toWhere([member])),
			};
		} else {
			c = clause(w);
		}
		combined =
			combined === undefined
				? c
				: { [w.connector === "OR" ? "OR" : "AND"]: [combined, c] };
	}
	return combined ?? {};
}

function andWhere(
	...clauses: Record<string, unknown>[]
): Record<string, unknown> {
	return { AND: clauses };
}

const delegate = (p: PrismaLike, name: string): PrismaDelegate => {
	const d = (p as unknown as Record<string, PrismaDelegate>)[name];
	if (!d)
		throw configurationError(
			`storage-prisma: unknown model "${name}" on the Prisma client`,
			{ model: name },
		);
	return d;
};

/** Adapt a Prisma client to the storage Adapter port — model names are the client's delegate keys. */
export function prismaAdapter(prisma: PrismaLike): Adapter {
	return {
		id: "prisma",

		async create({ model, data }) {
			return (await delegate(prisma, model).create({ data })) as never;
		},

		async findOne({ model, where }) {
			return ((await delegate(prisma, model).findFirst({
				where: toWhere(where),
			})) ?? null) as never;
		},

		async findMany({ model, where, limit, offset, sortBy }) {
			return (await delegate(prisma, model).findMany({
				where: toWhere(where ?? []),
				orderBy: sortByList(sortBy).map((sort) => ({
					[sort.field]: sort.direction,
				})),
				take: limit,
				skip: offset,
			})) as never;
		},

		async count({ model, where }) {
			return delegate(prisma, model).count({ where: toWhere(where ?? []) });
		},

		// Prisma's `update`/`delete` require a unique where; the generic Where[] uses updateMany/deleteMany.
		async update({ model, where, update }) {
			const d = delegate(prisma, model);
			const before = await d.findFirst<{ id?: string | number }>({
				where: toWhere(where),
			});
			if (!before) return null;
			const id = before.id;
			if (id === undefined || id === null) return null;
			const conditionalWhere = andWhere({ id }, toWhere(where));
			const { count } = await d.updateMany({
				where: conditionalWhere,
				data: update,
			});
			if (count < 1) return null;
			return ((await d.findFirst({
				where: { id },
			})) ?? null) as never;
		},

		async updateMany({ model, where, update }) {
			return (
				await delegate(prisma, model).updateMany({
					where: toWhere(where),
					data: update,
				})
			).count;
		},

		async delete({ model, where }) {
			const d = delegate(prisma, model);
			const before = await d.findFirst<{ id?: string | number }>({
				where: toWhere(where),
			});
			const id = before?.id;
			if (id === undefined || id === null) return;
			await d.deleteMany({ where: andWhere({ id }, toWhere(where)) });
		},

		async deleteMany({ model, where }) {
			return (
				await delegate(prisma, model).deleteMany({ where: toWhere(where) })
			).count;
		},

		async consumeOne({ model, where }) {
			return (await prisma.$transaction(async (tx) => {
				const row = await delegate(tx, model).findFirst<{
					id?: string | number;
				}>({
					where: toWhere(where),
				});
				if (!row) return null;
				const id = row.id;
				if (id === undefined || id === null) return null;
				// Only the tx whose delete actually removed the row "wins" — race-safe even if two
				// transactions both read it before either deletes (the loser sees count 0 → null).
				const { count } = await delegate(tx, model).deleteMany({
					where: andWhere({ id }, toWhere(where)),
				});
				return count === 1 ? row : null;
			})) as never;
		},

		async transaction(fn) {
			return prisma.$transaction((tx) => fn(prismaAdapter(tx)));
		},
	};
}
