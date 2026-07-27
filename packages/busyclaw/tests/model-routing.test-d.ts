// Type tests (vitest typecheck mode). Prove the multi-model spine: a const-captured `models` pool
// makes run()'s `model` option the pool's LITERAL keys (typo → compile error), a single `model`
// offers no run-level selection at all, and createClaw itself requires exactly one model source.
import { describe, expectTypeOf, test } from "vitest";
import { createClaw } from "../src/index";
import { textModel } from "./fixtures";

describe("model routing — type safety", () => {
	test("a models pool gives run() literal, type-safe model names", () => {
		const claw = createClaw({
			models: {
				fast: textModel("fast"),
				smart: { model: textModel("smart"), default: true },
			},
		});
		const run = claw.$context.runtime.generate;
		type Opts = NonNullable<Parameters<typeof run>[2]>;
		expectTypeOf<Opts["model"]>().toEqualTypeOf<"fast" | "smart" | undefined>();

		run("hi", undefined, { model: "fast" }); // ok
		run("hi", undefined, { model: "smart" }); // ok
		run("hi"); // ok — default
		// @ts-expect-error — "typo" is not a name in the pool
		run("hi", undefined, { model: "typo" });
	});

	test("api.run and sendMessage narrow `model` to the pool keys too", () => {
		const claw = createClaw({
			models: {
				fast: textModel("fast"),
				smart: { model: textModel("smart"), default: true },
			},
		});
		claw.api.generate({ prompt: "hi", options: { model: "fast" } }); // ok
		// @ts-expect-error — "typo" is not a name in the pool
		claw.api.generate({ prompt: "hi", options: { model: "typo" } });

		claw.api.sendMessage({
			clawId: "c",
			threadId: "t",
			message: "hi",
			model: "smart",
		}); // ok
		claw.api.sendMessage({
			clawId: "c",
			threadId: "t",
			message: "hi",
			// @ts-expect-error — "typo" is not a name in the pool
			model: "typo",
		});
	});

	test("≥2 models with NO default → model selection is REQUIRED (must ask)", () => {
		const claw = createClaw({
			models: { fast: textModel("fast"), smart: textModel("smart") }, // no default
		});
		claw.api.generate({ prompt: "hi", options: { model: "fast" } }); // ok
		// @ts-expect-error — options carrying `model` is required when the pool has no default
		claw.api.generate({ prompt: "hi" });

		claw.api.sendMessage({
			clawId: "c",
			threadId: "t",
			message: "hi",
			model: "fast",
		}); // ok
		// @ts-expect-error — `model` is required when the pool has no default
		claw.api.sendMessage({ clawId: "c", threadId: "t", message: "hi" });
	});

	test("a default makes selection OPTIONAL again", () => {
		const claw = createClaw({
			models: {
				fast: textModel("fast"),
				smart: { model: textModel("smart"), default: true },
			},
		});
		claw.api.generate({ prompt: "hi" }); // ok — falls to default
		claw.api.sendMessage({ clawId: "c", threadId: "t", message: "hi" }); // ok
	});

	test("a single `model` offers no run-level model option", () => {
		const claw = createClaw({ model: textModel("solo") });
		const run = claw.$context.runtime.generate;
		type Opts = NonNullable<Parameters<typeof run>[2]>;
		// model?: never → the only inhabitant is `undefined`
		expectTypeOf<Opts["model"]>().toEqualTypeOf<undefined>();
		// @ts-expect-error — no pool, so a model name can't be passed
		run("hi", undefined, { model: "solo" });
	});

	test("createClaw requires a model source", () => {
		// @ts-expect-error — neither `model` nor `models`
		createClaw({ plugins: [] });
	});

	test("createClaw rejects an empty models pool", () => {
		// @ts-expect-error — empty pool
		createClaw({ models: {} });
	});

	test("createClaw rejects `model` and `models` together", () => {
		// @ts-expect-error — mutually exclusive
		createClaw({ model: textModel("x"), models: { a: textModel("a") } });
	});
});
