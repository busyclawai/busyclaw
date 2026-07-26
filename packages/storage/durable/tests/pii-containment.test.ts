// Container exactness on the WRITE and ERASE paths — the property that made `(scope, scopeId)`
// required.
//
// Word-code placeholders are minted with a collision check scoped to ONE container, so the same token
// legitimately exists in several: a namesake is expected, not a clash. Every store predicate therefore
// has to name the whole container. While the columns were nullable the predicates were assembled
// conditionally, and a row with no container produced a where of `placeholder` alone — which matches
// the namesake in every other container, so a context-less erasure destroyed another claw's mapping.
// The two erase cases below are the regression; the write cases are the guard on the neighbouring path
// that survived only because `sameContainer` happened to reject the match first.
//
// UNCONTAINED is the interesting case precisely because it used to be the NULL one. It is a container
// like any other here, and containment has to hold between it and a real one in both directions.
import { UNCONTAINED } from "@euroclaw/contracts";
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createPiiMappingStore } from "../src/pii";

const at = "2026-07-27T00:00:00.000Z";

/** The same placeholder in two containers — the namesake the old predicates could not tell apart. */
const NAMESAKE = "{{pii:email:calm-otter-brisk-vine}}";

describe("PII mappings are contained on write and erase", () => {
	it("erasing an uncontained subject leaves a namesake in a real container intact", async () => {
		const store = createPiiMappingStore(memoryAdapter());
		await store.save(
			{
				placeholder: NAMESAKE,
				original: "nobody@example.com",
				kind: "email",
				...UNCONTAINED,
				createdAt: at,
			},
			["subject-uncontained"],
		);
		await store.save(
			{
				placeholder: NAMESAKE,
				original: "alice@example.com",
				kind: "email",
				scope: "claw",
				scopeId: "alice-claw",
				createdAt: at,
			},
			["subject-alice"],
		);

		await store.deleteForSubject("subject-uncontained");

		// Erased where it was asked for...
		expect(await store.resolve(NAMESAKE, UNCONTAINED)).toBeNull();
		// ...and NOT in a container the erasure was never about. Alice did not ask to be forgotten, and
		// an unrelated subject's erasure must never be able to destroy her rehydration.
		expect(
			await store.resolve(NAMESAKE, { scope: "claw", scopeId: "alice-claw" }),
		).toBe("alice@example.com");
	});

	it("erasing a contained subject leaves the namesake in every other container intact", async () => {
		const store = createPiiMappingStore(memoryAdapter());
		for (const scopeId of ["a", "b"]) {
			await store.save(
				{
					placeholder: NAMESAKE,
					original: `${scopeId}@example.com`,
					kind: "email",
					scope: "claw",
					scopeId,
					createdAt: at,
				},
				[`subject-${scopeId}`],
			);
		}

		await store.deleteForSubject("subject-a");

		expect(await store.resolve(NAMESAKE, { scope: "claw", scopeId: "a" })).toBe(
			null,
		);
		expect(await store.resolve(NAMESAKE, { scope: "claw", scopeId: "b" })).toBe(
			"b@example.com",
		);
	});

	it("saving into one container never rewrites the namesake in another", async () => {
		const store = createPiiMappingStore(memoryAdapter());
		await store.save({
			placeholder: NAMESAKE,
			original: "alice@example.com",
			kind: "email",
			scope: "claw",
			scopeId: "alice-claw",
			createdAt: at,
		});
		// An uncontained write of the SAME token. If this ever landed on Alice's row, her placeholder
		// would start rehydrating to someone else's address — a re-identification failure, not merely a
		// lost write. It takes the create branch because the container is part of the identity.
		await store.save({
			placeholder: NAMESAKE,
			original: "nobody@example.com",
			kind: "email",
			...UNCONTAINED,
			createdAt: at,
		});

		expect(
			await store.resolve(NAMESAKE, { scope: "claw", scopeId: "alice-claw" }),
		).toBe("alice@example.com");
		expect(await store.resolve(NAMESAKE, UNCONTAINED)).toBe(
			"nobody@example.com",
		);
	});

	it("a rehydration with no context reaches only the uncontained container", async () => {
		const store = createPiiMappingStore(memoryAdapter());
		await store.save({
			placeholder: NAMESAKE,
			original: "alice@example.com",
			kind: "email",
			scope: "claw",
			scopeId: "alice-claw",
			createdAt: at,
		});

		// No context at all, and a HALF context — both normalize to UNCONTAINED, so neither can read
		// Alice's value. A half-named container used to be its own bucket, distinct from both.
		expect(await store.resolve(NAMESAKE)).toBeNull();
		expect(await store.resolve(NAMESAKE, { scope: "claw" })).toBeNull();
		expect(await store.resolve(NAMESAKE, { scopeId: "alice-claw" })).toBeNull();
	});
});
