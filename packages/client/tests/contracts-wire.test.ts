// The STRUCTURAL client-bundle guarantee (docs/plans/claw-client-plan.md, FINAL doc-channel
// decision): described/documented schemas live in server module graphs the client never imports,
// enforced by TEST rather than by tree-shaking behavior. Three invariants over the SOURCE (so the
// guarantee holds regardless of bundler): (a) the contracts BARREL is `import type`-only in client
// src — types never bundle, values must ride the wire subpaths; (b) every deep contracts specifier
// is on the allowlist below; (c) the allowlisted modules' transitive source graph inside contracts
// carries no doc/description authoring at all — `.describe(` and `.configure(` are banned outright
// (stricter than banning only `{ euroclaw` so formatting can never hide the key). Node env on
// purpose, like react-free.test.ts: the walk is an fs walk.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONTRACTS_PACKAGE = "@euroclaw/contracts";

/** The wire subpaths client src may VALUE-import — mirrors the contracts exports-map additions. */
const ALLOWED_CONTRACTS_SUBPATHS = [
	"@euroclaw/contracts/claw-api",
	"@euroclaw/contracts/governance/endpoints",
] as const;

const clientSrcDir = fileURLToPath(new URL("../src", import.meta.url));
const contractsDir = fileURLToPath(
	new URL("../../foundation/contracts", import.meta.url),
);

function sourceFilesUnder(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

type ImportStatement = { raw: string; typeOnly: boolean; specifier: string };

// Statement-level scan (not just specifiers): the barrel rule needs the `import type` marker.
// LINE-anchored so prose in comments never reads as a statement (top-level, biome-formatted
// imports always start a line); `[^"';]*?` keeps a lazy clause from spanning across statements
// while still crossing newlines inside a braced clause. Inline `{ type X }` imports count as
// VALUE imports on purpose — verbatimModuleSyntax keeps such a statement (and its side effects)
// at runtime, so only full `import type` statements are erased and therefore free.
function importStatementsOf(source: string): ImportStatement[] {
	const statements: ImportStatement[] = [];
	for (const match of source.matchAll(
		/^(?:import|export)\s+(type\s)?[^"';]*?from\s+"([^"]+)"/gm,
	)) {
		statements.push({
			raw: match[0],
			typeOnly: match[1] !== undefined,
			specifier: match[2] ?? "",
		});
	}
	for (const match of source.matchAll(/^import\s+"([^"]+)"/gm)) {
		statements.push({
			raw: match[0],
			typeOnly: false,
			specifier: match[1] ?? "",
		});
	}
	return statements;
}

describe("client src imports contracts through the wire allowlist only", () => {
	it("never VALUE-imports the contracts barrel, and every deep specifier is allowlisted", () => {
		const allowed = new Set<string>(ALLOWED_CONTRACTS_SUBPATHS);
		const offenders: string[] = [];
		for (const file of sourceFilesUnder(clientSrcDir)) {
			for (const statement of importStatementsOf(readFileSync(file, "utf8"))) {
				const { specifier } = statement;
				if (specifier === CONTRACTS_PACKAGE && !statement.typeOnly) {
					offenders.push(
						`${file}: value import of the contracts barrel — "${statement.raw}"`,
					);
				}
				if (
					specifier.startsWith(`${CONTRACTS_PACKAGE}/`) &&
					!allowed.has(specifier)
				) {
					offenders.push(
						`${file}: "${specifier}" is not an allowlisted contracts wire subpath`,
					);
				}
			}
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	it("every allowlisted subpath is a real contracts export", () => {
		const manifest = JSON.parse(
			readFileSync(join(contractsDir, "package.json"), "utf8"),
		) as { exports?: Record<string, unknown> };
		for (const specifier of ALLOWED_CONTRACTS_SUBPATHS) {
			const subpath = `.${specifier.slice(CONTRACTS_PACKAGE.length)}`;
			expect(manifest.exports?.[subpath], `${subpath} missing`).toBeDefined();
		}
	});

	it("keeps the allowlisted wire modules transitively docless at the source level", () => {
		// Walk each wire module's RELATIVE import graph inside contracts src (external packages —
		// arktype, @euroclaw/errors — are not schema-authoring surfaces and are not walked).
		const walked = new Set<string>();
		const collect = (file: string): void => {
			if (walked.has(file)) return;
			walked.add(file);
			const source = readFileSync(file, "utf8");
			for (const statement of importStatementsOf(source)) {
				if (!statement.specifier.startsWith(".")) continue;
				const base = resolve(dirname(file), statement.specifier);
				const target = [`${base}.ts`, join(base, "index.ts")].find(
					(candidate) => existsSync(candidate),
				);
				if (target === undefined) {
					throw new Error(
						`unresolved relative import "${statement.specifier}" in ${file}`,
					);
				}
				collect(target);
			}
		};
		for (const specifier of ALLOWED_CONTRACTS_SUBPATHS) {
			const base = join(
				contractsDir,
				"src",
				specifier.slice(`${CONTRACTS_PACKAGE}/`.length),
			);
			const entry = [`${base}.ts`, join(base, "index.ts")].find((candidate) =>
				existsSync(candidate),
			);
			if (entry === undefined) {
				throw new Error(`allowlisted subpath has no contracts source: ${base}`);
			}
			collect(entry);
		}

		const offenders: string[] = [];
		for (const file of walked) {
			const source = readFileSync(file, "utf8");
			for (const banned of [".describe(", ".configure("]) {
				if (source.includes(banned)) {
					offenders.push(`${file}: contains "${banned}"`);
				}
			}
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
		// The walk saw the wire modules themselves — an empty walk would vacuously pass.
		expect(walked.size).toBeGreaterThanOrEqual(
			ALLOWED_CONTRACTS_SUBPATHS.length,
		);
	});
});
