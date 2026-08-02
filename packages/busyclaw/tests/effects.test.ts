import type { EffectStore } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	owned,
	withPrincipal,
} from "./fixtures";

describe("createClaw effects", () => {
	it("applies default redacted effect output policy", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: emailTool({
					onExecute: (to) => ({ sent: true, recipient: to }),
				}),
			},
		});

		const waiting = await claw.api.generate({
			prompt: "email alice@personal.com",
		});
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId });
		await claw.api.continueRun({ approvalId });

		const effect = await claw.api.getEffect({
			id: `approval:${approvalId}:tool:c1`,
		});
		expect(JSON.stringify(effect?.output)).toMatch(
			/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/,
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
				send_email: emailTool(
					{ onExecute: (to) => ({ sent: true, recipient: to }) },
					{
						effect: { output: "full" },
					},
				),
			},
		});

		const waiting = await claw.api.generate({
			prompt: "email alice@personal.com",
		});
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId });
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
				send_email: emailTool(
					{
						onExecute: (to) => {
							toolRuns++;
							return { sent: true, recipient: to };
						},
					},
					{
						effect: { idempotency: "none" },
					},
				),
			},
		});

		const waiting = await claw.api.generate({
			prompt: "email alice@personal.com",
		});
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId });
		expect((await claw.api.continueRun({ approvalId }))?.status).toBe(
			"completed",
		);
		expect(toolRuns).toBe(1);

		const completedEffect = await claw.api.getEffect({
			id: `approval:${approvalId}:tool:c1`,
		});
		expect(completedEffect).toMatchObject({ status: "completed" });
		expect(completedEffect?.output).toBeUndefined();
		// A finished approval is answered from the result it stored, so the second resume never asks the
		// effect ledger for output it deliberately did not keep. That throw was the replay tripping over
		// a consequence of its own re-execution.
		expect((await claw.api.continueRun({ approvalId }))?.status).toBe(
			"completed",
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
						// Echoed back from what the runtime stamped — a stub inventing its own anchors
						// would assert its values, not the ones under test.
						...input.anchors,
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
				send_email: emailTool(
					{
						onExecute: () => {
							toolRuns++;
							return { sent: true };
						},
					},
					{
						effect: { idempotency: "none" },
					},
				),
			},
		});

		const waiting = await claw.api.generate({
			prompt: "email alice@personal.com",
		});
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		await claw.api.grantApproval({
			approvalId: waiting.approvalIds[0],
		});

		await expect(
			claw.api.continueRun({ approvalId: waiting.approvalIds[0] }),
		).rejects.toThrow(/unknown and cannot be retried without idempotency/);
		expect(reclaimExpired).toBe(false);
		expect(toolRuns).toBe(0);
	});
	// R-H01 — an effect row carries the anchors that say whose work it was.
	//
	// `getEffect` was `callerOnly` with a stated reason: "an effect row carries no claw or run
	// reference, so there is nothing to resolve it against". An effect records what a tool DID —
	// its input hash, its output, its compensation — so an unanchored read is one authenticated
	// stranger away from another tenant's side effects, and the id is guessable by construction
	// (`run:<runId>:tool:<toolCallId>`).
	//
	// It carries the same anchors an approval does, decided by the same ladder: the claw whose run
	// produced it, else the tenant it ran in, else the principal it ran as. Nothing new was invented
	// for effects — an approval and an effect are both "something a run left behind".
	it("a stranger cannot read another claw's effect", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: emailTool({
					onExecute: (to) => ({ sent: true, recipient: to }),
				}),
			},
		});
		const waiting = await claw.api.generate({ prompt: "email alice@x.com" });
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await claw.api.grantApproval({ approvalId });
		await claw.api.continueRun({ approvalId });
		const id = `approval:${approvalId}:tool:c1`;

		// The owner reads it — the effect is anchored to work they own.
		expect(await claw.api.getEffect({ id })).toMatchObject({
			status: "completed",
		});

		// A stranger with the exact id does not. The id was never the secret.
		await expect(
			withPrincipal(claw, userPrincipal("stranger")).api.getEffect({ id }),
		).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED/);
	});

	it("whoever may manage the CLAW may read what it did", async () => {
		// The claw anchor specifically, which the test above cannot reach: `api.generate` is ad-hoc, so
		// it mints no claw and its effects fall through to the principal. A RECORDED run has one. Bob
		// is not the owner and shares no tenant — a grant on the CLAW is the only thing that can reach
		// the row, so this fails the moment an effect stops carrying `clawId`.
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: emailTool({
					onExecute: (to) => ({ sent: true, recipient: to }),
				}),
			},
		});
		const agent = await claw.api.createClaw({
			id: "claw-1",
			name: "assistant",
		});
		const thread = await claw.api.createThread({
			id: "thread-1",
			clawId: agent.id,
			title: "t",
		});
		const waiting = await claw.api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "email alice@x.com",
		});
		const result = waiting.result;
		if (result.status !== "waiting_approval" || !result.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		const approvalId = result.approvalIds[0];
		await claw.api.grantApproval({ approvalId });
		await claw.api.continueRun({ approvalId });
		const id = `approval:${approvalId}:tool:c1`;

		const bob = userPrincipal("bob");
		await expect(
			withPrincipal(claw, bob).api.getEffect({ id }),
		).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED/);

		await claw.api.shareResource({
			resourceKind: "claw",
			resourceId: agent.id,
			principalRef: bob,
			permission: "read",
		});
		expect(await withPrincipal(claw, bob).api.getEffect({ id })).toMatchObject({
			status: "completed",
		});
	});
});

// What `approvalAuthority: "approver"` means for the artifacts a resumed run leaves behind.
//
// The question this pins: Bob approves an escalation Alice could not perform, the tool then executes
// under BOB's principal — so does the row land as "Bob acting in Alice's thread", and does the
// containment check (R-H02) refuse it?
//
// It does not refuse it, and the reason is worth stating rather than discovering: the claw and thread
// on those rows come from the RECORDING, which is Alice's run, not from anything Bob supplied. The
// pair is coherent — Alice's thread in Alice's claw — so the check has nothing to object to. What
// changes is the PRINCIPAL, which is the whole point of lending authority.
describe("an approver's borrowed authority does not move the conversation", () => {
	it("the effect records BOB as principal and ALICE's claw as the anchor", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			// The escalation posture: the approved action runs as the APPROVER, which is what lets it
			// do something the requester could not.
			approvalAuthority: "approver",
			tools: {
				send_email: emailTool({
					onExecute: (to) => ({ sent: true, recipient: to }),
				}),
			},
		});
		const alice = { principal: userPrincipal("alice") };
		const bob = { principal: userPrincipal("bob") };

		const agent = await claw.api.createClaw(
			{ id: "c1", name: "alice's" },
			alice,
		);
		const thread = await claw.api.createThread(
			{ id: "t1", clawId: agent.id },
			alice,
		);
		const sent = await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "email x@y.com" },
			alice,
		);
		if (
			sent.result.status !== "waiting_approval" ||
			!sent.result.approvalIds?.[0]
		) {
			throw new Error("expected approval wait");
		}
		const approvalId = sent.result.approvalIds[0];

		// Alice shares the claw so Bob can reach the approval to decide it at all.
		await claw.api.shareResource(
			{
				resourceKind: "claw",
				resourceId: agent.id,
				principalRef: bob.principal,
				permission: "manage",
			},
			alice,
		);
		await claw.api.grantApproval({ approvalId }, bob);
		await claw.api.continueRun({ approvalId }, bob);

		const row = await db.findOne({
			model: "effect",
			where: [{ field: "id", value: `approval:${approvalId}:tool:c1` }],
		});
		// Bob DID it — borrowed authority is recorded as Bob's, not laundered into Alice's name.
		expect(row).toMatchObject({ principal: bob.principal, clawId: agent.id });
	});
});
