import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { textModel, withPrincipal } from "./fixtures";

describe("createClaw direct run", () => {
	it("runs a direct model scenario", async () => {
		const claw = createClaw({ model: textModel("done") });
		const api = withPrincipal(claw, "user:actor-1").api;

		await expect(api.run({ prompt: "hello" })).resolves.toEqual({
			status: "completed",
			steps: 1,
			text: "done",
		});
	});
});
