// H-02's acceptance criterion: an unrelated human cannot list, read, grant, deny or resume someone
// else's approval, and an assigned reviewer can.
//
// The whole check used to be "is the caller a human". That answers nothing about whether this human
// may decide THIS approval — and in a multi-tenant deployment it means every other tenant's people
// qualify. Every case below hands the stranger a real approval id, because an id is not a boundary:
// it leaks through a URL, a log, a screenshot, a support ticket.

import { describe, expect, it } from "vitest";
import { approvalToolModel, durableRedactor, emailTool, owned } from "./fixtures";

const OWNER = { principal: "user:actor-1" } as const;
const STRANGER = { principal: "user:stranger" } as const;
const REVIEWER = { principal: "user:reviewer" } as const;

const DENIED = /EUROCLAW_AUTHORIZATION_DENIED/;

/** An owner's claw that has parked one approval, and the id of it. */
async function parked() {
	const { db, redactor } = durableRedactor();
	const claw = owned({
		database: db,
		model: approvalToolModel(),
		redaction: { redactor },
		tools: {
			send_email: emailTool({ onExecute: (to) => ({ sent: true, to }) }),
		},
	});
	const agent = await claw.api.createClaw({ name: "owner's claw" });
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
		throw new Error("expected the write to park for approval");
	}
	return { claw, approvalId: sent.result.approvalIds[0] };
}

describe("approval isolation", () => {
	it("a stranger holding the id cannot read, grant, deny or resume it", async () => {
		const { claw, approvalId } = await parked();

		await expect(
			claw.api.getApproval({ id: approvalId }, STRANGER),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.grantApproval({ approvalId }, STRANGER),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.denyApproval({ approvalId, reason: "no" }, STRANGER),
		).rejects.toThrow(DENIED);
		await expect(
			claw.api.continueRun({ approvalId }, STRANGER),
		).rejects.toThrow(DENIED);

		// The owner still can — a gate that refuses everyone is an outage, not isolation.
		expect((await claw.api.getApproval({ id: approvalId }, OWNER))?.id).toBe(
			approvalId,
		);
	});

	it("a listing hides what the caller may not read, rather than refusing the call", async () => {
		const { claw, approvalId } = await parked();

		// Not an error — an empty list. Refusing would leak the row's existence by the shape of the
		// failure, and would deny a reviewer who can legitimately see some approvals but not others.
		await expect(claw.api.listApprovals({}, STRANGER)).resolves.toEqual([]);
		expect(
			(await claw.api.listApprovals({}, OWNER)).map((row) => row.id),
		).toContain(approvalId);
	});

	it("an ASSIGNED reviewer can decide it, and assignment is the owner's to make", async () => {
		const { claw, approvalId } = await parked();

		// Before assignment the reviewer is just another stranger.
		await expect(
			claw.api.grantApproval({ approvalId }, REVIEWER),
		).rejects.toThrow(DENIED);

		await claw.api.shareResource(
			{
				resourceKind: "approval",
				resourceId: approvalId,
				principalRef: REVIEWER.principal,
				permission: "use",
			},
			OWNER,
		);

		await expect(
			claw.api.listApprovals({}, REVIEWER),
		).resolves.toHaveLength(1);
		await expect(
			claw.api.grantApproval({ approvalId }, REVIEWER),
		).resolves.not.toBeNull();
	});

	it("deciding is not resuming — `use` grants the decision, not the execution", async () => {
		const { claw, approvalId } = await parked();

		await claw.api.shareResource(
			{
				resourceKind: "approval",
				resourceId: approvalId,
				principalRef: REVIEWER.principal,
				permission: "use",
			},
			OWNER,
		);
		await claw.api.grantApproval({ approvalId }, REVIEWER);

		// The reviewer said yes. Performing the parked call is a further step, and `use` does not
		// reach it — the replay bypasses the demanding gate, so resuming IS the execution.
		await expect(
			claw.api.continueRun({ approvalId }, REVIEWER),
		).rejects.toThrow(DENIED);
		await expect(claw.api.continueRun({ approvalId }, OWNER)).resolves.toBeTruthy();
	});
});
