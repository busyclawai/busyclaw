import {
	APPROVED_BY_CONTEXT_KEY,
	auditActorKind,
	auditSupervision,
	type EuroclawPlugin,
	PRINCIPAL_CONTEXT_KEY,
} from "@euroclaw/contracts";
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

	it("the resume caller cannot choose the executing identity — the record fixes it (attest)", async () => {
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

		await claw.api.grantApproval({ approvalId }, { principal: "user:approver-9" });
		// A THIRD party resumes. Under the old convention the replay executed as WHOEVER called
		// continueRun — so this call could have silently chosen the acting identity.
		await claw.api.continueRun({ approvalId }, { principal: "user:random-8" });

		const executed = audit
			.entries()
			.find((e) => e.name === "send_email" && e.status === "ok");
		// It ran as the REQUESTER (default `attest`) — not the resumer, not the approver.
		expect(executed?.principal).toBe("user:actor-1");
		expect(executed?.decidedBy).toBe("user:approver-9");
	});

	it("approvalAuthority 'approver' LENDS authority — escalation past the requester's limits (assume)", async () => {
		const ALICE = "user:alice-requester";
		const BOB = "user:bob-entitled";
		// A SECOND gate, distinct from the one that demands approval — the replay bypasses only the
		// demanding gate (by id), so this one re-evaluates against whoever the action executes AS. It
		// matches only on an approved replay, leaving the drafting step to the approval gate.
		const sendEntitledTo = (allowed: string): EuroclawPlugin => ({
			id: "send-entitlement",
			gates: [
				{
					id: "send-entitlement",
					matcher: (call, ctx) =>
						call.name === "send_email" &&
						ctx[APPROVED_BY_CONTEXT_KEY] !== undefined,
					handler: (_call, ctx) =>
						ctx[PRINCIPAL_CONTEXT_KEY] === allowed
							? { decision: "permit" }
							: { decision: "deny", reason: "not entitled to send" },
				},
			],
		});
		const run = async (approvalAuthority?: "approver") => {
			const { db, redactor } = durableRedactor();
			const audit = createMemoryAudit();
			const claw = createClaw({
				database: db,
				model: approvalToolModel(),
				redaction: { redactor },
				audit,
				plugins: [sendEntitledTo(BOB)],
				tools: emailNeedsApproval(),
				...(approvalAuthority ? { approvalAuthority } : {}),
			});
			const waiting = await claw.api.generate(
				{ prompt: "email alice@personal.com" },
				{ principal: ALICE },
			);
			if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
				throw new Error("expected approval wait");
			}
			const approvalId = waiting.approvalIds[0];
			await claw.api.grantApproval({ approvalId }, { principal: BOB });
			await claw.api.continueRun({ approvalId }, { principal: BOB });
			return audit
				.entries()
				.find((e) => e.name === "send_email" && e.status !== "needs-approval");
		};

		// Default (attest): the action stays ALICE's — she is not entitled, so approving does NOT
		// launder the authority. The entitlement gate denies on replay.
		const attested = await run();
		expect(attested?.principal).toBe(ALICE);
		expect(attested?.status).toBe("denied");

		// assume: BOB lends his authority, so the action ALICE may not perform executes because BOB may.
		const assumed = await run("approver");
		expect(assumed?.principal).toBe(BOB);
		expect(assumed?.status).toBe("ok");
		expect(assumed?.decidedBy).toBe(BOB);
	});
});
