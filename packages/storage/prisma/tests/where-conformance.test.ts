/**
 * The shared where/sort conformance suite, run against a real Prisma client on SQLite.
 *
 * Prisma is the adapter that delegates the most: `contains`, `notIn` and `mode` are handed to the
 * driver rather than translated here, so this run is checking a DEPENDENCY's semantics as much as
 * this repo's code — the class of divergence that appears on a version bump rather than on a commit.
 *
 * The missing-client skip mirrors `prisma.test.ts`: a suite that cannot run says so out loud instead
 * of failing for a missing precondition, and `BUSYCLAW_REQUIRE_PRISMA=1` turns the skip back into a
 * failure wherever these must run.
 */

/// <reference types="node" />
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, it } from "vitest";
import { describeWhereConformance } from "../../core/tests/kit/where-conformance";
import { type PrismaLike, prismaAdapter } from "../src/index";

const prismaClient = (() => {
	try {
		return new PrismaClient();
	} catch (error) {
		if (process.env.BUSYCLAW_REQUIRE_PRISMA === "1") throw error;
		console.warn(
			"@busyclaw/storage-prisma: SKIPPING where-conformance — no generated Prisma client (run `prisma generate`). Set BUSYCLAW_REQUIRE_PRISMA=1 to make this a failure.",
		);
		return undefined;
	}
})();

if (prismaClient === undefined) {
	describe.skip("where/sort conformance — prisma / sqlite", () => {
		it("needs a generated Prisma client", () => undefined);
	});
} else {
	afterAll(async () => {
		await prismaClient.$disconnect();
	});

	describeWhereConformance("prisma / sqlite", {
		// The provider is DECLARED, which is what lets the adapter give a real answer instead of
		// forwarding an unescapable wildcard or an unsupported `mode` to the driver.
		adapter: () =>
			prismaAdapter(prismaClient as unknown as PrismaLike, {
				provider: "sqlite",
			}),
		backend: "sqlite",
		reset: async () => {
			await prismaClient.audit.deleteMany();
			await prismaClient.approval.deleteMany();
		},
	});
}
