import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	floorPermitsWrites,
	lookupTool,
	lookupToolModel,
	textModel,
	volunteersPiiModel,
	withPrincipal,
} from "./fixtures";

const ACTOR = "user:actor-1";

async function createAgentThread(claw: ReturnType<typeof createClaw>) {
	// The app-authz caller is bound to the claw owner, so its owner rule permits the claw-scoped calls.
	const api = withPrincipal(claw, ACTOR).api;
	const agent = await api.createClaw({
		id: "claw-1",
		createdBy: ACTOR,
		name: "Recruiting assistant",
	});
	const thread = await api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Candidate Alice",
	});
	return { api, agent, thread };
}

describe("createClaw send", () => {
	it("persists user and assistant transcript messages", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
		});
		const { api, agent, thread } = await createAgentThread(claw);

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: "hello",
			runId: "run-1",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		expect(sent.userMessage).toMatchObject({ role: "user", sequence: 1 });
		const messages = await api.listMessages({
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
		expect(await api.getThread({ id: thread.id })).toMatchObject({
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
				send_email: emailTool(
					{ onExecute: () => ({ sent: true }) },
					{
					},
				),
			},
		});
		const { api, agent, thread } = await createAgentThread(claw);

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-approval",
			threadId: thread.id,
		});

		expect(sent.result.status).toBe("waiting_approval");
		const messages = await api.listMessages({
			threadId: thread.id,
		});
		expect(messages).toMatchObject([
			{
				// The product transcript is tokenized at rest too — same rule as the tool args below.
				content: {
					text: expect.stringMatching(/^email \{\{pii:email:[a-z0-9-]+\}\}$/),
				},
				role: "user",
				sequence: 1,
			},
		]);
		const checkpoint = await api.getLatestCheckpoint({
			runId: "run-approval",
		});
		expect(checkpoint).toMatchObject({
			clawId: agent.id,
			kind: "approval_wait",
			state: { approvalIds: expect.any(Array) },
			threadId: thread.id,
		});
		const toolCall = await api.getToolCallByProviderId({
			runId: "run-approval",
			toolCallId: "c1",
		});
		expect(toolCall).toMatchObject({
			args: { to: expect.stringMatching(/^\{\{pii:/) },
			status: "waiting_approval",
			toolName: "send_email",
		});
		expect(JSON.stringify(toolCall)).not.toContain("alice@personal.com");
		const approvals = await api.listApprovals({ status: "pending" });
		expect(JSON.stringify(approvals)).not.toContain("alice@personal.com");
		expect(
			JSON.stringify(await api.getLatestCheckpoint({ runId: "run-approval" })),
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
				send_email: emailTool(
					{
						onExecute: (to) => {
							toolSaw = to;
							return { sent: true, to };
						},
					},
				),
			},
		});
		const { api, agent, thread } = await createAgentThread(claw);

		const sent = await api.sendMessage({
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

		await api.grantApproval({ approvalId, by: "user:alice" });
		const resumed = await api.continueRun({ approvalId });

		expect(resumed).toMatchObject({ status: "completed", text: "done" });
		expect(toolSaw).toBe("alice@personal.com");
		const messages = await api.listMessages({
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
			await api.getToolCallByProviderId({
				runId: "run-resume",
				toolCallId: "c1",
			}),
		).toMatchObject({ status: "completed" });
		expect(
			await api.listToolResults({
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
				send_email: emailTool(
					{ onExecute: () => ({ sent: true }) },
					{
					},
				),
			},
		});
		const { api, agent, thread } = await createAgentThread(claw);

		const sent = await api.sendMessage({
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

		// `decidedBy` is stamped from the caller (arg 2), never a body `by` — alice denies here, so the
		// denial records decidedBy = user:alice (docs/plans/stamped-fields.md, #6).
		await api.denyApproval(
			{ approvalId, reason: "Not allowed" },
			{ principal: "user:alice" },
		);
		await expect(api.continueRun({ approvalId })).resolves.toMatchObject({
			approvalId,
			decidedBy: "user:alice",
			reason: "Not allowed",
			status: "denied",
		});

		const messages = await api.listMessages({
			threadId: thread.id,
		});
		expect(messages.map((message) => message.role)).toEqual(["user"]);
		expect(
			await api.getToolCallByProviderId({
				runId: "run-denied",
				toolCallId: "c1",
			}),
		).toMatchObject({ status: "denied" });
		expect(
			await api.listToolResults({
				runId: "run-denied",
				toolCallId: "c1",
			}),
		).toMatchObject([
			{
				error: { decidedBy: "user:alice", reason: "Not allowed" },
				status: "failed",
			},
		]);
		await api.continueRun({ approvalId });
		expect(
			await api.listToolResults({
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
			// This one is about PERSISTENCE — the call and result rows a completed tool leaves behind —
			// so the write has to actually complete. Its siblings above assert the approval wait itself
			// and must NOT take this exemption.
			plugins: [floorPermitsWrites],
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
		const { api, agent, thread } = await createAgentThread(claw);

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-tools",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		expect(toolSaw).toBe("alice@personal.com");
		expect(
			await api.getToolCallByProviderId({
				runId: "run-tools",
				toolCallId: "c1",
			}),
		).toMatchObject({
			args: { to: expect.stringMatching(/^\{\{pii:/) },
			status: "completed",
			toolName: "send_email",
		});
		const results = await api.listToolResults({
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
		const api = withPrincipal(claw, ACTOR).api;

		await expect(
			api.sendMessage({
				clawId: "claw-1",
				message: "hello",
				threadId: "thread-1",
			}),
			// A claw with no ClawsStore fails loud with a CONFIGURATION error naming what is missing — not
			// an authorization denial. The PEP reaches this first now (it has to resolve the claw before the
			// handler runs) and deliberately distinguishes "this deployment cannot answer the question" from
			// "the answer is no": both refuse the call, but only one sends the reader to the right fix.
		).rejects.toThrow(/cannot authorize "claw" resources/);
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
		const { api, agent, thread } = await createAgentThread(claw);

		const sent = await api.sendMessage({
			clawId: agent.id,
			message: "hello",
			runId: "run-observer",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		// The recording sink still persisted the transcript — only the observer failed.
		const messages = await api.listMessages({ threadId: thread.id });
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

	// Model OUTPUT is an untrusted PII source in its own right. On the strict path the model only ever
	// saw placeholders, so it is tempting to treat what comes back as already-clean — but a model can
	// volunteer an address from training, or reassemble one from fragments the ingress detector missed.
	// That value has no mapping, so `forgetSubject` can never reach it: it would sit in the transcript
	// (and checkpoints, and approval metadata) as permanent, unerasable cleartext.
	it("tokenizes PII the model itself volunteers (strict mode)", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: volunteersPiiModel("carol@leak.example"),
			redaction: { redactor },
		});
		const { api, agent, thread } = await createAgentThread(claw);

		await api.sendMessage({
			clawId: agent.id,
			message: "who should I contact?",
			runId: "run-volunteered",
			threadId: thread.id,
		});

		// The durable assistant message must carry a placeholder, never the address itself.
		const messages = await api.listMessages({ threadId: thread.id });
		const persisted = JSON.stringify(messages);
		expect(persisted).not.toContain("carol@leak.example");
		expect(persisted).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);

		// ...and it is a real mapping, not a blind scrub: the read-side view resolves it back.
		const revealed = await api.listMessages({
			threadId: thread.id,
			view: "original",
		});
		expect(JSON.stringify(revealed)).toContain("carol@leak.example");
	});

	// The run's redaction CONTAINER is a fence, not a label. This exercises the namespace the RUNTIME
	// mints into — PII born INSIDE a run, in a tool RESULT — which is the half the api never touches
	// (a user message is already tokenized, in the claw's container, before the run starts).
	//
	// Unstamped, the runtime redacted with NO container, so every run of every claw minted into one
	// global namespace and claw A's token resolved to cleartext at claw B's tool edge. Nothing throws
	// when that happens — the tool simply receives another scope's real address — so it is asserted.
	it("does not rehydrate another claw's run-minted placeholder (container isolation)", async () => {
		const { db, redactor } = durableRedactor();
		let sawInB = "";

		// Claw A: the address is born in a tool result, so the RUNTIME mints its mapping.
		const clawA = createClaw({
			database: db,
			model: lookupToolModel(),
			redaction: { redactor },
			tools: { lookup: lookupTool("bob@corp.example") },
		});
		const apiA = withPrincipal(clawA, ACTOR).api;
		const agentA = await apiA.createClaw({
			id: "claw-a",
			createdBy: ACTOR,
			name: "A",
		});
		const threadA = await apiA.createThread({
			id: "thread-a",
			clawId: agentA.id,
			title: "A",
		});
		await apiA.sendMessage({
			clawId: agentA.id,
			message: "who is the contact?",
			runId: "run-a",
			threadId: threadA.id,
		});

		// The tool RESULT as persisted — tokenized at rest, which is the whole point. This mapping was
		// minted by the runtime (the address never passed through the api), so it is the one that used
		// to land in the global container.
		const persistedA = JSON.stringify(
			await apiA.listToolResults({ runId: "run-a", toolCallId: "lookup-1" }),
		);
		expect(persistedA).not.toContain("bob@corp.example");
		const token = persistedA.match(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/)?.[0];
		expect(token).toBeDefined();

		// Claw B replays claw A's token. A different container ⇒ out of reach: the tool must receive
		// the placeholder verbatim, never the other claw's real address.
		const clawB = createClaw({
			database: db,
			model: approvalToolModel(),
			// The assertion is on what the TOOL RECEIVED, so the write has to reach the tool. What is
			// under test is container isolation in the redactor, not the floor.
			plugins: [floorPermitsWrites],
			redaction: { redactor },
			tools: {
				send_email: emailTool({
					onExecute: (to) => {
						sawInB = to;
						return { sent: true, to };
					},
				}),
			},
		});
		const apiB = withPrincipal(clawB, ACTOR).api;
		const agentB = await apiB.createClaw({
			id: "claw-b",
			createdBy: ACTOR,
			name: "B",
		});
		const threadB = await apiB.createThread({
			id: "thread-b",
			clawId: agentB.id,
			title: "B",
		});
		await apiB.sendMessage({
			clawId: agentB.id,
			message: `email ${token}`,
			threadId: threadB.id,
		});

		expect(sawInB).not.toBe("bob@corp.example");
		expect(sawInB).toBe(token);
	});
});
