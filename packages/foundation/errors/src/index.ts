export type BusyclawErrorCode =
	| "BUSYCLAW_AUTHORIZATION_DENIED"
	| "BUSYCLAW_CONFIGURATION_ERROR"
	| "BUSYCLAW_CONFLICT"
	| "BUSYCLAW_LIMIT_EXCEEDED"
	| "BUSYCLAW_STATE_ERROR"
	| "BUSYCLAW_UNSUPPORTED_OPERATION"
	| "BUSYCLAW_VALIDATION_FAILED";

export type BusyclawErrorInput = {
	code: BusyclawErrorCode;
	message: string;
	details?: Record<string, unknown>;
	cause?: unknown;
};

export class BusyclawError extends Error {
	override name = "BusyclawError";
	readonly code: BusyclawErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(input: BusyclawErrorInput) {
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

/**
 * A short opaque handle joining what one audience was told to what another can read. Correlation,
 * not secrecy — it only has to be unique enough to find one failure in a log.
 */
export function correlationId(): string {
	const source = (globalThis as { crypto?: { randomUUID?: () => string } })
		.crypto;
	return (
		source?.randomUUID?.() ??
		`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
	);
}

/**
 * M-08. The message safe to hand an audience that did not cause the failure — an HTTP caller, a
 * persisted row, an event payload someone else will read.
 *
 * The test is AUTHORSHIP. A {@link BusyclawError} was written to be read: it names a stable code and
 * describes the reader's own situation, so passing it through is the point. Anything else is an
 * accident of the internals — a driver error carrying a fragment of SQL, a `TypeError` naming a
 * private field, a provider failure echoing the content it choked on — and on a redacting deployment
 * it can carry the very values redaction exists to keep out of reach.
 *
 * `onInternal` receives the raw failure and the id the reader was given. It is not optional in
 * spirit: once the message stops travelling, this is the only thing that still knows what happened.
 */
export function safeFailureMessage(
	error: unknown,
	onInternal: (id: string, error: unknown) => void,
): string {
	if (error instanceof BusyclawError) return error.message;
	const id = correlationId();
	onInternal(id, error);
	return `internal error [${id}]`;
}

export function validationError(
	label: string,
	summary: string,
	details?: Record<string, unknown>,
): BusyclawError {
	return new BusyclawError({
		code: "BUSYCLAW_VALIDATION_FAILED",
		message: `${label}: ${summary}`,
		details: { label, summary, ...details },
	});
}

export function configurationError(
	message: string,
	details?: Record<string, unknown>,
): BusyclawError {
	return new BusyclawError({
		code: "BUSYCLAW_CONFIGURATION_ERROR",
		message,
		details,
	});
}

export function stateError(
	message: string,
	details?: Record<string, unknown>,
): BusyclawError {
	return new BusyclawError({
		code: "BUSYCLAW_STATE_ERROR",
		message,
		details,
	});
}

export function unsupportedOperationError(
	message: string,
	details?: Record<string, unknown>,
): BusyclawError {
	return new BusyclawError({
		code: "BUSYCLAW_UNSUPPORTED_OPERATION",
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
): BusyclawError {
	return new BusyclawError({
		code: "BUSYCLAW_AUTHORIZATION_DENIED",
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
): BusyclawError {
	return new BusyclawError({
		code: "BUSYCLAW_CONFLICT",
		message,
		details,
	});
}

/**
 * A resource budget was reached — the request or value is too big, too deep, or too many, and the
 * host declined to spend what handling it would cost.
 *
 * Distinct from {@link validationError} on purpose. "Malformed" invites the caller to fix the value
 * and retry; "too large" tells them the same value will be refused again, and lets an adapter answer
 * with a 413 rather than a 400. It is also never a 500: refusing is the system working.
 */
export function limitError(
	message: string,
	details?: Record<string, unknown>,
): BusyclawError {
	return new BusyclawError({
		code: "BUSYCLAW_LIMIT_EXCEEDED",
		message,
		details,
	});
}

/**
 * Whether this is the recoverable one — the read half of {@link conflictError}.
 *
 * Lives here for the same reason the normalization does: a caller writing try-insert →
 * on-conflict-re-read otherwise tests `code === "BUSYCLAW_CONFLICT"` by hand, and a caller that
 * spells the check slightly wrong turns a recoverable race into a crash on a path that had a correct
 * recovery available. One predicate, one place to be right.
 *
 * Narrow on purpose: an error that is not this exact code is not a conflict, so an unrecognised
 * failure keeps its identity and reaches the caller loud. Never widen this to "looks like a
 * duplicate" — guessing turns a real failure into a silent retry.
 */
export function isConflict(error: unknown): error is BusyclawError {
	return error instanceof BusyclawError && error.code === "BUSYCLAW_CONFLICT";
}
