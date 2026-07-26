// The Prisma schema generator. Pure: SchemaDeclaration in, source text out — so these assert on the
// emitted code, and on the two things easiest to get quietly wrong: declaration ORDER and COMPOSITE
// primary keys, which euroclaw has and Better Auth's generators never see.

import type { SchemaDeclaration } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { generatePrismaSchema } from "../src/generate";

/** A claw <- thread pair (declared child-first, so ordering has to be earned) plus a composite key. */
const SCHEMA: SchemaDeclaration = {
	thread: {
		fields: {
			id: { type: "string", required: true, primaryKey: true, unique: true },
			clawId: {
				type: "string",
				required: true,
				index: true,
				references: { model: "claw", field: "id" },
			},
			title: { type: "string" },
			currentSequence: { type: "number", required: true },
		},
	},
	claw: {
		fields: {
			id: { type: "string", required: true, primaryKey: true, unique: true },
			createdBy: { type: "string", required: true, index: true },
			context: { type: "json", required: true },
			createdAt: { type: "date", required: true },
			archived: { type: "boolean" },
		},
	},
	pii_mapping: {
		fields: {
			placeholder: { type: "string", required: true, primaryKey: true },
			scope: { type: "string", required: true, primaryKey: true },
			original: { type: "string", required: true },
		},
	},
};

describe("generatePrismaSchema", () => {
	it("emits a relation on BOTH sides — the scalar, the relation field, and the back-list", () => {
		const code = generatePrismaSchema({ schema: SCHEMA });
		expect(code).toContain(
			"claw Claw @relation(fields: [clawId], references: [id])",
		);
		// Prisma requires the reverse side or the schema does not validate.
		expect(code).toContain("threads Thread[]");
	});

	it("maps declared types to Prisma scalars", () => {
		const code = generatePrismaSchema({ schema: SCHEMA });
		// String, not Json: a Prisma Json column hands back a parsed value, which decoding refuses.
		expect(code).toContain("context String");
		expect(code).not.toMatch(/\bJson\b/);
		expect(code).toContain("createdAt DateTime");
		expect(code).toContain("archived Boolean?");
		expect(code).toContain("currentSequence Float");
	});

	it("marks a single key @id and a composite key @@id", () => {
		const code = generatePrismaSchema({ schema: SCHEMA });
		expect(code).toContain("id String @id");
		expect(code).toContain("@@id([placeholder, scope])");
	});

	it("PascalCases the model and @@maps it back to the physical table", () => {
		const code = generatePrismaSchema({ schema: SCHEMA });
		expect(code).toContain("model PiiMapping {");
		expect(code).toContain('@@map("pii_mapping")');
		// A model whose name already matches its table needs no @@map.
		expect(code).not.toContain('@@map("Claw")');
	});

	it("does NOT emit datasource or generator BLOCKS — those are the host's", () => {
		const code = generatePrismaSchema({ schema: SCHEMA });
		// The words appear in the header comment explaining their absence, so match the blocks.
		expect(code).not.toMatch(/^\s*datasource\s+\w+\s*\{/m);
		expect(code).not.toMatch(/^\s*generator\s+\w+\s*\{/m);
	});
});

describe("prisma — models with no declared key", () => {
	// Prisma refuses to validate a schema containing a model with no @id/@@id/@@unique. euroclaw has
	// exactly that today (pii_mapping), so the generator must not emit a file prisma will reject.
	const keyless: SchemaDeclaration = {
		pii_subject: {
			fields: {
				placeholder: { type: "string", required: true, index: true },
				subjectId: { type: "string", required: true, index: true },
			},
		},
	};

	it("marks it @@ignore and says so, rather than emitting a schema prisma rejects", () => {
		const warnings: string[] = [];
		const code = generatePrismaSchema({
			schema: keyless,
			warn: (message) => warnings.push(message),
		});
		expect(code).toContain("@@ignore");
		expect(code).toContain("No primary key declared");
		expect(warnings.join(" ")).toMatch(/declares no primaryKey/);
	});

	it("leaves keyed models untouched by that rule", () => {
		const code = generatePrismaSchema({ schema: SCHEMA });
		const clawBlock = code.slice(
			code.indexOf("model Claw {"),
			code.indexOf("model Thread {"),
		);
		expect(clawBlock).not.toContain("@@ignore");
	});

	it("camelCases back-relation list fields", () => {
		const code = generatePrismaSchema({
			schema: {
				claw: {
					fields: {
						id: { type: "string", required: true, primaryKey: true },
					},
				},
				tool_call: {
					fields: {
						id: { type: "string", required: true, primaryKey: true },
						clawId: {
							type: "string",
							required: true,
							references: { model: "claw", field: "id" },
						},
					},
				},
			},
		});
		expect(code).toContain("toolCalls ToolCall[]");
		expect(code).not.toContain("tool_calls");
	});
});

describe("the emitted schema is accepted by Prisma itself", () => {
	// The strongest assertion available: not "the text looks right" but "prisma validate agrees".
	// It catches the whole class of mistakes a string comparison cannot — a relation declared on one
	// side only, a model with no identifier, a scalar Prisma does not have.
	it("passes `prisma validate`", async () => {
		const { execFile } = await import("node:child_process");
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { promisify } = await import("node:util");

		const dir = mkdtempSync(join(tmpdir(), "euroclaw-prisma-"));
		try {
			const models = generatePrismaSchema({ schema: SCHEMA });
			writeFileSync(
				join(dir, "schema.prisma"),
				[
					'datasource db {\n  provider = "postgresql"\n  url = "postgresql://u:p@localhost:5432/d"\n}',
					'generator client {\n  provider = "prisma-client-js"\n}',
					models,
				].join("\n\n"),
				"utf8",
			);

			const { stdout, stderr } = await promisify(execFile)(
				"npx",
				["prisma", "validate", "--schema", join(dir, "schema.prisma")],
				{ cwd: process.cwd() },
			);
			expect(`${stdout}${stderr}`).toContain("is valid");
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	}, 120_000);
});
