// Behavior: the public `api.run` selects the pooled model by name (a model whose output text IS
// its id makes `result.text` name the model that ran). Type-safety is proven in
// model-routing.test-d.ts; this proves the option actually reaches the runtime's selector.
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { textModel } from "./fixtures";

describe("createClaw model routing (api.run)", () => {
	const claw = createClaw({
		models: {
			fast: textModel("fast"),
			smart: { model: textModel("smart"), default: true, tags: ["reasoning"] },
		},
	});

	it("runs the named model; unpinned falls to the default", async () => {
		expect(
			await claw.api.run({ prompt: "hi", options: { model: "fast" } }),
		).toMatchObject({ text: "fast" });
		expect(
			await claw.api.run({ prompt: "hi", options: { model: "smart" } }),
		).toMatchObject({ text: "smart" });
		expect(await claw.api.run({ prompt: "hi" })).toMatchObject({
			text: "smart",
		});
	});

	it("fails closed on an unknown model name over the wire (past the types)", async () => {
		await expect(
			claw.api.run({
				prompt: "hi",
				options: { model: "nope" } as never,
			}),
		).rejects.toThrow(/unknown model/);
	});
});
