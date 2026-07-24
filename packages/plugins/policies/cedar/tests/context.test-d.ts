// Type tests (vitest typecheck mode). A passing run means each `@ts-expect-error` genuinely errored —
// this file is the executable spec for the request context the `cedar()` SOURCE folds onto
// `run(prompt, ctx)`. Audit #7: `cedar()` NO LONGER requires (or types) a caller-supplied `principal`
// on the ctx. The acting identity is the ONE stamped `euroclaw__principal`, SEEDED by the trusted
// context assembly from the authenticated caller — never a caller-typed ctx field (reading that was
// the #7 impersonation vector). So the fold is an OPEN turn context: nothing is required, and a
// `principal` key — if a caller still passes one — is inert (the mapper reads only the stamp).
import { createGovernance } from "@euroclaw/core";
import { describe, test } from "vitest";
import { cedar } from "../src/index";

describe("cedar request-context typing", () => {
	test("a cedar source folds an OPEN context — no caller-supplied principal required", () => {
		const governed = createGovernance({ plugins: [cedar({ policies: "" })] });
		// An empty ctx type-checks: the principal is seeded server-side, NOT a required caller field.
		// (If nothing seeds it, the tool floor fails closed at RUNTIME — a deny, not a type error.)
		void governed.handleToolCall({ name: "x", args: {} }, {});
		// Arbitrary keys are accepted — the ctx stays a free bag even with Cedar installed.
		void governed.handleToolCall(
			{ name: "x", args: {} },
			{ notPrincipal: "alice" },
		);
		// A `principal` key still type-checks (the ctx is open) but is INERT: the mapper reads only the
		// stamped euroclaw__principal, so a caller-supplied `principal` never drives the decision (#7).
		void governed.handleToolCall(
			{ name: "x", args: {} },
			{ principal: "alice" },
		);
	});

	test("the approval flag is server-derived — spoofing type-checks but is a runtime no-op", () => {
		const governed = createGovernance({ plugins: [cedar({ policies: "" })] });
		// The context type is intentionally open, so `confirmationUsed` type-checks here — but a spoofed
		// flag never bypasses approval: the internal engine re-derives it at runtime (see cedar.test.ts,
		// "a confirm-gated policy cannot be satisfied by caller context"). NOT an error.
		void governed.handleToolCall(
			{ name: "x", args: {} },
			{ confirmationUsed: true },
		);
	});

	test("with no policy plugin, nothing is required — the context stays a free bag", () => {
		const ungoverned = createGovernance({});
		void ungoverned.handleToolCall({ name: "x", args: {} }, {});
	});
});
