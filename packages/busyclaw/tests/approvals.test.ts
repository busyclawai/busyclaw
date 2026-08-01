import {
	APPROVED_BY_CONTEXT_KEY,
	auditActorKind,
	auditSupervision,
	type BusyclawPlugin,
	PRINCIPAL_CONTEXT_KEY,
	SYSTEM_ANONYMOUS,
} from "@busyclaw/contracts";
import { createMemoryAudit } from "@busyclaw/core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
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
				send_email: emailTool({
					onExecute: (to) => {
						toolRuns++;
						toolSaw = to;
						return { sent: true, to };
					},
				}),
			},
		});

		const waiting = await claw.api.generate({
			prompt: "email alice@personal.com",
		});
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

	// A send_email tool that parks for approval — the shared shape for the authz + audit proofs. The
	// parking is the FLOOR's now, not a gate stacked on top: send_email is a write, and a write needs
	// confirmation under the seeded posture. Two gates would each want their own approval and a resume
	// clears exactly one, which is how the stacked version failed once the floor stopped skipping.
	const emailNeedsApproval = () => ({
		send_email: emailTool({ onExecute: (to: string) => ({ sent: true, to }) }),
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
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: emailNeedsApproval(),
		});
		// An unattended run parks for approval — the case approvals EXIST for, no human present at the
		// moment of the call. It still belongs to a CLAW: unattended work in busyclaw is a claw's work
		// (a cron tick processes due claws), so the claw is the human-owned thing behind it and its
		// access rules are what say who may decide. `owned()` binds user:actor-1 as that human.
		const agent = await claw.api.createClaw({ name: "nightly" });
		const thread = await claw.api.createThread({ clawId: agent.id });
		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "email alice@personal.com",
		});
		if (
			sent.result.status !== "waiting_approval" ||
			!sent.result.approvalIds?.[0]
		) {
			throw new Error("expected approval wait");
		}
		const approvalId = sent.result.approvalIds[0];

		// A machine may not decide — approval exists to put a HUMAN in front of an unattended action.
		// This floor is an ACTOR check and runs on top of the ownership one, never instead of it.
		// `system:anonymous` is the real machine identity here: busyclaw has no scheduler principal,
		// because a scheduled run belongs to a claw and carries whoever delegated it.
		// Refused. WHICH layer refuses it changed: the ownership gate now runs before the handler, so a
		// machine that owns nothing is stopped there rather than by the principal floor. Both are correct
		// and the floor still backs it up for a machine that somehow does own the claw — so this
		// asserts the outcome, and the floor's own message is asserted where it can still be reached.
		await expect(
			claw.api.grantApproval({ approvalId }, { principal: SYSTEM_ANONYMOUS }),
		).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED|only a user principal/);
		// An unrelated human may NOT. This is H-02: being logged in used to be the whole check, which in
		// a multi-tenant deployment means every other tenant's people could decide your approvals.
		await expect(
			claw.api.grantApproval({ approvalId }, { principal: "user:unrelated" }),
		).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED/);
		// The claw's owner may — the approval resolves through the claw that parked it.
		await expect(
			claw.api.grantApproval({ approvalId }),
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

		// ASSIGN the reviewers. An approval is anchored now, so deciding and resuming it are permissions
		// somebody holds — the owner grants them, exactly as they would share any other resource. This
		// is the "assigned approvers" half of the design: an unrelated human is refused, an assigned one
		// is not, and which is which is data the owner wrote rather than a property of being logged in.
		for (const [principalRef, permission] of [
			["user:approver-9", "use"],
			["user:random-8", "manage"],
		] as const) {
			await claw.api.shareResource({
				resourceKind: "approval",
				resourceId: approvalId,
				principalRef,
				permission,
			});
		}

		await claw.api.grantApproval(
			{ approvalId },
			{ principal: "user:approver-9" },
		);
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
		const sendEntitledTo = (allowed: string): BusyclawPlugin => ({
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
			// Bob is an ASSIGNED approver: manage, because he both decides and resumes. Note what this
			// does NOT give him — the entitlement gate below still asks whether the executing identity
			// may send, and being allowed to approve says nothing about that.
			// Assigned by ALICE — the requester, who owns the approval her run parked.
			await claw.api.shareResource(
				{
					resourceKind: "approval",
					resourceId: approvalId,
					principalRef: BOB,
					permission: "manage",
				},
				{ principal: ALICE },
			);
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
