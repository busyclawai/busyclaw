// Uniqueness-violation normalization.
//
// The DETECTOR's own logic, with no driver anywhere near it: which codes count, which do not, and
// what it refuses to guess. This package owns the rule, so this is where the rule is pinned.
//
// Whether each driver actually raises what the rule expects is a question only that driver can
// answer, so it is asked in each adapter's own suite — kysely, drizzle, prisma and mongodb each
// provoke a real violation and assert this function recognises it. Proving it here would mean
// storage-core taking a dev dependency on four databases to test twenty lines of branching.

import { BusyclawError } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { asConflict, isUniqueViolation } from "../src/conflict";

describe("isUniqueViolation — by driver", () => {
	it("recognises Postgres 23505", () => {
		expect(
			isUniqueViolation({ code: "23505", constraint: "claw_slug_uidx" }),
		).toBe(true);
	});

	it("recognises Prisma P2002", () => {
		expect(
			isUniqueViolation({ code: "P2002", meta: { target: ["scope", "hash"] } }),
		).toBe(true);
	});

	it("recognises Mongo 11000, numeric or string", () => {
		expect(isUniqueViolation({ code: 11000 })).toBe(true);
		expect(isUniqueViolation({ code: "11000" })).toBe(true);
	});

	it("recognises SQLite's specific and generic constraint codes", () => {
		expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
		expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" })).toBe(
			true,
		);
		expect(
			isUniqueViolation({
				code: "SQLITE_CONSTRAINT",
				message: "UNIQUE constraint failed: claw.slug",
			}),
		).toBe(true);
	});

	it("does NOT guess from message text alone", () => {
		// A retry loop entered on a misread error is worse than a loud unrecognised one, so the
		// message is only consulted under a constraint code that says it is a constraint failure.
		expect(
			isUniqueViolation({ message: "UNIQUE constraint failed: claw.slug" }),
		).toBe(false);
		expect(isUniqueViolation({ code: "23503" })).toBe(false); // foreign key, not unique
		expect(isUniqueViolation({ code: "P2003" })).toBe(false);
		expect(isUniqueViolation(new Error("boom"))).toBe(false);
		expect(isUniqueViolation(undefined)).toBe(false);
		expect(isUniqueViolation("23505")).toBe(false);
	});
});

describe("asConflict", () => {
	it("returns undefined for anything it does not recognise, so the caller rethrows", () => {
		expect(asConflict(new Error("boom"))).toBeUndefined();
	});

	it("carries the constraint name each driver spells differently", () => {
		expect(
			asConflict({ code: "23505", constraint: "pii_scope_hash_uq" })?.details
				?.constraint,
		).toBe("pii_scope_hash_uq");
		expect(
			asConflict({ code: "P2002", meta: { target: ["scope", "hash"] } })
				?.details?.constraint,
		).toBe("scope, hash");
		expect(
			asConflict({ code: 11000, keyPattern: { scope: 1, hash: 1 } })?.details
				?.constraint,
		).toBe("scope, hash");
	});

	it("is a BusyclawError carrying the stable conflict code", () => {
		const conflict = asConflict({ code: "23505" });
		expect(conflict).toBeInstanceOf(BusyclawError);
		expect(conflict?.code).toBe("BUSYCLAW_CONFLICT");
	});

	it("names the model and operation it was given", () => {
		const conflict = asConflict(
			{ code: "23505" },
			{ model: "pii_mapping", operation: "create" },
		);
		expect(conflict?.code).toBe("BUSYCLAW_CONFLICT");
		expect(conflict?.message).toContain("pii_mapping");
		expect(conflict?.details?.operation).toBe("create");
	});
});
