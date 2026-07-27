// Type test (vitest typecheck mode). ClawLike is the structural surface the dispatch engine
// consumes; this pin is what makes it safe for the channels package to not depend on the busyclaw
// assembly at runtime — if the real product's api drifts away from ClawLike, this file fails.
import type { Claw } from "busyclaw";
import { describe, expectTypeOf, test } from "vitest";
import type { ClawLike } from "../src/index";

describe("ClawLike structural contract", () => {
	test("the assembled Claw satisfies the engine's minimal surface", () => {
		expectTypeOf<Claw>().toMatchTypeOf<ClawLike>();
	});
});
