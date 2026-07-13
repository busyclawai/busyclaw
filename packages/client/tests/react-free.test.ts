// The ROOT entry must stay importable without react installed — react is an optional peer that
// only the `./react` subpath needs. Proven at the source of truth: a walk of the relative import
// graphs from the root and plugins entries (so a stray `import ... from "react"` anywhere in
// those graphs fails here, no build required), plus the package-manifest contract. Node env on
// purpose: under happy-dom, `import.meta.url` is an http URL and the fs walk would break.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("the root entry stays react-free", () => {
	const srcDir = fileURLToPath(new URL("../src", import.meta.url));

	// Walks the RELATIVE import graph from an entry module, collecting every import specifier.
	function collectImportSpecifiers(
		file: string,
		seen: Set<string>,
		specifiers: Set<string>,
	): void {
		if (seen.has(file)) return;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		const references = [
			...source.matchAll(/from\s+"([^"]+)"/g),
			...source.matchAll(/import\s+"([^"]+)"/g),
		];
		for (const match of references) {
			const specifier = match[1];
			if (specifier === undefined) continue;
			specifiers.add(specifier);
			if (!specifier.startsWith(".")) continue;
			const base = resolve(dirname(file), specifier);
			const target = [`${base}.ts`, join(base, "index.ts")].find((candidate) =>
				existsSync(candidate),
			);
			if (target === undefined) {
				throw new Error(`unresolved relative import "${specifier}" in ${file}`);
			}
			collectImportSpecifiers(target, seen, specifiers);
		}
	}

	it("never imports react anywhere in the root or plugins module graphs", () => {
		const seen = new Set<string>();
		const specifiers = new Set<string>();
		for (const entry of ["index.ts", "plugins/index.ts"]) {
			collectImportSpecifiers(join(srcDir, entry), seen, specifiers);
		}
		const offenders = [...specifiers].filter(
			(specifier) =>
				specifier === "react" ||
				specifier.startsWith("react/") ||
				specifier === "react-dom" ||
				specifier.startsWith("react-dom/"),
		);
		expect(offenders).toEqual([]);
		expect(seen.has(join(srcDir, "react/index.ts"))).toBe(false);
	});

	it("declares react as an optional peer needed only by the ./react subpath", () => {
		const manifest = JSON.parse(
			readFileSync(
				fileURLToPath(new URL("../package.json", import.meta.url)),
				"utf8",
			),
		) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
			peerDependencies?: Record<string, string>;
			peerDependenciesMeta?: Record<string, { optional?: boolean }>;
		};
		expect(manifest.peerDependencies?.react).toBe("^18.0.0 || ^19.0.0");
		expect(manifest.peerDependenciesMeta?.react?.optional).toBe(true);
		expect(manifest.dependencies?.react).toBeUndefined();
		expect(manifest.exports?.["./react"]).toEqual({
			import: "./dist/react/index.js",
			types: "./dist/react/index.d.ts",
		});
	});
});
