// Which generator runs for which target — the analog of Better Auth's `adapters` dispatch table
// (packages/cli/src/generators/index.ts), where the adapter's own `id` picks the generator.
//
// ROUTING ONLY. Every line of dialect knowledge lives in the storage package that owns the dialect:
// the SQL emitter in @euroclaw/storage-kysely, the Drizzle one in @euroclaw/storage-drizzle, the
// Prisma one in @euroclaw/storage-prisma. So each is tested beside the adapter it serves (and, for
// Prisma, beside the real schema.prisma its tests can validate against), and adding an adapter means
// adding a generator next to it plus one line here.
//
// The split this encodes: `sql` DIFFS against a live database and emits only what is missing,
// because nothing else owns migration history for a raw SQL setup. `drizzle` and `prisma` emit a
// full schema in that ORM's own language and stop, because drizzle-kit and prisma-migrate already
// own history and are better at it than we would be.

import type { SchemaDeclaration } from "@euroclaw/contracts";
import {
	type DrizzleProvider,
	generateDrizzleSchema,
} from "@euroclaw/storage-drizzle";
import {
	generateKyselyTypes,
	type KyselyTypeDialect,
} from "@euroclaw/storage-kysely";
import { generatePrismaSchema } from "@euroclaw/storage-prisma";

export type { DrizzleProvider } from "@euroclaw/storage-drizzle";

/** What `db generate` can emit. */
export const GENERATE_TARGETS = ["sql", "drizzle", "prisma", "kysely"] as const;
export type GenerateTarget = (typeof GENERATE_TARGETS)[number];

/**
 * Adapter id (as reported by a storage adapter's `id`) → the target that fits it.
 *
 * A Kysely setup infers `sql`, not `kysely`: the tables have to exist before anything can query
 * them, so the migration is the need you have first. `--target kysely` is the deliberate second
 * step — ask for the row types once the schema is in place.
 */
export const TARGET_FOR_ADAPTER: Readonly<Record<string, GenerateTarget>> = {
	drizzle: "drizzle",
	kysely: "sql",
	prisma: "prisma",
};

/** The conventional filename per target, used when `--output` is not given. */
export const DEFAULT_OUTPUT: Readonly<Record<GenerateTarget, string>> = {
	sql: "euroclaw.sql",
	drizzle: "euroclaw-schema.ts",
	prisma: "euroclaw.prisma",
	kysely: "euroclaw-db.ts",
};

/** Targets that print the whole schema without connecting to anything. A type predicate, so a
 *  caller that has checked it can hand the target straight to {@link generateOffline}. */
export function isOfflineTarget(
	target: GenerateTarget,
): target is Exclude<GenerateTarget, "sql"> {
	return target !== "sql";
}

export function generateOffline(input: {
	target: Exclude<GenerateTarget, "sql">;
	schema: SchemaDeclaration;
	provider?: DrizzleProvider;
	dialect?: KyselyTypeDialect;
	warn?: (message: string) => void;
}): string {
	if (input.target === "prisma") {
		return generatePrismaSchema({
			schema: input.schema,
			...(input.warn !== undefined ? { warn: input.warn } : {}),
		});
	}
	if (input.target === "kysely") {
		if (input.dialect === undefined) {
			throw new Error(
				"kysely types need a dialect — a boolean reads back as `boolean` on postgres and `number` on sqlite, and a date as `Date` or `string`. Pass --dialect postgres|sqlite.",
			);
		}
		return generateKyselyTypes({
			schema: input.schema,
			dialect: input.dialect,
		});
	}
	if (input.provider === undefined) {
		throw new Error(
			"drizzle needs a provider — its column helpers and its import path differ per dialect. Pass --provider pg|sqlite.",
		);
	}
	return generateDrizzleSchema({
		schema: input.schema,
		provider: input.provider,
	});
}
