import { validationError } from "@euroclaw/contracts";
import { type as ark } from "arktype";
import type {
	GrantActivationInput,
	GrantSkillInput,
	RequestShareInput,
	ShareSkillInput,
} from "./contracts";
import {
	grantActivationInput,
	grantSkillInput,
	requestShareInput,
	shareSkillInput,
} from "./schema";

// The schemas enforce non-empty identity fields and the public⇔principalId correlation
// (grantPrincipal union), so these validators are a parse plus a typed error.
export function assertGrantActivationInput(
	input: unknown,
): GrantActivationInput {
	const valid = grantActivationInput(input) as
		| GrantActivationInput
		| ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("grant activation input invalid", valid.summary);
	}
	return valid;
}

export function assertGrantSkillInput(input: unknown): GrantSkillInput {
	const valid = grantSkillInput(input) as GrantSkillInput | ark.errors;
	if (valid instanceof ark.errors) {
		throw validationError("grant skill input invalid", valid.summary);
	}
	return valid;
}

export function assertRequestShareInput(input: unknown): RequestShareInput {
	const valid = requestShareInput(input);
	if (valid instanceof ark.errors) {
		throw validationError("request share input invalid", valid.summary);
	}
	return valid;
}

export function assertShareSkillInput(input: unknown): ShareSkillInput {
	const valid = shareSkillInput(input);
	if (valid instanceof ark.errors) {
		throw validationError("share skill input invalid", valid.summary);
	}
	return valid;
}
