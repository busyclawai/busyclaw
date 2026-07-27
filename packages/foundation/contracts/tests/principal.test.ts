import { describe, expect, it } from "vitest";
import {
	EuroclawError,
	type Principal,
	parsePrincipal,
	SYSTEM_ANONYMOUS,
	systemPrincipal,
	userPrincipal,
} from "../src/index";

// Every malformed-input path raises the same contracts validationError — a real EuroclawError with the
// validation code, not a bare throw. This mirrors the secrets suite's assertion style.
function expectValidationError(fn: () => Principal | { kind: string }): void {
	let caught: unknown;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(EuroclawError);
	expect(caught).toMatchObject({ code: "EUROCLAW_VALIDATION_FAILED" });
}

describe("Principal — the tagged authorizable identity", () => {
	it("round-trips a user principal through construct → parse", () => {
		expect(parsePrincipal(userPrincipal("alice"))).toEqual({
			kind: "user",
			id: "alice",
		});
	});

	it("round-trips a system principal through construct → parse", () => {
		expect(parsePrincipal(systemPrincipal("cron"))).toEqual({
			kind: "system",
			id: "cron",
		});
	});

	it("splits on the FIRST colon so an id may itself contain colons", () => {
		expect(parsePrincipal("user:auth0|abc:xyz")).toEqual({
			kind: "user",
			id: "auth0|abc:xyz",
		});
	});

	it("rejects a value with no colon", () => {
		expectValidationError(() => parsePrincipal("alice"));
	});

	it("rejects an empty kind", () => {
		expectValidationError(() => parsePrincipal(":alice"));
	});

	it("rejects an empty id", () => {
		expectValidationError(() => parsePrincipal("user:"));
	});

	it("rejects an unknown kind — an org is not a principal", () => {
		expectValidationError(() => parsePrincipal("org:acme"));
	});

	it("rejects an unknown kind even when the id contains colons", () => {
		// split-on-first → kind "external", id "telegram:9" → still not a principal.
		expectValidationError(() => parsePrincipal("external:telegram:9"));
	});

	it("userPrincipal rejects an empty or blank id", () => {
		expectValidationError(() => userPrincipal(""));
		expectValidationError(() => userPrincipal("   "));
	});

	it("systemPrincipal rejects an empty or blank name", () => {
		expectValidationError(() => systemPrincipal(""));
		expectValidationError(() => systemPrincipal("\t "));
	});

	it("exposes the well-known system principal as its canonical tag", () => {
		expect(SYSTEM_ANONYMOUS).toBe("system:anonymous");
	});

	it("has no scheduler principal — a scheduled run belongs to a claw and a delegator", async () => {
		// `SYSTEM_CRON` used to sit beside SYSTEM_ANONYMOUS as a well-known tag. It was never used by
		// any product code, and it modelled something false: a cron tick processes DUE CLAWS, so a
		// scheduled run carries the claw it belongs to and the principal of whoever delegated it.
		//
		// An anonymous scheduler identity erased both. The approval such a run parks would have no
		// owner to authorize against — which is exactly how "any authenticated human may decide" got
		// justified — and the audit would record a machine asking for work a person had asked for.
		// A host that really wants one can still build it; euroclaw no longer suggests it.
		expect(Object.keys(await import("../src/index"))).not.toContain(
			"SYSTEM_CRON",
		);
	});
});
