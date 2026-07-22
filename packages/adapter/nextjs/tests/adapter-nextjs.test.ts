import type { Claw } from "euroclaw";
import { describe, expect, it } from "vitest";
import { toNextJsHandler } from "../src/index";

describe("@euroclaw/adapter-nextjs", () => {
	it("returns Next.js route handlers around the core request handler", async () => {
		const claw = {
			api: {
				generate: async ({ prompt }: { prompt: string }) => ({
					status: "completed",
					steps: 1,
					text: prompt,
				}),
			},
		} as unknown as Claw;

		const handlers = toNextJsHandler(claw);
		const response = await handlers.POST(
			new Request("https://app.test/api/euroclaw/generate", {
				body: JSON.stringify({ prompt: "hello" }),
				method: "POST",
			}),
		);

		expect(Object.keys(handlers).sort()).toEqual([
			"DELETE",
			"GET",
			"PATCH",
			"POST",
			"PUT",
		]);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			data: { status: "completed", text: "hello" },
			ok: true,
		});
	});
});
