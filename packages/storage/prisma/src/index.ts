/**
 * @busyclaw/storage-prisma — the @busyclaw/storage-core Adapter port over a Prisma client.
 * Structurally typed (no `@prisma/client` dependency) — pass your generated `PrismaClient`.
 * `consumeOne` runs find + delete-by-`id` inside one interactive `$transaction`.
 *
 * Modeled on Better Auth's Prisma adapter: https://github.com/better-auth/better-auth —
 * `packages/prisma-adapter`. The where/CRUD translation here is busyclaw's own, written against
 * Prisma's public delegate API. MIT, © 2024-present Bereket Engida. See THIRD_PARTY_NOTICES.md.
 */

import type { Adapter, Where, WhereClause } from "@busyclaw/contracts";
import {
	configurationError,
	isWhereGroup,
	sortByList,
} from "@busyclaw/contracts";

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

/**
 * Which connectors treat a backslash as LIKE's escape character, so a literal `%` or `_` can be
 * expressed at all.
 *
 * Postgres, MySQL and SQL Server all default to backslash. SQLite deliberately does NOT have a
 * default escape character — it only honours one supplied by an explicit `ESCAPE` clause, and
 * Prisma's filter API has no way to emit one. That is the whole reason this list exists rather than
 * a single `escapeLike` call: the escape is not universally available through Prisma the way it is
 * through kysely and drizzle, both of which write their own `escape '\'` into the SQL.
 */
const BACKSLASH_ESCAPES: ReadonlySet<string> = new Set([
	"postgresql",
	"postgres",
	"cockroachdb",
	"mysql",
	"sqlserver",
]);

/** LIKE's wildcards, plus the escape character itself. */
const WILDCARD = /[%_\\]/;

const escapeLike = (value: string): string =>
	value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * A pattern operand, escaped where the connector allows it and REFUSED where it does not.
 *
 * The bug this closes: a value reaching `contains` is user input — a search box, a tool argument, an
 * agent's own text — and Prisma forwards it into LIKE untouched. So `contains: "a_c"` matched `abc`
 * and `contains: "100% d"` matched `100 done`: the caller's filter silently widened, and on this
 * adapter alone. kysely and drizzle escape and declare `ESCAPE '\'`; mongo escapes regex
 * metacharacters; the memory adapter uses `String.includes`, where a wildcard cannot exist.
 *
 * VALUES WITHOUT A WILDCARD ARE UNTOUCHED, which is nearly all of them — so the throw below can only
 * be reached by a caller who genuinely asked for a literal `%`, `_` or `\` on a connector that
 * cannot express one. Refusing is the honest answer there: the alternative is to keep returning rows
 * the caller did not ask for, and a wrong answer that looks right is what this started as.
 */
function patternOperand(
	w: WhereClause,
	op: "contains" | "starts_with" | "ends_with",
	provider: string | undefined,
): string {
	const raw = String(w.value);
	if (!WILDCARD.test(raw)) return raw;
	if (provider !== undefined && BACKSLASH_ESCAPES.has(provider)) {
		return escapeLike(raw);
	}
	throw configurationError(
		`storage-prisma: cannot match a literal LIKE wildcard through Prisma on ${provider ?? "an undeclared connector"} — the value for "${w.field}" contains % , _ or \\`,
		{
			field: w.field,
			operator: op,
			provider,
			reason:
				provider === undefined
					? "pass `prismaAdapter(client, { provider })` so the adapter knows whether backslash escaping applies"
					: "this connector has no default LIKE escape character and Prisma's filter API cannot emit an ESCAPE clause; use the kysely or drizzle adapter if literal wildcards must be searchable",
		},
	);
}

/**
 * Connectors on which Prisma implements `mode: "insensitive"`. Postgres and MongoDB, and that is the
 * whole list — Prisma raises a `PrismaClientValidationError` on the others rather than ignoring it.
 *
 * Undefined (the caller did not declare a provider) is treated as supported, which is today's
 * behaviour: the mode rides through and Prisma decides. Declaring the provider is what buys the
 * better answers below.
 */
const MODE_SUPPORTED: ReadonlySet<string> = new Set([
	"postgresql",
	"postgres",
	"mongodb",
]);

/** One Where clause → a Prisma where fragment. `mode: "insensitive"` rides through as Prisma's
 *  native string-filter mode where the connector has one, and is otherwise handled below. */
function clause(
	w: WhereClause,
	provider: string | undefined,
): Record<string, unknown> {
	const op = w.operator ?? "eq";
	const wantsInsensitive =
		w.mode === "insensitive" && typeof w.value === "string";
	const nativeMode = provider === undefined || MODE_SUPPORTED.has(provider);
	// WITHOUT A NATIVE MODE, the pattern operators still come out right and equality cannot.
	//
	// `contains`/`startsWith`/`endsWith` become LIKE, and on exactly the connectors that lack `mode`
	// — SQLite, and MySQL under its default `_ci` collation — LIKE is ALREADY case-insensitive for
	// ASCII. So dropping the unsupported flag yields the requested comparison rather than an error;
	// keeping it turned a legal query into a crash.
	//
	// `equals` has no such luck: it is a plain `=`, and there is no per-query way to fold it. Refusing
	// is the honest answer, for the same reason the wildcard case refuses — the alternative is to
	// silently answer a case-SENSITIVE question the caller did not ask.
	const isPattern =
		op === "contains" || op === "starts_with" || op === "ends_with";
	if (wantsInsensitive && !nativeMode && !isPattern) {
		throw configurationError(
			`storage-prisma: case-insensitive "${op}" is not expressible through Prisma on ${provider}`,
			{
				field: w.field,
				operator: op,
				provider,
				reason:
					'Prisma implements `mode: "insensitive"` on postgresql and mongodb only; use a pattern operator, a case-folded column, or the kysely/drizzle adapter',
			},
		);
	}
	const mode = wantsInsensitive && nativeMode ? { mode: "insensitive" } : {};
	if (op === "eq") {
		return "mode" in mode
			? { [w.field]: { equals: w.value, ...mode } }
			: { [w.field]: w.value };
	}
	if (op === "ne") return { [w.field]: { not: w.value, ...mode } };
	if (op === "contains" || op === "starts_with" || op === "ends_with") {
		return {
			[w.field]: {
				[PRISMA_OP[op]]: patternOperand(w, op, provider),
				...mode,
			},
		};
	}
	return { [w.field]: { [PRISMA_OP[op]]: w.value, ...mode } };
}

/** A where tree → a Prisma where: left-fold by each node's connector; a group nests under its own
 *  AND/OR. An empty group fails loud (never a silent match-all/match-none).
 *
 *  `provider` is the datasource this client is pointed at, and it is consulted for exactly one
 *  question — whether a literal LIKE wildcard can be escaped. See {@link patternOperand}. */
export function toWhere(
	where: Where[],
	provider?: string,
): Record<string, unknown> {
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
				[isAnd ? "AND" : "OR"]: members.map((member) =>
					toWhere([member], provider),
				),
			};
		} else {
			c = clause(w, provider);
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

export type PrismaAdapterOptions = {
	/**
	 * The datasource provider this client is pointed at, as `schema.prisma` spells it
	 * (`postgresql`, `mysql`, `sqlite`, …).
	 *
	 * Consulted for one question only: whether a literal `%` or `_` in a `contains`/`starts_with`/
	 * `ends_with` value can be escaped. Left unset, a value carrying a wildcard is REFUSED rather
	 * than silently widened — see {@link patternOperand}. Every other query is unaffected, so this
	 * stays optional.
	 */
	provider?: string;
};

/** Adapt a Prisma client to the storage Adapter port — model names are the client's delegate keys. */
export function prismaAdapter(
	prisma: PrismaLike,
	options: PrismaAdapterOptions = {},
): Adapter {
	/** The where translator, bound to this client's connector once. */
	const whereFor = (where: Where[]): Record<string, unknown> =>
		toWhere(where, options.provider);
	return {
		id: "prisma",

		async create({ model, data }) {
			return (await delegate(prisma, model).create({ data })) as never;
		},

		async findOne({ model, where }) {
			return ((await delegate(prisma, model).findFirst({
				where: whereFor(where),
			})) ?? null) as never;
		},

		async findMany({ model, where, limit, offset, sortBy }) {
			return (await delegate(prisma, model).findMany({
				where: whereFor(where ?? []),
				orderBy: sortByList(sortBy).map((sort) => ({
					[sort.field]: sort.direction,
				})),
				take: limit,
				skip: offset,
			})) as never;
		},

		async count({ model, where }) {
			return delegate(prisma, model).count({ where: whereFor(where ?? []) });
		},

		// Prisma's `update`/`delete` require a unique where; the generic Where[] uses updateMany/deleteMany.
		async update({ model, where, update }) {
			const d = delegate(prisma, model);
			const before = await d.findFirst<{ id?: string | number }>({
				where: whereFor(where),
			});
			if (!before) return null;
			const id = before.id;
			if (id === undefined || id === null) return null;
			const conditionalWhere = andWhere({ id }, whereFor(where));
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
					where: whereFor(where),
					data: update,
				})
			).count;
		},

		async delete({ model, where }) {
			const d = delegate(prisma, model);
			const before = await d.findFirst<{ id?: string | number }>({
				where: whereFor(where),
			});
			const id = before?.id;
			if (id === undefined || id === null) return;
			await d.deleteMany({ where: andWhere({ id }, whereFor(where)) });
		},

		async deleteMany({ model, where }) {
			return (
				await delegate(prisma, model).deleteMany({ where: whereFor(where) })
			).count;
		},

		async consumeOne({ model, where }) {
			return (await prisma.$transaction(async (tx) => {
				const row = await delegate(tx, model).findFirst<{
					id?: string | number;
				}>({
					where: whereFor(where),
				});
				if (!row) return null;
				const id = row.id;
				if (id === undefined || id === null) return null;
				// Only the tx whose delete actually removed the row "wins" — race-safe even if two
				// transactions both read it before either deletes (the loser sees count 0 → null).
				const { count } = await delegate(tx, model).deleteMany({
					where: andWhere({ id }, whereFor(where)),
				});
				return count === 1 ? row : null;
			})) as never;
		},

		async transaction(fn) {
			return prisma.$transaction((tx) => fn(prismaAdapter(tx)));
		},
	};
}

// The schema GENERATOR — SchemaDeclaration → Prisma models. Beside the adapter because its syntax
// and its rules (every model needs an identifier) are Prisma's; `busyclaw db generate --target
// prisma` dispatches here. Emits only; `prisma migrate` owns the migration.
export type { PrismaGenerateOptions } from "./generate";
export { generatePrismaSchema } from "./generate";
