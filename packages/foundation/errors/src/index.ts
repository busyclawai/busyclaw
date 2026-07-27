export type EuroclawErrorCode =
	| "EUROCLAW_AUTHORIZATION_DENIED"
	| "EUROCLAW_CONFIGURATION_ERROR"
	| "EUROCLAW_CONFLICT"
	| "EUROCLAW_STATE_ERROR"
	| "EUROCLAW_UNSUPPORTED_OPERATION"
	| "EUROCLAW_VALIDATION_FAILED";

export type EuroclawErrorInput = {
	code: EuroclawErrorCode;
	message: string;
	details?: Record<string, unknown>;
	cause?: unknown;
};

export class EuroclawError extends Error {
	override name = "EuroclawError";
	readonly code: EuroclawErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(input: EuroclawErrorInput) {
		super(`[${input.code}] ${input.message}`, { cause: input.cause });
		this.code = input.code;
		this.details = input.details;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			details: this.details,
		};
	}
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function validationError(
	label: string,
	summary: string,
	details?: Record<string, unknown>,
): EuroclawError {
	return new EuroclawError({
		code: "EUROCLAW_VALIDATION_FAILED",
		message: `${label}: ${summary}`,
		details: { label, summary, ...details },
	});
}

export function configurationError(
	message: string,
	details?: Record<string, unknown>,
): EuroclawError {
	return new EuroclawError({
		code: "EUROCLAW_CONFIGURATION_ERROR",
		message,
		details,
	});
}

export function stateError(
	message: string,
	details?: Record<string, unknown>,
): EuroclawError {
	return new EuroclawError({
		code: "EUROCLAW_STATE_ERROR",
		message,
		details,
	});
}

export function unsupportedOperationError(
	message: string,
	details?: Record<string, unknown>,
): EuroclawError {
	return new EuroclawError({
		code: "EUROCLAW_UNSUPPORTED_OPERATION",
		message,
		details,
	});
}

/** The app-authz PEP's denial — a governed `claw.api` call the caller may not make (the actor floor
 *  rejected an absent principal, or no policy permitted the action at the required level). Fail-loud,
 *  like the tool-gate denials: a product-API caller learns they were denied, never a silent null. */
export function authorizationError(
	message: string,
	details?: Record<string, unknown>,
): EuroclawError {
	return new EuroclawError({
		code: "EUROCLAW_AUTHORIZATION_DENIED",
		message,
		details,
	});
}

/**
 * A write lost a race against a uniqueness constraint the database enforces.
 *
 * Its own code because it is the one storage failure a caller can RECOVER from rather than merely
 * report: the row it wanted exists, written by whoever got there first, so the answer is to re-read
 * and adopt the winner. Left as a raw driver error that recovery is unwritable — every backend
 * spells the violation differently (Postgres 23505, SQLite SQLITE_CONSTRAINT_UNIQUE, Prisma P2002,
 * Mongo 11000), and Drizzle hands through whichever driver is underneath it. So the normalization
 * has to happen once, below the callers, or each one invents its own partial version of it.
 *
 * `details.constraint` carries the database's own name for the constraint when it gave one — enough
 * to tell WHICH uniqueness was violated when a table has more than one.
 */
export function conflictError(
	message: string,
	details?: Record<string, unknown>,
): EuroclawError {
	return new EuroclawError({
		code: "EUROCLAW_CONFLICT",
		message,
		details,
	});
}

/**
 * Whether this is the recoverable one — the read half of {@link conflictError}.
 *
 * Lives here for the same reason the normalization does: a caller writing try-insert →
 * on-conflict-re-read otherwise tests `code === "EUROCLAW_CONFLICT"` by hand, and a caller that
 * spells the check slightly wrong turns a recoverable race into a crash on a path that had a correct
 * recovery available. One predicate, one place to be right.
 *
 * Narrow on purpose: an error that is not this exact code is not a conflict, so an unrecognised
 * failure keeps its identity and reaches the caller loud. Never widen this to "looks like a
 * duplicate" — guessing turns a real failure into a silent retry.
 */
export function isConflict(error: unknown): error is EuroclawError {
	return error instanceof EuroclawError && error.code === "EUROCLAW_CONFLICT";
}
