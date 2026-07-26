// `euroclaw db generate` / `euroclaw db migrate`.
//
// Both commands read the SAME declaration the runtime validates rows against — `getEuroclawTables`
// is the projection of the very field maps `getEuroclawModels` feeds the entity adapter. That is
// the point of the design: a column cannot exist in the validator and be missing from the
// migration, because there is one declaration and two projections of it.
//
// `generate` writes a schema and touches nothing. `migrate` applies it, and is SQL-only.

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	type MigrationDialect,
	planMigrations,
	resolveKyselyDatabase,
} from "@euroclaw/storage-kysely";
import { findConfigPath, type LoadedSchema, loadSchema } from "../config.js";
import {
	DEFAULT_OUTPUT,
	type DrizzleProvider,
	GENERATE_TARGETS,
	type GenerateTarget,
	generateOffline,
	isOfflineTarget,
	TARGET_FOR_ADAPTER,
} from "../generators/index.js";

export type DbCommandOptions = {
	config?: string;
	dialect?: string;
	output?: string;
	provider?: string;
	target?: string;
	yes?: boolean;
};

function assertTarget(value: string): GenerateTarget {
	const found = GENERATE_TARGETS.find((target) => target === value);
	if (found === undefined) {
		throw new Error(
			`unknown --target "${value}" (expected ${GENERATE_TARGETS.join(", ")})`,
		);
	}
	return found;
}

function assertProvider(value: string): DrizzleProvider {
	if (value === "pg" || value === "sqlite") return value;
	throw new Error(`unknown --provider "${value}" (expected pg or sqlite)`);
}

/**
 * Which generator to run. An explicit `--target` wins; otherwise the config's `database` decides —
 * a wrapped storage Adapter reports its own `id`, exactly how Better Auth dispatches. A raw Kysely
 * input names no adapter, and means SQL.
 */
function resolveTarget(
	loaded: LoadedSchema,
	options: DbCommandOptions,
): GenerateTarget {
	if (options.target !== undefined) return assertTarget(options.target);
	const probe = loaded.database as Record<string, unknown> | undefined;
	const id = typeof probe?.id === "string" ? probe.id : undefined;
	if (id !== undefined) {
		const target = TARGET_FOR_ADAPTER[id];
		if (target === undefined) {
			throw new Error(
				`no schema generator for the "${id}" adapter. Supported: ${Object.keys(TARGET_FOR_ADAPTER).join(", ")}. Pass --target to choose one explicitly.`,
			);
		}
		return target;
	}
	return "sql";
}

type Prepared = {
	plan: Awaited<ReturnType<typeof planMigrations>>;
	dialect: MigrationDialect;
};

function assertDialect(value: string): MigrationDialect {
	if (value === "postgres" || value === "sqlite") return value;
	throw new Error(`unknown --dialect "${value}" (expected postgres or sqlite)`);
}

async function read(options: DbCommandOptions): Promise<LoadedSchema> {
	const cwd = process.cwd();
	const configPath = findConfigPath(cwd, options.config);
	const loaded = await loadSchema(configPath);
	console.log(
		`config   ${configPath} (read from the exported ${loaded.source})`,
	);
	return loaded;
}

async function prepare(
	options: DbCommandOptions,
	loaded: LoadedSchema,
): Promise<Prepared> {
	if (loaded.database === undefined) {
		throw new Error(
			loaded.source === "claw"
				? "found the claw's tables, but no database to reconcile them against. An assembled claw holds a resolved storage Adapter, not the connection it was built from — export the config beside it (`export const config = { … }`, then `createClaw(config)`) so the CLI can reach the underlying Kysely input."
				: "the config declares no `database` — there is nothing to reconcile. Add one (a Kysely instance, a pg Pool, a better-sqlite3 Database, or { dialect, type }).",
		);
	}

	// A pre-wrapped storage Adapter has no Kysely underneath to introspect or emit against. Better
	// Auth hits the same wall and says so; so do we, rather than half-working.
	const probe = loaded.database as Record<string, unknown>;
	if (typeof probe.create === "function" && typeof probe.id === "string") {
		throw new Error(
			`the config's \`database\` is an already-wrapped storage Adapter ("${String(probe.id)}"), which the migrator cannot introspect. Pass the underlying Kysely input (a pg Pool, a better-sqlite3 Database, or { dialect, type }) as \`database\` — createClaw accepts it directly and wraps it for you.`,
		);
	}

	const { db, type } = resolveKyselyDatabase(
		loaded.database as Parameters<typeof resolveKyselyDatabase>[0],
	);
	const dialect =
		options.dialect !== undefined ? assertDialect(options.dialect) : type;
	if (dialect === undefined) {
		throw new Error(
			"could not tell which SQL dialect this database speaks (a bare Kysely instance or Dialect carries no tag). Pass --dialect postgres|sqlite, or declare `database: { dialect, type }`.",
		);
	}

	const plan = await planMigrations({
		db,
		schema: loaded.tables,
		dialect,
		warn: warnLine,
	});
	return { plan, dialect };
}

function warnLine(message: string): void {
	console.warn(`  ! ${message}`);
}

function describe(plan: Prepared["plan"], dialect: MigrationDialect): void {
	console.log(`dialect  ${dialect}`);
	if (plan.isEmpty) {
		console.log("\nup to date — the database already matches the declaration.");
		return;
	}
	if (plan.toBeCreated.length > 0) {
		console.log(`\ncreate ${plan.toBeCreated.length} table(s):`);
		for (const table of plan.toBeCreated) {
			console.log(`  + ${table.table} (${table.columns.length} columns)`);
		}
	}
	if (plan.toBeAdded.length > 0) {
		console.log(`\nadd columns to ${plan.toBeAdded.length} table(s):`);
		for (const table of plan.toBeAdded) {
			console.log(`  ~ ${table.table}: ${table.columns.join(", ")}`);
		}
	}
	if (plan.drift.length > 0) {
		console.log(
			`\n${plan.drift.length} column(s) differ in type and were NOT changed:`,
		);
		for (const item of plan.drift) {
			console.log(
				`  ? ${item.table}.${item.column}: database has "${item.actual}", declaration says "${item.declared}"`,
			);
		}
	}
}

function write(
	target: GenerateTarget,
	contents: string,
	output?: string,
): void {
	const name = output ?? DEFAULT_OUTPUT[target];
	const path = isAbsolute(name) ? name : resolve(process.cwd(), name);
	writeFileSync(path, contents, "utf8");
	console.log(`\nwrote ${path}`);
}

/** Emit the schema. Never writes to the database. */
export async function dbGenerate(options: DbCommandOptions): Promise<void> {
	const loaded = await read(options);
	const target = resolveTarget(loaded, options);
	console.log(`target   ${target}`);

	// Drizzle and Prisma print the WHOLE schema and hand migration history to their own tooling, so
	// they need no connection at all — which also makes `generate` usable in CI, where there may be
	// no database to reach and no credentials to reach it with.
	if (isOfflineTarget(target)) {
		const contents = generateOffline({
			target,
			schema: loaded.tables,
			warn: warnLine,
			...(options.provider !== undefined
				? { provider: assertProvider(options.provider) }
				: {}),
			...(options.dialect !== undefined
				? { dialect: assertDialect(options.dialect) }
				: {}),
		});
		console.log(`\n${Object.keys(loaded.tables).length} table(s) emitted.`);
		write(target, contents, options.output);
		return;
	}

	const { plan, dialect } = await prepare(options, loaded);
	describe(plan, dialect);
	if (plan.isEmpty) return;
	write(target, plan.compileMigrations(), options.output);
}

/** Apply the plan to the live database. Additive only — nothing is dropped or retyped. */
export async function dbMigrate(options: DbCommandOptions): Promise<void> {
	const loaded = await read(options);
	const target = resolveTarget(loaded, options);
	if (isOfflineTarget(target)) {
		throw new Error(
			`\`db migrate\` is SQL-only, and this config resolves to the "${target}" target. ${target === "drizzle" ? "drizzle-kit" : "prisma migrate"} owns migration history for it — run \`euroclaw db generate\` to emit the schema, then migrate with that tool.`,
		);
	}

	const { plan, dialect } = await prepare(options, loaded);
	describe(plan, dialect);
	if (plan.isEmpty) return;

	if (options.yes !== true) {
		const ok = await confirm("\napply these changes?");
		if (!ok) {
			console.log("aborted.");
			return;
		}
	}
	await plan.runMigrations();
	console.log("\nmigrated.");
}

/** A y/N prompt with no dependency. Non-interactive stdin (CI) answers no — a migration that runs
 *  because nobody was there to say no is not a migration anyone approved. */
function confirm(question: string): Promise<boolean> {
	if (process.stdin.isTTY !== true) {
		console.log(`${question} (non-interactive — use --yes to apply)`);
		return Promise.resolve(false);
	}
	return new Promise((resolvePrompt) => {
		process.stdout.write(`${question} [y/N] `);
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", (chunk: string) => {
			process.stdin.pause();
			resolvePrompt(chunk.trim().toLowerCase() === "y");
		});
		process.stdin.resume();
	});
}
