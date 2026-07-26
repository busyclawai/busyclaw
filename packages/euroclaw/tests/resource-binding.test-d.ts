// Type tests (vitest typecheck mode). The property under test has now outlived two implementations of
// itself: a method's authz declaration must be checked against THAT METHOD'S input, so pointing it at a
// field the method does not have cannot compile. It began as a central `CORE_API_RESOURCES` map typing
// `idKey` as a bare `string` (a wrong key compiled and only failed closed at runtime), became a
// co-located binding with `idKey extends keyof Input`, and is now a RESOLVER whose parameter *is* the
// validated input — the strongest form, because it constrains what the resolver may compute rather than
// only which key it may name.
//
// Every `@ts-expect-error` below is an assertion: if a case ever starts compiling, tsc reports the
// directive as unused and this file fails the build.
import type { AuthzTarget } from "@euroclaw/contracts";
import { describe, test } from "vitest";
import type { ClawApiMethodInput } from "../src/api";

describe("authz resolvers are type-checked against their own method's input", () => {
	test("a resolver may only read fields the method's input declares", () => {
		// getClaw's input is `{ id: string }`.
		const good = (input: ClawApiMethodInput<"getClaw">): AuthzTarget => ({
			kind: "claw",
			id: input.id,
		});
		void good;

		const bad = (input: ClawApiMethodInput<"getClaw">): AuthzTarget => ({
			kind: "claw",
			// @ts-expect-error — "clawId" is not a key of getClaw's input ({ id: string })
			id: input.clawId,
		});
		void bad;
	});

	test("a claw-anchored method resolves through a field it actually has", () => {
		// sendMessage carries BOTH clawId and threadId, so the mistake types CANNOT catch here is picking
		// the wrong one of the two. What they do catch is a field that does not exist at all — which is
		// why the boot coverage walk and the cross-principal tests still have to exist.
		const good = (input: ClawApiMethodInput<"sendMessage">): AuthzTarget => ({
			kind: "claw",
			id: input.clawId,
		});
		void good;

		const bad = (input: ClawApiMethodInput<"sendMessage">): AuthzTarget => ({
			kind: "claw",
			// @ts-expect-error — sendMessage has no `runId`
			id: input.runId,
		});
		void bad;
	});

	test("a scope target needs BOTH halves of the boundary from the input", () => {
		const good = (
			input: ClawApiMethodInput<"putPolicySlice">,
		): AuthzTarget => ({
			scope: input.scope,
			scopeId: input.scopeId,
		});
		void good;

		// A target is `{kind,id}` OR `{scope,scopeId}`, never half of either — so a boundary with no id
		// cannot reach the decision as though it named something.
		const bad = (input: ClawApiMethodInput<"putPolicySlice">): AuthzTarget =>
			// @ts-expect-error — `{ scope }` alone is not an AuthzTarget
			({ scope: input.scope });
		void bad;
	});

	test("a resolver must return a target, not an arbitrary object", () => {
		const bad = (input: ClawApiMethodInput<"getClaw">): AuthzTarget =>
			// @ts-expect-error — neither a {kind,id} nor a {scope,scopeId} target
			({ somethingElse: input.id });
		void bad;
	});
});
