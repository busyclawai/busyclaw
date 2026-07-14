import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	textModel,
} from "./fixtures";

async function createAgentThread(claw: ReturnType<typeof createClaw>) {
	const agent = await claw.api.createClaw({
		id: "claw-1",
		createdBy: "user:actor-1",
		name: "Recruiting assistant",
	});
	const thread = await claw.api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Candidate Alice",
	});
	return { agent, thread };
}

describe("createClaw send", () => {
	it("persists user and assistant transcript messages", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			runId: "run-1",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		expect(sent.userMessage).toMatchObject({ role: "user", sequence: 1 });
		const messages = await claw.api.listMessages({
			threadId: thread.id,
		});
		expect(messages).toMatchObject([
			{ content: { text: "hello" }, role: "user", sequence: 1 },
			{
				content: { text: "done" },
				role: "assistant",
				runId: "run-1",
				sequence: 2,
			},
		]);
		expect(await claw.api.getThread({ id: thread.id })).toMatchObject({
			currentMessageId: messages[1]?.id,
			currentSequence: 2,
		});
	});

	it("persists approval waits as checkpoints without assistant messages", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(emailTool({ onExecute: () => ({ sent: true }) }), {
					gate: () => ({ decision: "needs-approval" }),
				}),
			},
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-approval",
			threadId: thread.id,
		});

		expect(sent.result.status).toBe("waiting_approval");
		const messages = await claw.api.listMessages({
			threadId: thread.id,
		});
		expect(messages).toMatchObject([
			{
				// The product transcript is tokenized at rest too — same rule as the tool args below.
				content: {
					text: expect.stringMatching(/^email \{\{pii:email:[a-z0-9]+\}\}$/),
				},
				role: "user",
				sequence: 1,
			},
		]);
		const checkpoint = await claw.api.getLatestCheckpoint({
			runId: "run-approval",
		});
		expect(checkpoint).toMatchObject({
			clawId: agent.id,
			kind: "approval_wait",
			state: { approvalIds: expect.any(Array) },
			threadId: thread.id,
		});
		const toolCall = await claw.api.getToolCallByProviderId({
			runId: "run-approval",
			toolCallId: "c1",
		});
		expect(toolCall).toMatchObject({
			args: { to: expect.stringMatching(/^\{\{pii:/) },
			status: "waiting_approval",
			toolName: "send_email",
		});
		expect(JSON.stringify(toolCall)).not.toContain("alice@personal.com");
		const approvals = await claw.api.listApprovals({ status: "pending" });
		expect(JSON.stringify(approvals)).not.toContain("alice@personal.com");
		expect(
			JSON.stringify(
				await claw.api.getLatestCheckpoint({ runId: "run-approval" }),
			),
		).not.toContain("alice@personal.com");
	});

	it("records approved resume into the original thread and run", async () => {
		let toolSaw = "";
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(
					emailTool({
						onExecute: (to) => {
							toolSaw = to;
							return { sent: true, to };
						},
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-resume",
			threadId: thread.id,
		});
		if (sent.result.status !== "waiting_approval") {
			throw new Error("expected approval wait");
		}
		const approvalId = sent.result.approvalIds?.[0];
		if (!approvalId) throw new Error("missing approval id");

		await claw.api.grantApproval({ approvalId, by: "user:alice" });
		const resumed = await claw.api.continueRun({ approvalId });

		expect(resumed).toMatchObject({ status: "completed", text: "done" });
		expect(toolSaw).toBe("alice@personal.com");
		const messages = await claw.api.listMessages({
			threadId: thread.id,
		});
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(messages[1]).toMatchObject({
			content: { text: "done" },
			runId: "run-resume",
			sequence: 2,
		});
		expect(
			await claw.api.getToolCallByProviderId({
				runId: "run-resume",
				toolCallId: "c1",
			}),
		).toMatchObject({ status: "completed" });
		expect(
			await claw.api.listToolResults({
				runId: "run-resume",
				toolCallId: "c1",
			}),
		).toMatchObject([
			{
				output: { sent: true, to: expect.stringMatching(/^\{\{pii:/) },
				status: "completed",
			},
		]);
	});

	it("records denied approvals as failed tool results", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(emailTool({ onExecute: () => ({ sent: true }) }), {
					gate: () => ({ decision: "needs-approval" }),
				}),
			},
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-denied",
			threadId: thread.id,
		});
		if (sent.result.status !== "waiting_approval") {
			throw new Error("expected approval wait");
		}
		const approvalId = sent.result.approvalIds?.[0];
		if (!approvalId) throw new Error("missing approval id");

		await claw.api.denyApproval({
			approvalId,
			by: "user:alice",
			reason: "Not allowed",
		});
		await expect(claw.api.continueRun({ approvalId })).resolves.toMatchObject({
			approvalId,
			decidedBy: "user:alice",
			reason: "Not allowed",
			status: "denied",
		});

		const messages = await claw.api.listMessages({
			threadId: thread.id,
		});
		expect(messages.map((message) => message.role)).toEqual(["user"]);
		expect(
			await claw.api.getToolCallByProviderId({
				runId: "run-denied",
				toolCallId: "c1",
			}),
		).toMatchObject({ status: "denied" });
		expect(
			await claw.api.listToolResults({
				runId: "run-denied",
				toolCallId: "c1",
			}),
		).toMatchObject([
			{
				error: { decidedBy: "user:alice", reason: "Not allowed" },
				status: "failed",
			},
		]);
		await claw.api.continueRun({ approvalId });
		expect(
			await claw.api.listToolResults({
				runId: "run-denied",
				toolCallId: "c1",
			}),
		).toHaveLength(1);
	});

	it("persists completed tool calls and tool results", async () => {
		let toolSaw = "";
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: emailTool({
					onExecute: (to) => {
						toolSaw = to;
						return { sent: true, to };
					},
				}),
			},
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-tools",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		expect(toolSaw).toBe("alice@personal.com");
		expect(
			await claw.api.getToolCallByProviderId({
				runId: "run-tools",
				toolCallId: "c1",
			}),
		).toMatchObject({
			args: { to: expect.stringMatching(/^\{\{pii:/) },
			status: "completed",
			toolName: "send_email",
		});
		const results = await claw.api.listToolResults({
			runId: "run-tools",
			toolCallId: "c1",
		});
		expect(results).toMatchObject([
			{
				output: {
					sent: true,
					to: expect.stringMatching(/^\{\{pii:/),
				},
				status: "completed",
			},
		]);
	});

	it("requires a ClawsStore", async () => {
		const claw = createClaw({ model: textModel("done") });

		await expect(
			claw.api.sendMessage({
				clawId: "claw-1",
				message: "hello",
				threadId: "thread-1",
			}),
		).rejects.toThrow(/requires a ClawsStore/);
	});

	it("user event sinks are observers — a throwing sink is warned, send completes, transcript persists", async () => {
		const warnings: string[] = [];
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			events: {
				emit() {
					throw new Error("telemetry down");
				},
			},
			model: textModel("done"),
			redaction: { redactor },
			warn: (message) => warnings.push(message),
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			runId: "run-observer",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		// The recording sink still persisted the transcript — only the observer failed.
		const messages = await claw.api.listMessages({ threadId: thread.id });
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(
			warnings.some((message) =>
				message.includes("observer event sink failed"),
			),
		).toBe(true);
		expect(warnings.some((message) => message.includes("telemetry down"))).toBe(
			true,
		);
	});

	it("plugin-emitted events ride the same pipeline — observers see them, a throwing observer never breaks the door", async () => {
		const warnings: string[] = [];
		const seen: string[] = [];
		let doorEmit: Promise<void> | undefined;
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			events: [
				{
					emit() {
						throw new Error("observer down");
					},
				},
				{
					emit(event) {
						seen.push(event.type);
					},
				},
			],
			model: textModel("done"),
			plugins: [
				{
					id: "emitter",
					configure(ctx) {
						doorEmit = Promise.resolve(
							ctx.events?.emit({ type: "plugin.demo" }),
						);
						return undefined;
					},
				},
			],
			redaction: { redactor },
			warn: (message) => warnings.push(message),
		});

		expect(claw.api).toBeDefined();
		await doorEmit;
		expect(seen).toEqual(["plugin.demo"]);
		expect(
			warnings.some(
				(message) =>
					message.includes("plugin.demo") && message.includes("observer down"),
			),
		).toBe(true);
	});
});
