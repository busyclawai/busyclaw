// Type tests (vitest typecheck mode — run by `pnpm test`). Prove the `output` pin on endpoints():
// declaring an output schema constrains the handler's return TYPE to the schema's inferred type
// (sync or promised), so the documented shape and the implementation cannot drift; without `output`
// the handler return stays free. Compile-time only — the schema is never run against results.
import { type } from "arktype";
import { describe, expectTypeOf, test } from "vitest";
import { endpoints } from "../src/index";

const echoInput = type({ value: "string" });
const echoOutput = type({ echoed: "string" });

describe("endpoints() — output pins the handler return type", () => {
	test("a conforming handler compiles, sync or promised", () => {
		const ns = endpoints({
			set: {
				input: echoInput,
				output: echoOutput,
				handler: () => ({ echoed: "ok" }),
			},
			setAsync: {
				input: echoInput,
				output: echoOutput,
				handler: async () => ({ echoed: "ok" }),
			},
		});
		// The namespace still exposes the handler's OWN type (identity, not the schema's).
		expectTypeOf(ns.set).returns.toEqualTypeOf<{ echoed: string }>();
		expectTypeOf(ns.setAsync).returns.toEqualTypeOf<
			Promise<{ echoed: string }>
		>();
	});

	test("a drifted return shape fails to compile", () => {
		endpoints({
			bad: {
				input: echoInput,
				output: echoOutput,
				// @ts-expect-error — the declared output pins the return; `echoed: number` drifts
				handler: () => ({ echoed: 42 }),
			},
		});
	});

	test("the pin reaches definitions nested in groups", () => {
		endpoints({
			packages: {
				create: {
					input: echoInput,
					output: echoOutput,
					// @ts-expect-error — group members are pinned exactly like top-level definitions
					handler: async () => ({ echoed: 42 }),
				},
			},
		});
	});

	test("without output the handler return stays free", () => {
		const ns = endpoints({
			free: { input: echoInput, handler: () => 42 },
		});
		expectTypeOf(ns.free).returns.toEqualTypeOf<number>();
	});
});
