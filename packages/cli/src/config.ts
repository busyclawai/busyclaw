// Finding and loading the host's euroclaw config.
//
// Better Auth's CLI resolves `auth.ts` and reads `auth.options` off the assembled instance. We
// accept EITHER shape, because hosts genuinely have both:
//
//   export const claw = createClaw({ … })        → read `claw.$tables`, the merged declaration
//   export const config = { … }                  → project it here with getEuroclawTables
//
// The claw path is the better-auth ergonomic: point at the module the app already has. The config
// path matters when there is no assembled claw to reach for — a schema-only repo, or a CI step that
// must not construct a runtime (and therefore must not need a model client or live credentials
// just to emit DDL).
//
// What is NOT acceptable is a claw whose `$tables` is missing: an older build, or something
// claw-shaped that isn't one. Reading `$context.plugins` as a fallback would look like it worked
// while dropping whatever the host's own `schema`/`redaction` contribute — a partial schema is a
// missing column in production, so that case throws instead.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SchemaDeclaration } from "@euroclaw/contracts";
import { getEuroclawTables } from "euroclaw";
import { createJiti } from "jiti";

/** The schema-contributing subset of a ClawConfig — what the tables projection reads. */
export type LoadedConfig = {
	plugins?: readonly unknown[];
	schema?: unknown;
	redaction?: unknown;
	database?: unknown;
};

/** What the commands actually need: the tables to reconcile, and something to connect with. */
export type LoadedSchema = {
	tables: SchemaDeclaration;
	database: unknown;
	/** Which export shape it came from — reported so the user can see what was read. */
	source: "claw" | "config";
};

/** Where we look when `--config` is not given, in order. */
const CANDIDATES = [
	"euroclaw.config.ts",
	"euroclaw.config.js",
	"euroclaw.config.mjs",
	"lib/euroclaw.ts",
	"src/lib/euroclaw.ts",
	"app/lib/euroclaw.ts",
	"lib/claw.ts",
	"src/lib/claw.ts",
];

export function findConfigPath(cwd: string, explicit?: string): string {
	if (explicit !== undefined) {
		const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (!existsSync(path)) {
			throw new Error(`config not found at ${path}`);
		}
		return path;
	}
	for (const candidate of CANDIDATES) {
		const path = resolve(cwd, candidate);
		if (existsSync(path)) return path;
	}
	throw new Error(
		`could not find a euroclaw config. Looked for:\n${CANDIDATES.map((c) => `  ${c}`).join("\n")}\nPass --config <path>, or export your createClaw config as \`config\` from one of those files.`,
	);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object";

const looksLikeClaw = (value: Record<string, unknown>): boolean =>
	"api" in value && "$context" in value;

/** Carries at least one field a ClawConfig would. Used only to vet a synthesized default export. */
const looksLikeConfig = (value: Record<string, unknown>): boolean =>
	["plugins", "schema", "redaction", "database", "model", "models"].some(
		(key) => key in value,
	);

/**
 * Load the module and resolve it to the tables the CLI has to reconcile.
 *
 * Export names tried, in order: `claw`, `config`, `euroclawConfig`, then the default export. The
 * module belongs to the host — insisting on one name for a CLI-only convention is not worth a
 * failed run.
 *
 * Loaded through jiti so a TypeScript module works with no build step, which is the normal case:
 * the claw sits in the same `.ts` file the app imports.
 */
export async function loadSchema(path: string): Promise<LoadedSchema> {
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const loaded = (await jiti.import(path)) as Record<string, unknown>;

	// Named exports are checked first and taken at their word — naming an export `config` IS the
	// statement of intent. `default` is checked last and held to a higher bar: jiti's
	// `interopDefault` synthesizes one from the module namespace when a module has no real default
	// export, so an unrelated module would otherwise arrive here looking like an empty config —
	// and an empty config projects to the full core schema, which would be a confident wrong answer.
	for (const key of ["claw", "config", "euroclawConfig", "default"]) {
		const candidate = loaded[key];
		if (!isObject(candidate)) continue;
		if (
			key === "default" &&
			!looksLikeClaw(candidate) &&
			!looksLikeConfig(candidate)
		) {
			continue;
		}

		if (looksLikeClaw(candidate)) {
			const tables = candidate.$tables;
			if (!isObject(tables)) {
				throw new Error(
					`${path} exports an assembled claw with no \`$tables\`. That means it was built by an older euroclaw than this CLI. Falling back to its plugins alone would silently drop whatever your own \`schema\`/\`redaction\` contribute, so this stops instead — upgrade euroclaw, or export the config object as \`config\`.`,
				);
			}
			// The database is not on the claw (deliberately — it is the config's, and the claw holds
			// the resolved Adapter). Take it from a config export if one is there too.
			const beside = loaded.config ?? loaded.euroclawConfig;
			return {
				tables: tables as SchemaDeclaration,
				database: isObject(beside) ? beside.database : undefined,
				source: "claw",
			};
		}

		const config = candidate as LoadedConfig;
		return {
			tables: getEuroclawTables({
				plugins: (config.plugins ?? []) as never,
				schema: config.schema as never,
				redaction: config.redaction as never,
			}),
			database: config.database,
			source: "config",
		};
	}
	throw new Error(
		`${path} exports neither a claw nor a euroclaw config. Export one of:\n\n  export const claw = createClaw({ … })      // the CLI reads claw.$tables\n  export const config = { … }                // the object you pass to createClaw`,
	);
}
