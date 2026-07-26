// Config discovery and loading — the CLI's one real boundary: an arbitrary host module on disk.
//
// The behaviours worth pinning are the FAILURE ones. A migration tool that silently reads a
// partial config emits a partial schema, and a partial schema is a missing column in production.
// So every "I could not find the whole config" path must be loud and say what to do instead.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findConfigPath, loadSchema } from "../src/config";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "euroclaw-cli-"));
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

const write = (name: string, source: string): string => {
	const path = join(dir, name);
	writeFileSync(path, source, "utf8");
	return path;
};

describe("findConfigPath", () => {
	it("finds a euroclaw.config.ts in the working directory", () => {
		const path = write("euroclaw.config.ts", "export const config = {}");
		expect(findConfigPath(dir)).toBe(path);
	});

	it("finds a config at a conventional nested location", () => {
		mkdirSync(join(dir, "lib"), { recursive: true });
		const path = write("lib/euroclaw.ts", "export const config = {}");
		expect(findConfigPath(dir)).toBe(path);
	});

	it("takes an explicit --config path over the search", () => {
		write("euroclaw.config.ts", "export const config = {}");
		const explicit = write("custom.ts", "export const config = {}");
		expect(findConfigPath(dir, "custom.ts")).toBe(explicit);
	});

	it("throws naming the paths it looked in when there is no config", () => {
		expect(() => findConfigPath(dir)).toThrow(/euroclaw\.config\.ts/);
	});

	it("throws when an explicit --config path does not exist", () => {
		expect(() => findConfigPath(dir, "nope.ts")).toThrow(/config not found/);
	});
});

describe("loadSchema", () => {
	it("reads an exported CONFIG and projects it to tables", async () => {
		const path = write(
			"euroclaw.config.ts",
			`export const config = { redaction: { posture: "raw" } }`,
		);
		const loaded = await loadSchema(path);
		expect(loaded.source).toBe("config");
		// The core tables come from the declaration, not from anything the host wrote.
		expect(Object.keys(loaded.tables)).toContain("claw");
		expect(Object.keys(loaded.tables)).toContain("pii_mapping");
	});

	it("reads an exported CLAW via $tables, preferring it over a config beside it", async () => {
		const path = write(
			"euroclaw.config.ts",
			`export const config = { database: { marker: "from-config" } };
			 export const claw = { api: {}, $context: {}, $tables: { widget: { fields: {} } } };`,
		);
		const loaded = await loadSchema(path);
		expect(loaded.source).toBe("claw");
		expect(Object.keys(loaded.tables)).toEqual(["widget"]);
		// The claw carries no connection, so the database comes from the config beside it.
		expect(loaded.database).toEqual({ marker: "from-config" });
	});

	it("reads a default export", async () => {
		const path = write(
			"euroclaw.config.ts",
			`export default { redaction: { posture: "raw" } }`,
		);
		await expect(loadSchema(path)).resolves.toMatchObject({ source: "config" });
	});

	it("REFUSES a claw with no $tables rather than reading a partial schema", async () => {
		// An older build. Falling back to $context.plugins would look like it worked while
		// dropping whatever the host's own schema/redaction contribute.
		const path = write(
			"euroclaw.config.ts",
			`export const claw = { api: {}, $context: { plugins: [] } };`,
		);
		await expect(loadSchema(path)).rejects.toThrow(/no `\$tables`/);
	});

	it("throws when the module exports neither a claw nor a config", async () => {
		const path = write("euroclaw.config.ts", `export const something = 1`);
		await expect(loadSchema(path)).rejects.toThrow(
			/exports neither a claw nor a euroclaw config/,
		);
	});
});
