// Type tests (vitest typecheck mode). A passing run means each `@ts-expect-error` genuinely errored —
// this file is the executable spec for the request context the `cedar()` SOURCE declares (`{ principal }`)
// being folded onto, and required by, `run(prompt, ctx)`. `cedar()` no longer wraps the engine (that is
// the assembly's internal floor), but connecting it still surfaces the `principal` its policies read.
import { createGovernance } from "@euroclaw/core";
import { describe, test } from "vitest";
import { cedar } from "../src/index";

describe("cedar request-context typing", () => {
	test("a cedar source requires a string `principal` on the context", () => {
		const governed = createGovernance({ plugins: [cedar({ policies: "" })] });
		// principal accepted (string)
		void governed.handleToolCall(
			{ name: "x", args: {} },
			{ principal: "alice" },
		);
		// @ts-expect-error — principal must be a string, not a number
		void governed.handleToolCall({ name: "x", args: {} }, { principal: 123 });
		// @ts-expect-error — principal is required once Cedar is installed
		const missingPrincipal: Parameters<typeof governed.handleToolCall>[1] = {
			notPrincipal: "alice",
		};
		void governed.handleToolCall({ name: "x", args: {} }, missingPrincipal);
	});

	test("the approval flag is server-derived — spoofing type-checks but is a runtime no-op", () => {
		const governed = createGovernance({ plugins: [cedar({ policies: "" })] });
		// The context type is intentionally open beyond required keys, so `confirmationUsed` type-checks
		// here — but a spoofed flag never bypasses approval: the internal engine re-derives it at runtime
		// (see cedar.test.ts, "a confirm-gated policy cannot be satisfied by caller context"). NOT an error.
		void governed.handleToolCall(
			{ name: "x", args: {} },
			{ principal: "alice", confirmationUsed: true },
		);
	});

	test("with no policy plugin, nothing is required — the context stays a free bag", () => {
		const ungoverned = createGovernance({});
		void ungoverned.handleToolCall({ name: "x", args: {} }, {});
	});
});
