// Behavior: the public `api.run` selects the pooled model by name (a model whose output text IS
// its id makes `result.text` name the model that ran). Type-safety is proven in
// model-routing.test-d.ts; this proves the option actually reaches the runtime's selector.
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { owned, textModel } from "./fixtures";

describe("createClaw model routing (api.run)", () => {
	const claw = owned({
		models: {
			fast: textModel("fast"),
			smart: { model: textModel("smart"), default: true, tags: ["reasoning"] },
		},
	});

	it("runs the named model; unpinned falls to the default", async () => {
		expect(
			await claw.api.generate({ prompt: "hi", options: { model: "fast" } }),
		).toMatchObject({ text: "fast" });
		expect(
			await claw.api.generate({ prompt: "hi", options: { model: "smart" } }),
		).toMatchObject({ text: "smart" });
		expect(await claw.api.generate({ prompt: "hi" })).toMatchObject({
			text: "smart",
		});
	});

	it("fails closed on an unknown model name over the wire (past the types)", async () => {
		await expect(
			claw.api.generate({
				prompt: "hi",
				options: { model: "nope" } as never,
			}),
		).rejects.toThrow(/unknown model/);
	});
});

// The empty-pool refusal, which used to be a compile error and is now a construction-time one.
//
// `ClawModelSource` expresses "exactly one of `model`/`models`" as a structural union so the gate is
// off the inference path — a conditional there misfired on any config carrying an unannotated
// callback. "Has at least one key" cannot be said structurally, so this half of the check lives where
// it always also lived: `createModelSelector`, loudly, at boot.
describe("createClaw — an empty models pool", () => {
	it("refuses at construction, naming the fix", () => {
		expect(() => createClaw({ models: {} })).toThrow(/`models` pool is empty/);
	});

	it("still refuses `model` and `models` together", () => {
		// This half IS structural (the `?: never` arms), so it is ALSO a compile error — see
		// model-routing.test-d.ts. Asserted here too because the runtime is what a JS caller meets.
		expect(() =>
			createClaw({
				model: textModel("x"),
				models: { a: textModel("a") },
			} as never),
		).toThrow(/mutually exclusive/);
	});
});
