import type { ClawEngineFactory } from "@busyclaw/contracts";
import { threadStreamKey, userPrincipal } from "@busyclaw/contracts";
import { createMemoryAudit } from "@busyclaw/core";
import {
	createSqlEngineStore,
	sqlEngine,
	type WorkerTickResult,
} from "@busyclaw/engine-sql";
import {
	memoryAdapter,
	memorySecondaryStorage,
	secondaryStorageStream,
} from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";

/** The principal `owned()` binds onto every api call — and now what a durable run is stamped with. */
const OWNER = userPrincipal("actor-1");

import { createClaw } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	type MockModel,
	owned,
	textModel,
} from "./fixtures";

type FakeEngineRuntime = {
	generate: (prompt: string) => Promise<unknown>;
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
					proceedRun: async (input) => {
						if (input.proceed.kind !== "approval") {
							throw new Error("fake engine only resumes approvals");
						}
						const approvalId = input.proceed.approvalId;
						const id = `fake-${++nextId}`;
						events.push(`resume:${approvalId}`);
						queue.push({ approvalId, id, type: "resume" });
						return { id: input.runId };
					},
					// A fake engine still has to answer the control verb. This one has no park machinery, so
					// it says so loudly rather than being absent and silently doing nothing.
					controlRun: async (input) => {
						events.push(`control:${input.runId}:${input.intent}`);
						return { accepted: true, settled: true };
					},
					deliverMessage: async (input) => {
						events.push(`deliver:${input.toRunId}:${input.mode}`);
						return { id: "message-1", seq: 1, admitted: true };
					},
					work: async () => {
						const job = queue.shift();
						if (!job) return null;
						events.push(`work:${job.type}:${job.id}`);
						return job.type === "run"
							? runtime.generate(job.prompt)
							: runtime.continueRun(job.approvalId);
					},
				},
			};
		},
	};
}

/**
 * What the engine's `work()` produced, as the tick result it actually is.
 *
 * `EngineWorkResult` is `unknown` at the contract on purpose — an engine's work result is its own
 * business and core never reads it. This suite drives engine-sql, whose result is a
 * `WorkerTickResult`. Only the DISCRIMINANT is validated, because that is the only field these tests
 * branch on and a plain union has no schema to parse against: an unrecognised status fails here,
 * naming what came back, instead of surfacing as a confusing assertion three lines down.
 */
const TICK_STATUSES = [
	"idle",
	"waiting_approval",
	"yielded",
	"parked",
	"completed",
	"skipped",
	"failed",
] as const;

function workResult(value: unknown): WorkerTickResult {
	const status = (value as { status?: unknown } | null | undefined)?.status;
	if (
		typeof status !== "string" ||
		!TICK_STATUSES.includes(status as (typeof TICK_STATUSES)[number])
	) {
		throw new Error(
			`engine work result has no known status: ${JSON.stringify(value)}`,
		);
	}
	return value as WorkerTickResult;
}

describe("createClaw engine", () => {
	it("runs through a non-SQL engine factory", async () => {
		const events: string[] = [];
		const claw = owned({
			engine: fakeWorkflowEngine(events),
			model: textModel("done"),
		});

		expect(claw.$context.engine?.kind).toBe("fake-workflow");

		const run = await claw.api.startRun({
			ctx: { team: "acme" },
			prompt: "hello",
		});
		const result = workResult(await claw.$context.engine?.work?.());

		expect(run).toEqual({ id: "fake-1" });
		expect(result).toEqual({ status: "completed", steps: 1, text: "done" });
		expect(events).toEqual(["start:hello:acme", "work:run:fake-1"]);
	});

	it("hands a host-supplied engine the runStream the claw resolved", async () => {
		// THE README'S OWN LINE. A host writes `sqlEngine({ store })` at config time, before
		// `createClaw` has decided where live deltas go — so the factory could not have been given it,
		// and before `ClawEngineFactory.create` took services the engine simply had none. The result
		// was not a degraded stream but an EMPTY one: no text, no `run.started`, no terminal
		// lifecycle, in the configuration the docs recommend. The defaulted engine received it
		// directly and looked fine, which is what hid it.
		const db = memoryAdapter();
		const runStream = secondaryStorageStream(memorySecondaryStorage());
		const claw = owned({
			cronHandler: false,
			database: db,
			engine: sqlEngine({
				store: createSqlEngineStore(db),
				workerId: "worker-1",
				cron: false,
			}),
			runStream,
			model: textModel("done"),
			redaction: { posture: "raw" },
		});
		const agent = await claw.api.createClaw({ id: "claw-1", name: "A" });
		const thread = await claw.api.createThread({
			id: "thread-1",
			clawId: agent.id,
		});

		await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			threadId: thread.id,
		});

		const page = await runStream.read(threadStreamKey(thread.id));
		expect(page.chunks.map((chunk) => chunk.kind)).toContain("run.started");
		expect(page.chunks.map((chunk) => chunk.kind)).toContain("lifecycle");
	});

	it("exposes only the generic engine surface", () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const claw = owned({
			cronHandler: false,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: textModel("done"),
		});

		expect(Object.keys(claw.$context.engine ?? {}).sort()).toEqual([
			"controlRun",
			"deliverMessage",
			"kind",
			"proceedRun",
			// Retention, host-scheduled. Optional on the handle, because an engine over a backend that
			// owns its own durability prunes differently or not at all — and the api says so loudly
			// rather than reporting a zero that reads like "nothing to do".
			"pruneRuns",
			// Declared even when false — a door deciding what a departing reader means has to be able
			// to read "nothing will resume this", and an absent property and a false one would have to
			// be treated identically anyway.
			"resumesPendingWork",
			"startRun",
			"work",
		]);
		// `$tables` is the migration CLI's door — the merged SchemaDeclaration this claw expects to
		// exist, computed lazily on first read. It joins `$context` as an escape hatch, not product
		// api: protocol adapters still speak `claw.api.*` only.
		expect(Object.keys(claw).sort()).toEqual(["$context", "$tables", "api"]);
		expect(Object.keys(claw.api).sort()).toEqual([
			"appendMessage",
			"archiveClaw",
			"archiveThread",
			"bindConversation",
			"continueRun",
			"controlRun",
			"createCheckpoint",
			"createClaw",
			"createThread",
			"createToolCall",
			"createToolResult",
			"deletePolicySlice",
			"deliverMessage",
			"denyApproval",
			"forgetSubject",
			"generate",
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
			"listActiveRuns",
			"listApprovals",
			"listMessages",
			"listPolicySlices",
			"listRegisteredTools",
			"listRunEvents",
			"listThreads",
			"listToolResults",
			"proceedRun",
			"pruneRuns",
			"putPolicySlice",
			"registerOpenApiSpec",
			"sendMessage",
			"sendMessageAndStream",
			"shareResource",
			"startRun",
			"stream",
			"unshareResource",
			"updateClaw",
			"updateToolCallStatus",
			"watchRun",
			"watchThread",
		]);
	});

	it("runs approval resume through SQL engine tasks", async () => {
		const { db, redactor } = durableRedactor();
		const store = createSqlEngineStore(db, {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const audit = createMemoryAudit();
		const claw = owned({
			audit,
			cronHandler: false,
			database: db,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: approvalToolModel(),
			redaction: { redactor },
			tools: {
				send_email: emailTool({ onExecute: (to) => ({ sent: true, to }) }),
			},
		});

		const first = await claw.api.startRun({
			prompt: "email alice@personal.com",
		});
		const parked = workResult(await claw.$context.engine?.work?.());

		expect(parked.status).toBe("waiting_approval");
		if (parked.status !== "waiting_approval" || !parked.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		expect(first.id).toMatch(/^[0-9a-f]{32}$/);

		await claw.api.grantApproval({
			approvalId: parked.approvalIds?.[0],
		});
		// A THIRD PARTY resumes. The worker seeds the run row's principal so a durable slice executes as
		// somebody — and the run row for THIS task is stamped from whoever called continueEngineRun. If
		// that seed reached the replay, the approved action would execute as the resumer, which is the
		// escalation the approval record exists to prevent.
		// The stranger is ASSIGNED the resume permission — so the call is allowed, and the question
		// this test asks is sharpened rather than dodged: being permitted to resume is not the same as
		// getting to choose the identity the approved action executes as.
		await claw.api.shareResource({
			resourceKind: "approval",
			resourceId: parked.approvalIds?.[0],
			principalRef: userPrincipal("stranger"),
			permission: "manage",
		});
		const resume = await claw.api.proceedRun(
			{
				runId: first.id,
				proceed: { kind: "approval", approvalId: parked.approvalIds?.[0] },
			},
			{ principal: userPrincipal("stranger") },
		);
		const completed = workResult(await claw.$context.engine?.work?.());

		expect(completed.status).toBe("completed");
		expect(resume.id).toMatch(/^[0-9a-f]{32}$/);

		// The record fixes the executing identity (attest: the requester's, the approver merely
		// vouching), so the replayed tool call is attributed to the requester — never the resumer.
		const replayed = audit
			.entries()
			.filter((entry) => entry.name === "send_email");
		expect(replayed.length).toBeGreaterThan(0);
		for (const entry of replayed) {
			expect(entry.principal).not.toBe(userPrincipal("stranger"));
		}
		expect(replayed.at(-1)?.principal).toBe(userPrincipal("actor-1"));
	});

	it("enqueues and executes a SQL-engine runtime run", async () => {
		const store = createSqlEngineStore(memoryAdapter(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const claw = owned({
			cronHandler: false,
			engine: sqlEngine({ store, workerId: "worker-1" }),
			model: textModel("done"),
		});

		expect(claw.$context.engine?.kind).toBe("sql");
		// `run.principal` is no longer accepted from the body — the durable run executes its tool calls
		// under it, so it is stamped from the authenticated caller. `owned()` binds `user:actor-1`.
		const run = await claw.api.startRun({
			ctx: { team: "acme" },
			prompt: "hello",
		});
		const result = workResult(await claw.$context.engine?.work?.());

		expect(result.status).toBe("completed");
		expect(run.id).toMatch(/^[0-9a-f]{32}$/);
		// getRun/listRunEvents are owner-isolated (app-authz slice 5): read AS the run's principal.
		await expect(
			claw.api.getRun({ id: run.id }, { principal: OWNER }),
		).resolves.toMatchObject({
			id: run.id,
			status: "completed",
			principal: OWNER,
		});
		await expect(
			claw.api.listRunEvents({ runId: run.id }, { principal: OWNER }),
		).resolves.toEqual(
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
		// Annotated as MockModel — the V4 member — so `doGenerate` has ONE signature and `options`
		// (which this test reads `abortSignal` off) is contextually typed. Spread inline, TS has the
		// V2|V3|V4 union and no single parameter type to give it.
		const abortingModel: MockModel = {
			...textModel("done"),
			doGenerate: async (options) => {
				const timers = globalThis as typeof globalThis & {
					setTimeout: (fn: () => void, ms: number) => unknown;
				};
				while (!options.abortSignal?.aborted) {
					await new Promise<void>((resolve) => timers.setTimeout(resolve, 10));
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
		};
		const claw = owned({
			cronHandler: false,
			engine: sqlEngine({ store, workerId: "worker-1", leaseTtlMs: 1 }),
			model: abortingModel,
		});

		const run = await claw.api.startRun({ prompt: "hello" });
		const result = workResult(await claw.$context.engine?.work?.());

		expect(result).toMatchObject({ status: "failed", task: null });
		await abortObserved;
		expect(run.id).toMatch(/^[0-9a-f]{32}$/);
	});
});
