import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import { approvalToolModel, durableRedactor, emailTool } from "./fixtures";

describe("createClaw approvals", () => {
	it("runs approval resume with durable redaction and effect tracking", async () => {
		let toolSaw = "";
		let toolRuns = 0;
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(
					emailTool({
						onExecute: (to) => {
							toolRuns++;
							toolSaw = to;
							return { sent: true, to };
						},
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});

		const waiting = await claw.api.run({ prompt: "email alice@personal.com" });
		expect(waiting.status).toBe("waiting_approval");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId, by: "user:alice" });
		await expect(claw.api.continueRun({ approvalId })).resolves.toMatchObject({
			status: "completed",
			text: "done",
		});

		expect(toolSaw).toBe("alice@personal.com");
		expect(toolRuns).toBe(1);
		expect(
			(await claw.api.getEffect({ id: `approval:${approvalId}:tool:c1` }))
				?.status,
		).toBe("completed");
	});
});
