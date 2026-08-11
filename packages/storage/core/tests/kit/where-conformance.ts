/**
 * THE WHERE/SORT CONFORMANCE KIT — one suite, every adapter.
 *
 * Five packages translate the SAME `Where` tree into five unrelated dialects (memory predicates,
 * raw Kysely SQL, Drizzle operators, a Prisma object, a Mongo filter). Nothing until now made them
 * answer the same question at the same time, so each package tested whatever its author happened to
 * think of — and the coverage came out visibly uneven (`connector` had zero mentions in the
 * storage-core and kysely suites; prisma and mongodb had one apiece for `not_in`/`starts_with`/
 * `ends_with`).
 *
 * The reason that matters more than it looks: SIXTY-FOUR test files in this repo stand on
 * `memoryAdapter`, and the memory adapter is not a database. Every governance test above it is
 * validated against a hand-written JS predicate evaluator. Wherever that evaluator disagrees with
 * the databases people actually deploy, the layer above it is proving something that is not true in
 * production.
 *
 * WHAT A FAILURE HERE MEANS. Two different things, and the per-case comments say which:
 *   - CONTRACT-STATED — `contracts/src/storage.ts` fixes the answer (empty-list semantics do this
 *     explicitly). A failure is a straightforward adapter bug.
 *   - CONTRACT-SILENT — the protocol never says, and the adapters answer differently. The failure
 *     is real but the FIX is a contract decision first: somebody has to choose the semantics before
 *     anyone edits a translator. These are marked `CONTRACT GAP`.
 *
 * The oracle is cross-implementation disagreement, which is why this suite is worth more than the
 * sum of its assertions: it needs no judgement about intent. If two adapters disagree, at least one
 * of them is wrong, and code that runs on both is already broken for somebody.
 *
 * Only `approval(id, status?)` and `audit(seq, name?)` are used. They are the shapes all five
 * backends already declare — prisma's `schema.prisma` is the binding constraint, since it is the one
 * backend that cannot invent a table at runtime.
 */

import type { Adapter, Where } from "@busyclaw/contracts";
import { afterEach, describe, expect, it } from "vitest";

export type ConformanceTarget = {
	/** The adapter under test, freshly bound to an empty backend. */
	adapter: () => Adapter;
	/** Drop every row this suite inserted. Runs after each case. */
	reset: () => Promise<void>;
	/**
	 * The storage engine underneath, for the cases whose CORRECT answer is engine-specific (null
	 * ordering in a sort is the honest example — sqlite and postgres genuinely differ, and a suite
	 * that pretended otherwise would be lying about one of them).
	 */
	backend: "memory" | "sqlite" | "mongodb";
};

type Row = Record<string, unknown>;

const ids = (rows: unknown): string[] =>
	(rows as Row[]).map((r) => String(r.id));

const statuses = (rows: unknown): unknown[] =>
	(rows as Row[]).map((r) => r.status);

export function describeWhereConformance(
	name: string,
	target: ConformanceTarget,
): void {
	describe(`where/sort conformance — ${name}`, () => {
		afterEach(async () => {
			await target.reset();
		});

		const seedApprovals = async (rows: Row[]): Promise<void> => {
			const a = target.adapter();
			for (const data of rows) await a.create({ model: "approval", data });
		};

		/**
		 * Run a query and assert it either answered exactly, or DECLINED TO GUESS.
		 *
		 * Some comparisons are genuinely inexpressible on some backends — a literal LIKE wildcard
		 * through Prisma on SQLite, a case-folded equality on a connector with no `mode`. An adapter
		 * in that position has two honest options and one dishonest one, and this encodes which is
		 * which: matching exactly is fine, refusing out loud is fine, quietly returning a wider set is
		 * the bug. The refusal must SAY what it is, so an unrelated crash cannot pass.
		 */
		const expectMatchOrRefusal = async (
			where: Where[],
			expected: string[],
		): Promise<void> => {
			let found: unknown;
			try {
				found = await target.adapter().findMany({ model: "approval", where });
			} catch (error) {
				expect(String(error)).toMatch(/wildcard|escape|insensitive/i);
				return;
			}
			expect(ids(found)).toEqual(expected);
		};

		// ── NULL comparison ──────────────────────────────────────────────────────────────────────
		//
		// CONTRACT GAP. `WhereClause["value"]` admits `null` in its union, and both the kysely and
		// drizzle translators special-case it hard enough to THROW for any operator but eq/ne
		// (`kysely/src/index.ts:65`, `drizzle/src/index.ts:93`) — so `eq null` plainly means IS NULL
		// to the people who wrote those two. The protocol itself never says so, and the memory
		// adapter reads the union literally: `v === w.value`, a JS identity check.

		it("`eq null` finds a row whose column was never written", async () => {
			// The ordinary way an optional column ends up empty: nobody set it. Postgres, sqlite and
			// mongo all answer IS NULL here. The memory adapter stores no key at all, compares
			// `undefined === null`, and answers false — so "find the rows still missing this field"
			// returns NOTHING in memory and EVERYTHING it should on a real database.
			await seedApprovals([{ id: "unset" }, { id: "set", status: "pending" }]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [{ field: "status", value: null }],
			});
			expect(ids(found)).toEqual(["unset"]);
		});

		it("`eq null` finds a row written with an explicit null", async () => {
			// The same question asked the other way. This one the memory adapter gets right
			// (`null === null`), which is precisely what makes the pair worth having: absent and null
			// are ONE state to every database and TWO states to the memory adapter, so which of these
			// two cases a caller happens to hit decides whether their code works.
			await seedApprovals([
				{ id: "explicit", status: null },
				{ id: "set", status: "pending" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [{ field: "status", value: null }],
			});
			expect(ids(found)).toEqual(["explicit"]);
		});

		it("`ne <value>` excludes a row whose column is null", async () => {
			// CONTRACT GAP, and the sharpest one in this file — the adapters split 3-vs-2.
			//
			// SQL says a NULL row is NOT `<> 'pending'`: the comparison is NULL, which is not true, so
			// the row is excluded. kysely and drizzle inherit that. Mongo's `$ne` MATCHES a missing
			// field, and the memory adapter falls through to `undefined !== "pending"` and matches too.
			//
			// Asserted as SQL semantics because three of the five backends are SQL and the durable
			// stores are written against SQL expectations — but that is an argument, not a ruling.
			// Deciding this is the actual work; editing translators is downstream of it.
			//
			// Live callers today: `engines/sql/src/store.ts:1114` (which prior runs on a thread hand
			// their unread messages to), `storage/durable/src/run-checkpoint.ts:120`, and
			// `plugins/channels/src/core/inbox.ts:614`. All three compare a column declared
			// `required: true`, so none of them is broken right now — this is a trap set for the next
			// caller who reaches for `ne` on a column that is genuinely optional.
			await seedApprovals([
				{ id: "unset" },
				{ id: "other", status: "approved" },
				{ id: "match", status: "pending" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [{ field: "status", operator: "ne", value: "pending" }],
			});
			expect(ids(found)).toEqual(["other"]);
		});

		it("`not_in [...]` excludes a row whose column is null", async () => {
			// Same divergence, reached through the other negative operator. SQL's `NOT IN` over a NULL
			// column is NULL — excluded. Mongo's `$nin` matches a missing field. Kept separate from the
			// `ne` case because an adapter can plausibly fix one and forget the other.
			await seedApprovals([
				{ id: "unset" },
				{ id: "other", status: "approved" },
				{ id: "match", status: "pending" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [{ field: "status", operator: "not_in", value: ["pending"] }],
			});
			expect(ids(found)).toEqual(["other"]);
		});

		// ── Empty-list semantics ─────────────────────────────────────────────────────────────────
		//
		// CONTRACT-STATED, verbatim: "Empty-list semantics are fixed across adapters: `in []` matches
		// nothing, `not_in []` matches everything." Three adapters emit a hand-written constant for
		// this (`1 = 0` / `1 = 1`); prisma and mongo delegate to the driver and inherit whatever it
		// decides. Cheap to assert, and the kind of thing that breaks on a dependency bump rather
		// than on a commit.

		it("`in []` matches nothing", async () => {
			await seedApprovals([{ id: "a", status: "pending" }]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [{ field: "status", operator: "in", value: [] }],
			});
			expect(ids(found)).toEqual([]);
		});

		it("`not_in []` matches every row, including one whose column is null", async () => {
			// "Matches everything" has to mean everything, or the constant is not a constant. The null
			// row is the interesting half: an adapter that emits `1 = 1` includes it, and an adapter
			// that degrades to a real `NOT IN` against an empty list does not.
			await seedApprovals([{ id: "a", status: "pending" }, { id: "unset" }]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [{ field: "status", operator: "not_in", value: [] }],
				sortBy: { field: "id", direction: "asc" },
			});
			expect(ids(found)).toEqual(["a", "unset"]);
		});

		// ── Case sensitivity ─────────────────────────────────────────────────────────────────────

		it("the DEFAULT `contains` sensitivity is the COLUMN'S, and this is what each backend does", async () => {
			// THE ONE DIVERGENCE NOBODY CAN FIX, so it is pinned rather than asserted away.
			//
			// `mode` defaults to "sensitive", and on a SQL backend that default is not the adapter's to
			// give: LIKE follows the column's collation. SQLite's is ASCII-case-insensitive unless the
			// host sets `PRAGMA case_sensitive_like`; MySQL's default `utf8mb4_0900_ai_ci` is
			// case- AND accent-insensitive; Postgres is sensitive. Making them agree would mean the
			// adapter rewriting every default `contains` into a folded comparison, which throws away the
			// index the query was shaped to use — a large, silent performance cost imposed on every
			// caller to fix a case nobody asked about.
			//
			// So the contract now says so out loud (see `WhereClause.mode`), and this case locks in what
			// each backend ACTUALLY does. It is a regression detector, not a conformance requirement:
			// if a backend's answer here changes, somebody changed a collation and every default
			// `contains` in the product quietly changed meaning with it.
			//
			// A caller who needs a defined answer passes `mode` explicitly. That one IS a requirement,
			// and it is the next case.
			await seedApprovals([
				{ id: "upper", status: "PENDING" },
				{ id: "lower", status: "pending" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [{ field: "status", operator: "contains", value: "pend" }],
				sortBy: { field: "id", direction: "asc" },
			});
			expect(ids(found)).toEqual(
				target.backend === "sqlite" ? ["lower", "upper"] : ["lower"],
			);
		});

		it("`mode: insensitive` on `contains` matches both cases", async () => {
			await seedApprovals([
				{ id: "upper", status: "PENDING" },
				{ id: "lower", status: "pending" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [
					{
						field: "status",
						operator: "contains",
						value: "PEND",
						mode: "insensitive",
					},
				],
				sortBy: { field: "id", direction: "asc" },
			});
			expect(ids(found)).toEqual(["lower", "upper"]);
		});

		it("`mode: insensitive` on `eq` folds ASCII, or says it cannot", async () => {
			// THE GUARANTEE, as narrow as it can honestly be made: asking for insensitive gets you
			// insensitive for ASCII, on every backend. Prisma implements `mode` on postgres and mongodb
			// only, so on SQLite it refuses out loud rather than silently answering the case-SENSITIVE
			// question — which is what it used to do by crashing with a driver validation error.
			await seedApprovals([{ id: "upper", status: "PENDING" }]);
			await expectMatchOrRefusal(
				[
					{
						field: "status",
						operator: "eq",
						value: "pending",
						mode: "insensitive",
					},
				],
				["upper"],
			);
		});

		it("whether `mode: insensitive` folds a NON-ASCII letter is the database's business", async () => {
			// Four different folding functions hide behind one flag: JS `toLowerCase()` in memory (full
			// Unicode), SQL `lower()` in kysely/drizzle (ASCII-ONLY in SQLite, ICU in Postgres), and a
			// PCRE `$options: "i"` in mongo (Unicode). There is no adapter-side fix — folding `Ä`
			// correctly on SQLite means shipping a case-folding table into the query, which is the same
			// index-destroying rewrite the default-sensitivity case rejects.
			//
			// Pinned per backend for the same reason as that one: this is the assertion that fires when
			// somebody swaps SQLite for Postgres and a search silently starts matching more.
			await seedApprovals([{ id: "umlaut", status: "Ärger" }]);
			await expectMatchOrRefusal(
				[
					{
						field: "status",
						operator: "eq",
						value: "ärger",
						mode: "insensitive",
					},
				],
				target.backend === "sqlite" ? [] : ["umlaut"],
			);
		});

		// ── Pattern-operator escaping ────────────────────────────────────────────────────────────
		//
		// A value reaching `contains` is USER INPUT — a search box, a tool argument, an agent's own
		// text. If the adapter forwards it into a LIKE pattern unescaped, `_` and `%` stop being
		// characters and become wildcards, and the caller's filter quietly widens. kysely and drizzle
		// both escape and declare `ESCAPE '\'`; mongo escapes regex metacharacters (`_` and `%` are
		// not among them, so they stay literal); the memory adapter uses `String.includes`, where a
		// wildcard cannot exist.
		//
		// THE PROPERTY IS "NEVER SILENTLY WIDER", NOT "ALWAYS MATCHES". Prisma's filter API cannot
		// emit an `ESCAPE` clause, and SQLite has no default escape character, so on that pairing a
		// literal wildcard is genuinely inexpressible — verified empirically: `a\_c` there matches a
		// literal backslash, not an escaped underscore. An adapter in that position may REFUSE, and
		// refusing is a real answer. What none of them may do is return `wild`.

		it("an underscore in a `contains` value is a literal, not a single-character wildcard", async () => {
			await seedApprovals([
				{ id: "literal", status: "a_c" },
				{ id: "wild", status: "abc" },
			]);
			await expectMatchOrRefusal(
				[{ field: "status", operator: "contains", value: "a_c" }],
				["literal"],
			);
		});

		it("a percent sign in a `contains` value is a literal, not a match-anything wildcard", async () => {
			await seedApprovals([
				{ id: "literal", status: "100% done" },
				{ id: "wild", status: "100 done" },
			]);
			await expectMatchOrRefusal(
				[{ field: "status", operator: "contains", value: "100% d" }],
				["literal"],
			);
		});

		it("`starts_with` treats a percent sign as a literal", async () => {
			// Separated from `contains` because the three SQL-shaped adapters build each pattern on its
			// own line — an escape can be dropped from one and kept in the others.
			await seedApprovals([
				{ id: "literal", status: "%raw" },
				{ id: "other", status: "xraw" },
			]);
			await expectMatchOrRefusal(
				[{ field: "status", operator: "starts_with", value: "%r" }],
				["literal"],
			);
		});

		// ── Where-tree shape ─────────────────────────────────────────────────────────────────────

		it("a flat list left-folds: `A OR B AND C` groups as `(A OR B) AND C`", async () => {
			// CONTRACT-STATED — "How this node joins the previous SIBLING (left-fold)". Worth pinning
			// because SQL's own precedence says the opposite (AND binds tighter than OR), so any
			// adapter that emits its clauses into one flat SQL string and lets the database associate
			// them gets `A OR (B AND C)` instead. Nothing in the storage-core or kysely suites
			// currently mentions `connector` at all.
			//
			// status = approved OR status = pending, AND id = keep
			//   left-fold  → (approved OR pending) AND id=keep → just "keep"
			//   SQL default→ approved OR (pending AND id=keep) → "keep" AND "drop"
			await seedApprovals([
				{ id: "keep", status: "pending" },
				{ id: "drop", status: "approved" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [
					{ field: "status", value: "approved" },
					{ field: "status", value: "pending", connector: "OR" },
					{ field: "id", value: "keep", connector: "AND" },
				],
			});
			expect(ids(found)).toEqual(["keep"]);
		});

		it("nested groups parenthesize under their own combinator", async () => {
			// The shape the contract names as the reason groups exist: the shareable-resource union.
			await seedApprovals([
				{ id: "a", status: "personal" },
				{ id: "b", status: "organization" },
				{ id: "c", status: "other" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				where: [
					{
						or: [
							{
								and: [
									{ field: "status", value: "personal" },
									{ field: "id", value: "a" },
								],
							},
							{
								and: [
									{ field: "status", value: "organization" },
									{ field: "id", value: "b" },
								],
							},
						],
					},
				],
				sortBy: { field: "id", direction: "asc" },
			});
			expect(ids(found)).toEqual(["a", "b"]);
		});

		// ── Sorting ──────────────────────────────────────────────────────────────────────────────

		it("sorting a nullable column keeps the NON-null rows correctly ordered", async () => {
			// Where the nulls land is genuinely engine-specific (sqlite and mongo sort them first,
			// postgres sorts them last on ASC), so this case refuses to assert that. It asserts only
			// the part no engine is allowed to get wrong: the rows that DO have values come back in
			// order relative to each other.
			//
			// The memory adapter is expected to fail, and for a worse reason than null placement. Its
			// comparator is `av < bv ? -1 : av > bv ? 1 : 0` over raw values, so `undefined` compares
			// as EQUAL to every other value — an intransitive comparator. `Array.prototype.sort` is
			// entitled to produce any permutation from one, so this is not "nulls in the wrong place",
			// it is "the sort is unsound whenever the column is nullable".
			//
			// THE INSERTION ORDER BELOW IS LOAD-BEARING. Most arrangements survive by luck — the null
			// has to land where the merge actually consults it — so an obvious four-row seed reports
			// a clean pass over a broken comparator. This one is a searched counterexample: the null
			// sits between `e` and `d` and behaves as a wall neither can be compared across, so `d`
			// comes back AFTER `e`. Change the seed and this case stops testing anything.
			await seedApprovals([
				{ id: "r1", status: "a" },
				{ id: "r2", status: "b" },
				{ id: "r3", status: "c" },
				{ id: "r5", status: "e" },
				{ id: "unset" },
				{ id: "r4", status: "d" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				sortBy: { field: "status", direction: "asc" },
			});
			const present = statuses(found).filter(
				(s) => s !== null && s !== undefined,
			);
			expect(present).toEqual(["a", "b", "c", "d", "e"]);
		});

		it("a multi-column sort breaks ties by the second column", async () => {
			// CONTRACT-STATED via `sortByList` — one column or several. The tie column is what keyset
			// pagination rests on, and an adapter that silently honours only the first sort produces a
			// page boundary that moves between requests.
			await seedApprovals([
				{ id: "b", status: "same" },
				{ id: "c", status: "same" },
				{ id: "a", status: "same" },
			]);
			const found = await target.adapter().findMany({
				model: "approval",
				sortBy: [
					{ field: "status", direction: "asc" },
					{ field: "id", direction: "desc" },
				],
			});
			expect(ids(found)).toEqual(["c", "b", "a"]);
		});

		it("a numeric column sorts numerically, not lexicographically", async () => {
			// `audit.seq` is the one integer column all five backends declare. Mongo stores whatever
			// JS handed it, and the memory adapter compares with bare `<` — so a column that arrives
			// as a string from one writer and a number from another sorts as text in those two and as
			// a number in the three SQL backends.
			const a = target.adapter();
			for (const seq of [10, 9, 100, 1])
				await a.create({ model: "audit", data: { seq, name: `t${seq}` } });
			const found = await a.findMany({
				model: "audit",
				sortBy: { field: "seq", direction: "asc" },
			});
			expect((found as Row[]).map((r) => Number(r.seq))).toEqual([
				1, 9, 10, 100,
			]);
		});

		// ── count / delete agree with findMany ───────────────────────────────────────────────────

		it("`count` answers the same where tree as `findMany`", async () => {
			// Every adapter translates the tree once and reuses it for both — in principle. This is the
			// cheap guard against one of them growing a second, drifting code path, and it inherits
			// whatever null semantics the `ne` case above settles.
			await seedApprovals([
				{ id: "unset" },
				{ id: "other", status: "approved" },
				{ id: "match", status: "pending" },
			]);
			const a = target.adapter();
			const where = [
				{ field: "status", operator: "ne" as const, value: "pending" },
			];
			const found = await a.findMany({ model: "approval", where });
			const counted = await a.count({ model: "approval", where });
			expect(counted).toBe((found as Row[]).length);
		});
	});
}
