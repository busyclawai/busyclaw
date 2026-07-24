import { auditActorKind, auditSupervision } from "@euroclaw/contracts";
import { createMemoryAudit } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	owned,
} from "./fixtures";

describe("createClaw approvals", () => {
	it("runs approval resume with durable redaction and effect tracking", async () => {
		let toolSaw = "";
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
							toolSaw = to;
							return { sent: true, to };
						},
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});

		const waiting = await claw.api.generate({ prompt: "email alice@personal.com" });
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

	// A send_email tool that always parks for approval — the shared shape for the authz + audit proofs.
	const emailNeedsApproval = () => ({
		send_email: govern(
			emailTool({ onExecute: (to: string) => ({ sent: true, to }) }),
			{ gate: () => ({ decision: "needs-approval" as const }) },
		),
	});

	it("records actor-kind + approver in the audit across the approval flow (seams 1+2)", async () => {
		const { db, redactor } = durableRedactor();
		const audit = createMemoryAudit();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			audit,
			tools: emailNeedsApproval(),
		});

		const waiting = await claw.api.generate({
			prompt: "email alice@personal.com",
		});
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];

		// The DRAFT (needs-approval) entry carries the run's actor-kind facts — an agent produced it (a run
		// stamps runMode; this ad-hoc generate is autonomous), no approver yet.
		const draft = audit
			.entries()
			.find((e) => e.name === "send_email" && e.status === "needs-approval");
		if (!draft) throw new Error("expected a needs-approval audit entry");
		expect(draft.runMode).toBe("autonomous");
		expect(draft.decidedBy).toBeUndefined();
		expect(auditActorKind(draft)).toBe("agent");
		expect(auditSupervision(draft)).toBe("autonomous");

		await claw.api.grantApproval({ approvalId });
		await claw.api.continueRun({ approvalId });

		// The EXECUTED-after-approval entry carries the approver (the owned caller) — supervision flips to
		// `approved` (a human granted it), still an agent action.
		const approved = audit
			.entries()
			.find((e) => e.name === "send_email" && e.status === "ok");
		if (!approved) throw new Error("expected an executed (ok) audit entry");
		expect(approved.decidedBy).toBe("user:actor-1");
		expect(auditActorKind(approved)).toBe("agent");
		expect(auditSupervision(approved)).toBe("approved");
	});

	it("only a human may decide an approval — the user-principal floor (seam 3)", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: emailNeedsApproval(),
		});
		// An autonomous, system-initiated run parks for approval — the case approvals EXIST for (no human
		// present). There is no user-owner to anchor on, so anchoring would make it unapprovable.
		const waiting = await claw.api.generate(
			{ prompt: "email alice@personal.com" },
			{ principal: "system:cron" },
		);
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];

		// A machine may not decide — approval exists to put a HUMAN in front of an autonomous action.
		await expect(
			claw.api.grantApproval({ approvalId }, { principal: "system:cron" }),
		).rejects.toThrow(/only a user principal may decide/);
		// Any authenticated human may — WHICH human (owner-only / manager / SoD) is opt-in policy, deferred.
		await expect(
			claw.api.grantApproval({ approvalId }, { principal: "user:reviewer" }),
		).resolves.not.toBeNull();
	});
});
