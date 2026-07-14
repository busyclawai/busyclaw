export type EuroclawErrorCode =
	| "EUROCLAW_AUTHORIZATION_DENIED"
	| "EUROCLAW_CONFIGURATION_ERROR"
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
