// The generated egress ceiling — its TEXT. What it emits, and the shape properties it must not
// lose. Whether Cedar agrees with the text is a separate question, asked where a Cedar engine is
// actually reachable: runtime does not depend on @busyclaw/authz, and a test is not a reason to add
// the edge. See packages/busyclaw/tests/spec-egress-ceiling.test.ts for the evaluation half.

import { describe, expect, it } from "vitest";
import {
	normalizeOrigin,
	planHttpRequest,
} from "../src/tools/invoke/request-plan";
import type { OpenApiBinding } from "../src/tools/sources/openapi/binding";
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

// The `enforce`-on-write argument, checked rather than reasoned about.
//
// A generated ceiling is written straight to `enforce` on the claim that it cannot refuse a call the
// invoker would have made — both read the SAME `binding.server` through the SAME `normalizeOrigin`.
// That is an argument about two code paths agreeing, and arguments about code paths agreeing are
// exactly the ones worth running. The case that would break it is a document whose `servers:` entry
// is not where its operations actually land.
describe("the ceiling and the request agree, by construction", () => {
	const binding = (server: string): OpenApiBinding => ({
		method: "get",
		path: "/pets/{petId}",
		server,
		parameters: [{ name: "petId", in: "path", required: true }],
		security: [],
	});

	const ceilingOrigin = (server: string) => {
		const policy = generateEgressPolicy({
			source: "petstore",
			operations: [
				{ address: "petstore.getPet", origin: normalizeOrigin(server) },
			],
		});
		const found = /context\.server == "([^"]+)"/.exec(policy ?? "");
		return found?.[1];
	};

	// Each of these is a server URL that does NOT look like its own origin — a base path, a default
	// port written out, mixed case, a trailing slash. If the ceiling and the request derived them
	// differently, one of these is where it would show.
	for (const server of [
		"https://api.petstore.example/v1",
		"https://api.petstore.example:443/v1",
		"https://API.Petstore.Example/v1/",
		"https://api.petstore.example",
	]) {
		it(`agrees for ${server}`, () => {
			const planned = planHttpRequest(binding(server), { petId: "7" });
			expect(ceilingOrigin(server)).toBe(planned.origin);
			// And the planned URL actually starts at that origin — so the fact the policy tests is the
			// place the request goes, not merely a string that matches it.
			expect(planned.url.startsWith(planned.origin)).toBe(true);
		});
	}

	it("a spec-declared server the operation does not reach is a FAILURE, not a bypass", () => {
		// The origin is never taken from the model or the args — it comes from `binding.server`, and
		// the request is BUILT from it. So a document naming a host its operations do not serve sends
		// the request to the named host and gets an error there; there is no path where the ceiling
		// approves one destination and the invoker dials another. Redirects cannot reopen it either:
		// the invoker does not follow them, so a 3xx is data the caller may act on, not a hop.
		const planned = planHttpRequest(
			binding("https://docs.petstore.example/v1"),
			{ petId: "7" },
		);
		expect(planned.origin).toBe("https://docs.petstore.example");
		expect(ceilingOrigin("https://docs.petstore.example/v1")).toBe(
			planned.origin,
		);
	});
});
