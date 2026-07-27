#!/usr/bin/env node
// The busyclaw CLI. One command group today — `db` — because there is one thing the runtime cannot
// do for you at boot: create the tables it is about to read.

// NOTE: relative imports in this package carry an explicit `.js` extension. Every other package
// here is consumed by a bundler or vitest, which resolve extensionless specifiers happily — but
// this one is a `bin`, executed by Node directly, and Node's ESM loader does not. TypeScript
// resolves `./commands/db.js` to `./commands/db.ts` at compile time, so the source stays honest
// and the emitted JS is runnable.
import { Command } from "commander";
import { type DbCommandOptions, dbGenerate, dbMigrate } from "./commands/db.js";

const program = new Command();

program
	.name("busyclaw")
	.description("busyclaw command line")
	.version("0.0.0")
	.showHelpAfterError();

const db = program
	.command("db")
	.description("schema for the tables your busyclaw config declares");

db.command("generate")
	.description(
		"emit the schema your config declares (sql | drizzle | prisma | kysely)",
	)
	.option("-c, --config <path>", "path to the busyclaw config module")
	.option(
		"-o, --output <path>",
		"where to write (sql accumulates in ./busyclaw_migrations/)",
	)
	.option(
		"-t, --target <target>",
		"sql | drizzle | prisma | kysely (inferred from your adapter)",
	)
	.option(
		"-p, --provider <provider>",
		"pg | sqlite — required for --target drizzle",
	)
	.option(
		"-d, --dialect <dialect>",
		"postgres | sqlite — for --target sql (inferred when possible) and --target kysely",
	)
	.action(async (options: DbCommandOptions) => {
		await dbGenerate(options);
	});

db.command("migrate")
	.description(
		"apply the SQL to the database (additive only; SQL targets only)",
	)
	.option("-c, --config <path>", "path to the busyclaw config module")
	.option(
		"-d, --dialect <dialect>",
		"postgres | sqlite (inferred when possible)",
	)
	.option("-y, --yes", "skip the confirmation prompt")
	.action(async (options: DbCommandOptions) => {
		await dbMigrate(options);
	});

program.parseAsync(process.argv).catch((error: unknown) => {
	console.error(
		`\n${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
