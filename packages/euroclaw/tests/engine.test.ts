import type { ClawEngineFactory } from "@euroclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@euroclaw/engine-sql";
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	textModel,
} from "./fixtures";

type FakeEngineRuntime = {
	run: (prompt: string) => Promise<unknown>;
	continueRun: (id: string) => Promise<unknown>;
};

function fakeWorkflowEngine(
	events: string[],
): ClawEngineFactory<FakeEngineRuntime> {
	let nextId = 0;
	return {
		kind: "fake-workflow",
		create: (runtime) => {
			const queue: Array<
				| { id: string; prompt: string; type: "run" }
				| { approvalId: string; id: string; type: "resume" }
			> = [];
			return {
				engine: {
					kind: "fake-workflow",
					startRun: async (input) => {
						const id = `fake-${++nextId}`;
						events.push(
							`start:${input.prompt}:${String(input.ctx?.team ?? "none")}`,
						);
						queue.push({ id, prompt: input.prompt, type: "run" });
						return { id };
					},
					continueRun: async (input) => {
						const id = `fake-${++nextId}`;
						events.push(`resume:${input.approvalId}`);
						queue.push({ approvalId: input.approvalId, id, type: "resume" });
						return { id };
					},
					work: async () => {
						const job = queue.shift();
						if (!job) return null;
						events.push(`work:${job.type}:${job.id}`);
						return job.type === "run"
							? runtime.run(job.prompt)
							: runtime.continueRun(job.approvalId);
					},
				},
			};
		},
	};
}

describe("createClaw engine", () => {
	it("runs through a non-SQL engine factory", async () => {
		const events: string[] = [];
		const claw = createClaw({
			engine: fakeWorkflowEngine(events),
			model: textModel("done"),
		});

		expect(claw.$context.engine?.kind).toBe("fake-workflow");

		const run = await claw.api.startRun({
			ctx: { team: "acme" },
			prompt: "hello",
		});
		const result = await claw.$context.engine?.work?.();

		expect(run).toEqual({ id: "fake-1" });
		expect(result).toEqual({ status: "completed", steps: 1, text: "done" });
		expect(events).toEqual(["start:hello:acme", "work:run:fake-1"]);
	});

	it("exposes only the generic engine surface", () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const claw = createClaw({
			cronHandler: false,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: textModel("done"),
		});

		expect(Object.keys(claw.$context.engine ?? {}).sort()).toEqual([
			"continueRun",
			"kind",
			"startRun",
			"work",
		]);
		expect(Object.keys(claw).sort()).toEqual(["$context", "api"]);
		expect(Object.keys(claw.api).sort()).toEqual([
			"appendMessage",
			"archiveClaw",
			"archiveThread",
			"bindConversation",
			"continueEngineRun",
			"continueRun",
			"createCheckpoint",
			"createClaw",
			"createThread",
			"createToolCall",
			"createToolResult",
			"deletePolicySlice",
			"denyApproval",
			"forgetSubject",
			"getApproval",
			"getCheckpoint",
			"getClaw",
			"getEffect",
			"getLatestCheckpoint",
			"getMessage",
			"getRun",
			"getThread",
			"getToolCall",
			"getToolCallByProviderId",
			"getToolResult",
			"grantApproval",
			"listActions",
			"listApprovals",
			"listMessages",
			"listPolicySlices",
			"listRegisteredTools",
			"listRunEvents",
			"listThreads",
			"listToolResults",
			"putPolicySlice",
			"registerOpenApiSpec",
			"run",
			"sendMessage",
			"startRun",
			"updateClaw",
			"updateToolCallStatus",
		]);
	});

	it("runs approval resume through SQL engine tasks", async () => {
		const { db, redactor } = durableRedactor();
		const store = createSqlEngineStore(db, {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const claw = createClaw({
			cronHandler: false,
			database: db,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: govern(
					emailTool({ onExecute: (to) => ({ sent: true, to }) }),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});

		const first = await claw.api.startRun({
			prompt: "email alice@personal.com",
		});
		const parked = await claw.$context.engine?.work?.();

		expect(parked.status).toBe("waiting_approval");
		if (parked.status !== "waiting_approval" || !parked.approvalIds[0]) {
			throw new Error("expected approval wait");
		}
		expect(first.id).toMatch(/^[0-9a-f]{32}$/);

		await claw.api.grantApproval({
			approvalId: parked.approvalIds[0],
			by: "alice",
		});
		const resume = await claw.api.continueEngineRun({
			approvalId: parked.approvalIds[0],
		});
		const completed = await claw.$context.engine?.work?.();

		expect(completed.status).toBe("completed");
		expect(resume.id).toMatch(/^[0-9a-f]{32}$/);
	});

	it("enqueues and executes a SQL-engine runtime run", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const claw = createClaw({
			cronHandler: false,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: textModel("done"),
		});

		expect(claw.$context.engine?.kind).toBe("sql");
		const run = await claw.api.startRun({
			ctx: { team: "acme" },
			prompt: "hello",
			run: { principal: "alice", team: "acme" },
		});
		const result = await claw.$context.engine?.work?.();

		expect(result.status).toBe("completed");
		expect(run.id).toMatch(/^[0-9a-f]{32}$/);
		await expect(claw.api.getRun({ id: run.id })).resolves.toMatchObject({
			id: run.id,
			status: "completed",
			principal: "alice",
			team: "acme",
		});
		await expect(claw.api.listRunEvents({ runId: run.id })).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "run.started" }),
				expect.objectContaining({ type: "run.completed" }),
			]),
		);
	});

	it("aborts SQL-engine runtime work when task heartbeat is lost", async () => {
		const baseStore = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const store = { ...baseStore, heartbeatLease: async () => null };
		let resolveAbort: () => void = () => {};
		const abortObserved = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const claw = createClaw({
			cronHandler: false,
			engine: sqlEngine({ store, workerId: "worker-1", leaseTtlMs: 1 }),
			model: {
				...textModel("done"),
				doGenerate: async (options) => {
					const timers = globalThis as typeof globalThis & {
						setTimeout: (fn: () => void, ms: number) => unknown;
					};
					while (!options.abortSignal?.aborted) {
						await new Promise<void>((resolve) =>
							timers.setTimeout(resolve, 10),
						);
					}
					resolveAbort();
					return {
						content: [{ type: "text", text: "should not persist" }],
						finishReason: { unified: "stop", raw: undefined },
						usage: {
							inputTokens: {
								total: 1,
								noCache: undefined,
								cacheRead: undefined,
								cacheWrite: undefined,
							},
							outputTokens: { total: 1, text: undefined, reasoning: undefined },
						},
						warnings: [],
					};
				},
			},
		});

		const run = await claw.api.startRun({ prompt: "hello" });
		const result = await claw.$context.engine?.work?.();

		expect(result).toMatchObject({ status: "failed", task: null });
		await abortObserved;
		expect(run.id).toMatch(/^[0-9a-f]{32}$/);
	});
});
