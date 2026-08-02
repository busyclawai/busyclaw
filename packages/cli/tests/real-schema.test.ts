// The generators, run against busyclaw's ACTUAL table set rather than a hand-written fixture.
//
// Each storage package already tests its generator hard — including a real `prisma validate` — but on
// a fixture written to exercise the generator. A fixture cannot notice that a REAL core table drifted
// into a shape the target rejects, because the fixture is not the real table. The CLI is the one
// package that can see both `getBusyclawTables()` and every generator, so the end-to-end assertion
// lives here: whatever `busyclaw db generate` would emit today, the target accepts.
//
// This is also where the PII vault's Prisma support is pinned. `pii_mapping` and `pii_subject` were
// emitted `@@ignore` for as long as their `(placeholder, scope, scopeId)` key was undeclarable — which
// meant they were absent from the generated client and busyclaw's re-identification store simply could
// not run on Prisma. That is fixed by the container being required, and a keyless core table would
// silently bring it back.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { generatePrismaSchema } from "@busyclaw/storage-prisma";
import { getBusyclawTables } from "busyclaw";
import { describe, expect, it } from "vitest";

/** Resolve a locally-installed CLI binary by walking up to the nearest `node_modules/.bin`.
 *  Deliberately NOT `npx`: npx resolves through the npm cache and can shell out to a lookup that
 *  fails under load — this test passed in isolation and failed with "command not found" only when
 *  the whole workspace gate ran at once. A path that exists on disk cannot do that. */
function binPath(name: string): string {
	let dir = process.cwd();
	for (;;) {
		const candidate = join(dir, "node_modules", ".bin", name);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir)
			throw new Error(`could not resolve the "${name}" binary`);
		dir = parent;
	}
}

/** Exactly what `busyclaw db generate` projects for a host that configured nothing extra. */
const REAL = getBusyclawTables({});

describe("the real core schema", () => {
	it("declares a primary key on every table", () => {
		const keyless = Object.entries(REAL)
			.filter(([, table]) =>
				Object.values(table.fields).every((field) => field.primaryKey !== true),
			)
			.map(([model]) => model);

		// Not a style rule. A keyless table is invisible to Prisma's client, cannot be addressed by a
		// unique write on any adapter, and — for the PII tables specifically — loses the constraint that
		// keeps one container's placeholder from being confused with another's.
		expect(keyless).toEqual([]);
	});

	it("gives the PII vault its container-composite keys", () => {
		const keyOf = (model: string) =>
			Object.entries(REAL[model]?.fields ?? {})
				.filter(([, field]) => field.primaryKey === true)
				.map(([name]) => name);

		expect(keyOf("pii_mapping")).toEqual(["placeholder", "scope", "scopeId"]);
		expect(keyOf("pii_subject")).toEqual([
			"placeholder",
			"subjectId",
			"scope",
			"scopeId",
		]);
	});

	it("emits a Prisma schema with no @@ignore and no warnings", () => {
		const warnings: string[] = [];
		const code = generatePrismaSchema({
			schema: REAL,
			warn: (message: string) => void warnings.push(message),
		});

		// `@@ignore` means "present in the schema, absent from the client" — a table busyclaw declares
		// and then cannot read or write.
		expect(code).not.toContain("@@ignore");
		expect(warnings).toEqual([]);
	});

	it("passes `prisma validate`", async () => {
		const dir = mkdtempSync(join(tmpdir(), "busyclaw-real-schema-"));
		try {
			writeFileSync(
				join(dir, "schema.prisma"),
				[
					'datasource db {\n  provider = "postgresql"\n  url = "postgresql://u:p@localhost:5432/d"\n}',
					'generator client {\n  provider = "prisma-client-js"\n}',
					generatePrismaSchema({ schema: REAL }),
				].join("\n\n"),
				"utf8",
			);

			const { stdout, stderr } = await promisify(execFile)(
				binPath("prisma"),
				["validate", "--schema", join(dir, "schema.prisma")],
				{ cwd: process.cwd() },
			);
			expect(`${stdout}${stderr}`).toContain("is valid");
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	}, 120_000);
});
