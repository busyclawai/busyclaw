import type { EffectStore } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	owned,
} from "./fixtures";

describe("createClaw effects", () => {
	it("applies default redacted effect output policy", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(
					emailTool({ onExecute: (to) => ({ sent: true, recipient: to }) }),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});

		const waiting = await claw.api.run({ prompt: "email alice@personal.com" });
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId, by: "user:alice" });
		await claw.api.continueRun({ approvalId });

		const effect = await claw.api.getEffect({
			id: `approval:${approvalId}:tool:c1`,
		});
		expect(JSON.stringify(effect?.output)).toMatch(
			/\{\{pii:[a-z]+:[a-z0-9]+\}\}/,
		);
		expect(JSON.stringify(effect?.output)).not.toContain("alice@personal.com");
	});

	it("supports explicit full effect output policy", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(
					emailTool({ onExecute: (to) => ({ sent: true, recipient: to }) }),
					{
						gate: () => ({ decision: "needs-approval" }),
						effect: { output: "full" },
					},
				),
			},
		});

		const waiting = await claw.api.run({ prompt: "email alice@personal.com" });
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId, by: "user:alice" });
		await claw.api.continueRun({ approvalId });

		await expect(
			claw.api.getEffect({ id: `approval:${approvalId}:tool:c1` }),
		).resolves.toMatchObject({
			output: { recipient: "alice@personal.com", sent: true },
		});
	});

	it("does not persist effect output by default for non-idempotent tools", async () => {
		let toolRuns = 0;
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(
					emailTool({
						onExecute: (to) => {
							toolRuns++;
							return { sent: true, recipient: to };
						},
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
						effect: { idempotency: "none" },
					},
				),
			},
		});

		const waiting = await claw.api.run({ prompt: "email alice@personal.com" });
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId, by: "user:alice" });
		expect((await claw.api.continueRun({ approvalId }))?.status).toBe(
			"completed",
		);
		expect(toolRuns).toBe(1);

		const completedEffect = await claw.api.getEffect({
			id: `approval:${approvalId}:tool:c1`,
		});
		expect(completedEffect).toMatchObject({ status: "completed" });
		expect(completedEffect?.output).toBeUndefined();
		await expect(claw.api.continueRun({ approvalId })).rejects.toThrow(
			/completed effect output is unavailable/,
		);
		expect(toolRuns).toBe(1);
	});

	it("does not retry uncertain non-idempotent effects", async () => {
		let toolRuns = 0;
		let reclaimExpired: boolean | undefined;
		const effectStore: EffectStore = {
			get: async () => null,
			claim: async (input) => {
				reclaimExpired = input.reclaimExpired;
				return {
					status: "uncertain",
					leaseExpiresAt: "2026-01-01T00:00:01.000Z",
					record: {
						createdAt: input.now,
						id: input.id,
						inputHash: input.inputHash,
						leaseExpiresAt: "2026-01-01T00:00:01.000Z",
						status: "started",
						toolName: input.toolName,
						updatedAt: input.now,
					},
				};
			},
			heartbeat: async () => null,
			complete: async () => {
				throw new Error("should not complete");
			},
			fail: async () => {
				throw new Error("should not fail");
			},
		};
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			effectStore,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(
					emailTool({
						onExecute: () => {
							toolRuns++;
							return { sent: true };
						},
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
						effect: { idempotency: "none" },
					},
				),
			},
		});

		const waiting = await claw.api.run({ prompt: "email alice@personal.com" });
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		await claw.api.grantApproval({
			approvalId: waiting.approvalIds[0],
			by: "user:alice",
		});

		await expect(
			claw.api.continueRun({ approvalId: waiting.approvalIds[0] }),
		).rejects.toThrow(/unknown and cannot be retried without idempotency/);
		expect(reclaimExpired).toBe(false);
		expect(toolRuns).toBe(0);
	});
});
