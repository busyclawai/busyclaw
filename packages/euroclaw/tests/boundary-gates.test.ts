import { createMemoryAudit } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { approvalToolModel, emailTool, owned, textModel } from "./fixtures";

describe("createClaw boundary gates", () => {
	it("denies a model before provider execution", async () => {
		let providerRan = false;
		const claw = owned({
			model: {
				...textModel("done", { modelId: "blocked-model" }),
				doGenerate: async () => {
					providerRan = true;
					return textModel("done").doGenerate({ prompt: [] } as never);
				},
			},
			plugins: [
				{
					id: "model-policy",
					boundaryGates: [
						{
							id: "block-model",
							matcher: (call) =>
								call.boundary === "model" &&
								call.modelCall.model === "blocked-model",
							handler: () => ({ decision: "deny", reason: "model denied" }),
						},
					],
				},
			],
		});

		await expect(claw.api.generate({ prompt: "hello" })).rejects.toThrow(
			/model boundary gate denied model call/,
		);
		expect(providerRan).toBe(false);
	});

	it("denies a tool before tool execution", async () => {
		let toolRuns = 0;
		const audit = createMemoryAudit();
		const claw = owned({
			audit,
			model: approvalToolModel(),
			plugins: [
				{
					id: "tool-boundary-policy",
					boundaryGates: [
						{
							id: "block-tool-boundary",
							matcher: (call) => call.boundary === "tool",
							handler: () => ({ decision: "deny", reason: "tool denied" }),
						},
					],
				},
			],
			tools: {
				send_email: emailTool({
					onExecute: () => {
						toolRuns++;
						return { sent: true };
					},
				}),
			},
		});

		await expect(
			claw.api.generate({ prompt: "email alice@personal.com" }),
		).resolves.toMatchObject({
			status: "completed",
			text: "done",
		});

		expect(toolRuns).toBe(0);
		expect(audit.entries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					boundary: "tool",
					gateId: "block-tool-boundary",
					status: "denied",
				}),
			]),
		);
	});

	it("rejects duplicate plugin routes during composition", () => {
		const plugin = (id: string) => ({
			id,
			routes: [
				{
					method: "POST" as const,
					path: "/webhooks/1",
					handler: () => ({ body: { ok: true } }),
				},
			],
		});

		expect(() =>
			createClaw({
				model: textModel("done"),
				plugins: [plugin("telegram"), plugin("slack")],
			}),
		).toThrow(/duplicate euroclaw plugin route/);
	});
});
