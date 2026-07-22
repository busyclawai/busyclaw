import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { textModel } from "./fixtures";

describe("createClaw direct run", () => {
	it("runs a direct model scenario", async () => {
		const claw = createClaw({ model: textModel("done") });

		await expect(claw.api.generate({ prompt: "hello" })).resolves.toEqual({
			status: "completed",
			steps: 1,
			text: "done",
		});
	});
});
