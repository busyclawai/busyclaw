// Does Prisma really raise P2002, shaped the way the detector reads it?
//
// This was the branch with the least evidence behind it: @euroclaw/storage-core asserts the code and
// that `meta.target` names the offending columns, both taken from documentation rather than from a
// client. This package has a real schema, a real SQLite file and the prisma CLI, so it can just ask.

import { asConflict, isUniqueViolation } from "@euroclaw/storage-core";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prisma = new PrismaClient();

beforeAll(async () => {
	await prisma.$connect();
	await prisma.approval.deleteMany({});
});
afterAll(async () => {
	await prisma.approval.deleteMany({});
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
		expect(conflict?.code).toBe("EUROCLAW_CONFLICT");
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
