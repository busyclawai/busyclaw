// The generated egress ceiling — EVALUATED. The text-shape half lives in
// packages/runtime/tests/spec-egress-policy.test.ts; this asks whether Cedar agrees with it, which
// needs an engine, which is why it is here rather than beside the generator.
//
// Every case runs under a blanket permit, so the ONLY thing that can produce a deny is the generated
// forbid — a ceiling that quietly matched nothing would show up as a permit, not as a pass.

import { buildAuthzModel, cedarFloorEngine } from "@busyclaw/authz";
import { generateEgressPolicy } from "@busyclaw/runtime";
import { describe, expect, it } from "vitest";

const PETSTORE = "https://api.petstore.example";

const gen = (operations: { address: string; origin: string }[]) =>
	generateEgressPolicy({ source: "petstore", operations });

describe("the ceiling, evaluated", () => {
	const model = buildAuthzModel([
		{
			id: "petstore.getPet",
			source: "tool",
			governance: { access: "read", groups: ["source:petstore"] },
		},
		{
			id: "notes.save",
			source: "tool",
			governance: { access: "read", groups: ["source:notes"] },
		},
	]);

	const decide = async (policy: string, action: string, server?: string) => {
		const engine = cedarFloorEngine({
			policies: {
				open: "permit(principal, action, resource);",
				ceiling: policy,
			},
			model,
		});
		const result = await engine.authorize({
			principal: { type: "User", id: "alice" },
			action: { type: "Action", id: action },
			resource: { type: "Tool", id: action },
			context: {
				confirmationUsed: false,
				...(server !== undefined ? { server } : {}),
			},
		});
		return result.decision;
	};

	const CEILING = gen([{ address: "petstore.getPet", origin: PETSTORE }]) ?? "";

	it("permits the origin the spec declared", async () => {
		expect(await decide(CEILING, "petstore.getPet", PETSTORE)).toBe("permit");
	});

	it("denies any other origin", async () => {
		expect(
			await decide(CEILING, "petstore.getPet", "https://evil.example"),
		).toBe("deny");
	});

	it("leaves actions outside the source alone", async () => {
		expect(await decide(CEILING, "notes.save")).toBe("permit");
	});

	// THE property the `has` guard exists for. `server` is an optional attribute; testing it bare on
	// an action that carries none is an evaluation error, and Cedar SKIPS an erroring forbid — so the
	// unguarded form fails OPEN on exactly the actions that declared no destination. Both halves are
	// asserted: the guarded form refuses, and the unguarded one is shown permitting, so the reason
	// this is written the way it is stays visible to whoever edits it next.
	it("guarded: an in-source action with NO declared origin is refused (fail closed)", async () => {
		expect(await decide(CEILING, "petstore.getPet")).toBe("deny");
	});

	it("UNGUARDED would fail OPEN on the same call — why the guard is not optional", async () => {
		const unguarded = `forbid(principal, action in Action::"source:petstore", resource)
unless { context.server == "${PETSTORE}" };`;
		expect(await decide(unguarded, "petstore.getPet")).toBe("permit");
	});
});
