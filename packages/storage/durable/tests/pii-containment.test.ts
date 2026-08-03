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
import { UNCONTAINED } from "@busyclaw/contracts";
import { memoryAdapter } from "@busyclaw/storage-core";
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

// R-M06. The TOMBSTONE write caught every error, not just the duplicate it was written for. So a
// tombstone that failed for any other reason — the table missing, the connection gone, a constraint
// nobody expected — reported a COMPLETED erasure whose standing half had silently not happened: the
// mappings were shredded, and the very next turn naming the same person would mint them again with
// nothing on record to say it must not. Erasure is meant to be an instruction, not a one-time delete.
describe("a tombstone that cannot be written is not a completed erasure", () => {
	const seeded = async (
		adapter: Parameters<typeof createPiiMappingStore>[0],
	) => {
		const store = createPiiMappingStore(adapter);
		await store.save(
			{
				placeholder: NAMESAKE,
				original: "alice@example.com",
				kind: "email",
				createdAt: at,
				scope: "claw",
				scopeId: "c1",
			},
			["alice"],
		);
		return store;
	};

	it("raises when the tombstone write fails for a reason that is not a duplicate", async () => {
		const inner = memoryAdapter();
		const store = await seeded(inner);
		// Only the tombstone write fails, and not as a conflict.
		const broken = {
			...inner,
			create: async (input: { model: string }) => {
				if (input.model === "pii_erasure") {
					throw new Error("ECONNREFUSED: the database is unreachable");
				}
				return inner.create(
					input as Parameters<typeof inner.create>[0],
				) as never;
			},
		} as typeof inner;

		await expect(
			createPiiMappingStore(broken).deleteForSubject("alice"),
		).rejects.toThrow(/ECONNREFUSED/);
		void store;
	});

	// …and a genuine re-erasure is still not an error: the instruction stands, and its first date is
	// the true one.
	it("stays silent when the subject was already tombstoned", async () => {
		const adapter = memoryAdapter();
		const store = await seeded(adapter);
		await expect(store.deleteForSubject("alice")).resolves.toBeGreaterThan(0);
		await expect(store.deleteForSubject("alice")).resolves.toBe(0);
	});
});
