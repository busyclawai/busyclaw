// The generated egress ceiling — its TEXT. What it emits, and the shape properties it must not
// lose. Whether Cedar agrees with the text is a separate question, asked where a Cedar engine is
// actually reachable: runtime does not depend on @busyclaw/authz, and a test is not a reason to add
// the edge. See packages/busyclaw/tests/spec-egress-ceiling.test.ts for the evaluation half.

import { describe, expect, it } from "vitest";
import {
	egressPolicySliceName,
	generateEgressPolicy,
} from "../src/tools/spec-egress-policy";

const PETSTORE = "https://api.petstore.example";
const OTHER = "https://files.petstore.example";

const gen = (operations: { address: string; origin: string }[]) =>
	generateEgressPolicy({ source: "petstore", operations });

describe("generateEgressPolicy", () => {
	it("names the source's action group and its one origin", () => {
		const policy = gen([{ address: "petstore.getPet", origin: PETSTORE }]);
		expect(policy).toContain('action in Action::"source:petstore"');
		expect(policy).toContain(`context.server == "${PETSTORE}"`);
	});

	it("emits FORBID only — never a permit, whatever the spec said", () => {
		const policy = gen([
			{ address: "petstore.getPet", origin: PETSTORE },
			{ address: "petstore.addPet", origin: OTHER },
		]);
		expect(policy).not.toContain("permit");
	});

	it("a single-origin source gets ONE statement — per-operation rules would restate it", () => {
		const policy = gen([
			{ address: "petstore.getPet", origin: PETSTORE },
			{ address: "petstore.addPet", origin: PETSTORE },
			{ address: "petstore.listPets", origin: PETSTORE },
		]);
		expect(policy?.match(/forbid/g)).toHaveLength(1);
		expect(policy).not.toContain("petstore.getPet");
	});

	it("a MULTI-origin source gets the source rule plus one rule per operation", () => {
		const policy = gen([
			{ address: "petstore.getPet", origin: PETSTORE },
			{ address: "petstore.upload", origin: OTHER },
		]);
		// The source rule (both origins) + one per operation.
		expect(policy?.match(/forbid/g)).toHaveLength(3);
		expect(policy).toContain('action == Action::"petstore.getPet"');
		expect(policy).toContain('action == Action::"petstore.upload"');
	});

	it("is byte-stable across extraction order — a re-registration reports no change", () => {
		const a = gen([
			{ address: "petstore.upload", origin: OTHER },
			{ address: "petstore.getPet", origin: PETSTORE },
		]);
		const b = gen([
			{ address: "petstore.getPet", origin: PETSTORE },
			{ address: "petstore.upload", origin: OTHER },
		]);
		expect(a).toBe(b);
	});

	it("no operations ⇒ no slice, rather than a ceiling that holds nothing", () => {
		expect(gen([])).toBeUndefined();
	});

	it("the slice name is the reserved one", () => {
		expect(egressPolicySliceName("petstore")).toBe("petstore.egress");
	});
});
