// Does Drizzle really hand its driver's error through untouched?
//
// The detector has no Drizzle branch, and that is a DESIGN CLAIM rather than an oversight: Drizzle
// wraps a driver but not, supposedly, its errors — so a Drizzle-on-sqlite setup should land on the
// SQLite branch with nothing added. That claim was asserted in a comment and tested nowhere, which
// is the kind of thing that is true right up until a version bump makes it false.

import { asConflict, isUniqueViolation } from "@euroclaw/storage-core";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";

const claw = sqliteTable("claw", {
	id: text("id").primaryKey(),
	slug: text("slug").unique(),
});

let db: ReturnType<typeof drizzle>;

beforeEach(() => {
	const sqlite = new Database(":memory:");
	sqlite.exec(
		"create table claw (id text primary key not null, slug text unique)",
	);
	db = drizzle(sqlite);
});

describe("sqlite through drizzle", () => {
	it("passes the driver's violation through, so the sqlite branch still matches", async () => {
		await db.insert(claw).values({ id: "a", slug: "one" });
		let error: unknown;
		try {
			await db.insert(claw).values({ id: "b", slug: "one" });
		} catch (raised) {
			error = raised;
		}

		expect(error).toBeDefined();
		// If Drizzle ever starts wrapping driver errors, this is what catches it — and the detector
		// would then need a branch of its own rather than relying on the passthrough.
		expect(isUniqueViolation(error)).toBe(true);
		expect(asConflict(error, { model: "claw" })?.code).toBe(
			"EUROCLAW_CONFLICT",
		);
	});

	it("leaves a non-unique failure alone", async () => {
		let error: unknown;
		try {
			await db.run("insert into nope (id) values ('a')" as never);
		} catch (raised) {
			error = raised;
		}
		expect(error).toBeDefined();
		expect(isUniqueViolation(error)).toBe(false);
	});
});
