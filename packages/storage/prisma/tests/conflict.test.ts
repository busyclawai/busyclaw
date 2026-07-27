// Does Prisma really raise P2002, shaped the way the detector reads it?
//
// This was the branch with the least evidence behind it: @busyclaw/storage-core asserts the code and
// that `meta.target` names the offending columns, both taken from documentation rather than from a
// client. This package has a real schema, a real SQLite file and the prisma CLI, so it can just ask.

import { asConflict, isUniqueViolation } from "@busyclaw/storage-core";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prisma = new PrismaClient();

// Scoped to the one row this file writes, never `deleteMany({})`.
//
// `schema.prisma` points at a single shared `file:./test.db`, and prisma.test.ts blanket-wipes the
// same `approval` table in its own afterEach — so with vitest running files in parallel the two
// delete each other's rows mid-test, and an update comes back undefined. It only showed up under
// load, which is what widened the window enough to interleave, so it read as flaky rather than as
// the fixture collision it is.
//
// Scoping this side was not sufficient on its own (it still failed 1 in 3 under load), because the
// collision is symmetric. The package therefore runs its test FILES serially —
// `--no-file-parallelism` in its `test` script — which is the actual fix; this stays because a
// blanket wipe of a shared table is wrong regardless of who else is running.
const OWN_ROW = { id: "dup" };

beforeAll(async () => {
	await prisma.$connect();
	await prisma.approval.deleteMany({ where: OWN_ROW });
});
afterAll(async () => {
	await prisma.approval.deleteMany({ where: OWN_ROW });
	await prisma.$disconnect();
});

describe("prisma", () => {
	it("raises P2002 on a primary-key collision, and the detector recognises it", async () => {
		await prisma.approval.create({ data: { id: "dup", status: "pending" } });
		let error: unknown;
		try {
			await prisma.approval.create({ data: { id: "dup", status: "other" } });
		} catch (raised) {
			error = raised;
		}

		expect(error).toBeDefined();
		expect((error as { code?: unknown }).code).toBe("P2002");
		expect(isUniqueViolation(error)).toBe(true);

		const conflict = asConflict(error, { model: "approval" });
		expect(conflict?.code).toBe("BUSYCLAW_CONFLICT");
		// `meta.target` is what the detector reads to say WHICH constraint failed. Asserted here
		// because its shape is a client detail, not something a hand-built object can vouch for.
		expect(conflict?.details?.constraint).toBeDefined();
	});

	it("leaves a non-unique failure alone", async () => {
		let error: unknown;
		try {
			// P2025: a record to update was not found — a real failure with no recovery.
			await prisma.approval.update({
				where: { id: "missing" },
				data: { status: "x" },
			});
		} catch (raised) {
			error = raised;
		}
		expect(error).toBeDefined();
		expect(isUniqueViolation(error)).toBe(false);
		expect(asConflict(error)).toBeUndefined();
	});
});
