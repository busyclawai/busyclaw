// Recognising a uniqueness violation, whoever raised it.
//
// A caller that wants try-insert → on-conflict-re-read needs to know that its write lost a race and
// not merely that "something failed". Every backend says so differently, so without one place to ask
// this, each caller invents a partial version — and a partial version is worse than none, because
// the case it misses is a crash on a path that had a correct recovery available.
//
// Detection is by DRIVER, not by adapter, which is what makes the awkward case fall out for free:
// Drizzle raises whatever its underlying driver raised, so a Drizzle-on-pg setup lands on the
// Postgres branch and a Drizzle-on-better-sqlite3 setup on the SQLite one, with nothing to add here.
// Kysely is the same. Only Prisma and Mongo, which wrap their drivers in their own error types, need
// branches of their own.
//
// Deliberately conservative: an unrecognised error is NOT a conflict and passes through untouched.
// Guessing wrong turns a real failure into a silent retry loop, which is a far worse trade than
// leaving one exotic driver unrecognised and loud.

import { conflictError, type BusyclawError } from "@busyclaw/contracts";

/** The shapes a driver error can carry, none of them guaranteed. */
type DriverError = {
	code?: unknown;
	name?: unknown;
	message?: unknown;
	constraint?: unknown;
	meta?: { target?: unknown };
	keyPattern?: Record<string, unknown>;
};

function asDriverError(error: unknown): DriverError | undefined {
	return typeof error === "object" && error !== null
		? (error as DriverError)
		: undefined;
}

const messageOf = (error: DriverError): string =>
	typeof error.message === "string" ? error.message : "";

/**
 * Whether this error is a database saying "that row already exists".
 *
 * | driver | how it says so |
 * |---|---|
 * | Postgres (`pg`) | SQLSTATE `23505` |
 * | SQLite (better-sqlite3) | `SQLITE_CONSTRAINT_UNIQUE` / `_PRIMARYKEY` |
 * | Prisma | `P2002` |
 * | MongoDB | code `11000` (`E11000`) |
 *
 * Kysely and Drizzle appear nowhere because they raise their driver's error unchanged.
 */
export function isUniqueViolation(error: unknown): boolean {
	const driver = asDriverError(error);
	if (driver === undefined) return false;
	const code = driver.code;

	// Postgres: the SQLSTATE for unique_violation.
	if (code === "23505") return true;
	// Prisma: "Unique constraint failed on the fields".
	if (code === "P2002") return true;
	// MongoDB: duplicate key. Numeric here, string elsewhere — hence no loose compare.
	if (code === 11000 || code === "11000") return true;
	// better-sqlite3 distinguishes the unique index from the primary key; both are this.
	if (
		code === "SQLITE_CONSTRAINT_UNIQUE" ||
		code === "SQLITE_CONSTRAINT_PRIMARYKEY"
	) {
		return true;
	}
	// Some SQLite bindings report only the generic constraint code, leaving the specific violation
	// in the message. Matched only under that generic code, never on message text alone.
	if (code === "SQLITE_CONSTRAINT") {
		const message = messageOf(driver);
		return (
			message.includes("UNIQUE constraint failed") ||
			message.includes("PRIMARY KEY must be unique")
		);
	}
	return false;
}

/** The constraint's own name, when the driver named it — enough to tell WHICH uniqueness failed on
 *  a table carrying more than one. */
function constraintOf(error: DriverError): string | undefined {
	if (typeof error.constraint === "string") return error.constraint; // pg
	const target = error.meta?.target; // prisma
	if (typeof target === "string") return target;
	if (Array.isArray(target)) return target.join(", ");
	if (error.keyPattern !== undefined) {
		return Object.keys(error.keyPattern).join(", "); // mongo
	}
	return undefined;
}

/**
 * Normalize a unique violation into {@link conflictError}, or hand back `undefined` for anything
 * else so the caller rethrows the original.
 *
 * Returning rather than throwing keeps the decision at the call site: this function never decides
 * that an error it does not recognise is safe to swallow.
 */
export function asConflict(
	error: unknown,
	context?: { model?: string; operation?: string },
): BusyclawError | undefined {
	if (!isUniqueViolation(error)) return undefined;
	const driver = asDriverError(error) ?? {};
	const constraint = constraintOf(driver);
	const where = context?.model === undefined ? "" : ` on "${context.model}"`;
	return conflictError(
		`unique constraint violated${where}${constraint === undefined ? "" : ` (${constraint})`}`,
		{
			...(context?.model !== undefined ? { model: context.model } : {}),
			...(context?.operation !== undefined
				? { operation: context.operation }
				: {}),
			...(constraint !== undefined ? { constraint } : {}),
			cause: messageOf(driver),
		},
	);
}
