// WHAT HAPPENS WHEN THE READER WALKS AWAY — docs/plans/one-run.md D6.
//
// The rule everyone agrees on is that a closed tab must never destroy a nearly-finished answer. What
// the rule DOES is not one thing, and that is what this file is about: it depends entirely on whether
// anything will pick the run up again.
//
// WITH a continuation path, a departure brings the deadline forward to now. The slice reaches its next
// control point, writes a checkpoint, enqueues its resume, and the drain finishes the turn. That
// matters most where the premise bites: on serverless the isolate lives only as long as the response
// body, so every further step is borrowed time, and bounding what this invocation still owes to one
// model step is the difference between parking cleanly and being killed mid-step.
//
// WITHOUT one — `cron: false`, where a pending task is claimed by nobody — the same move converts a
// turn that finishes into a turn that never lands. So the run detaches and finishes here, which is
// what the code has always done and is the right answer when nobody will resume.
//
// The two arms are tested against ONE model and ONE departure, differing only in the cron posture, so
// the gate itself is what the tests can see.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { govern } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import type { RuntimeModel } from "@busyclaw/runtime";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import { jsonSchema, tool } from "ai";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
	drivenResult,
	emailDetector,
	floorPermitsWrites,
	owned,
} from "./fixtures";

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/**
 * Streams `words`, then either calls `ping` or stops — a turn with more than one step to leave in.
 *
 * It must STREAM, because the departure signal is the reader cancelling the delta channel, and it must
 * take more than one step, because the deadline arm is gated on progress: a run that has completed
 * zero steps never parks, and a single-step turn has no second control point to park at.
 */
function streamingToolModel(toolSteps: number): RuntimeModel {
	let call = 0;
	const parts = (step: number) => {
		const words = [`step${step}`, "thinking", "out", "loud"];
		const chunks: Record<string, unknown>[] = [{ type: "text-start", id: "0" }];
		words.forEach((word, index) => {
			chunks.push({
				type: "text-delta",
				id: "0",
				delta: index === 0 ? word : ` ${word}`,
			});
		});
		chunks.push({ type: "text-end", id: "0" });
		if (step <= toolSteps) {
			chunks.push({
				type: "tool-call",
				toolCallId: `c${step}`,
				toolName: "ping",
				input: JSON.stringify({ n: step }),
			});
		}
		chunks.push({
			type: "finish",
			finishReason: {
				unified: step <= toolSteps ? "tool-calls" : "stop",
				raw: undefined,
			},
			usage,
		});
		return chunks;
	};
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock-streaming-tools",
		supportedUrls: {},
		doGenerate: async () => {
			const step = ++call;
			return {
				content:
					step <= toolSteps
						? [
								{
									type: "tool-call" as const,
									toolCallId: `c${step}`,
									toolName: "ping",
									input: JSON.stringify({ n: step }),
								},
							]
						: [
								{
									type: "text" as const,
									text: `step${step} thinking out loud`,
								},
							],
				finishReason: {
					unified:
						step <= toolSteps ? ("tool-calls" as const) : ("stop" as const),
					raw: undefined,
				},
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			const step = ++call;
			return {
				stream: new ReadableStream({
					start(controller) {
						for (const part of parts(step)) controller.enqueue(part);
						controller.close();
					},
				}),
				warnings: [],
			};
		},
	} as unknown as RuntimeModel;
}

const openDatabases: (() => void)[] = [];
afterEach(() => {
	for (const close of openDatabases.splice(0)) close();
});

/**
 * A claw over a REAL database, because the cron-on arm has two drivers over one row set — the door and
 * the drain — and `memoryAdapter`'s transaction snapshots and refills the whole store, which erases
 * concurrent writes rather than isolating them (hazard C2). The default engine refuses that adapter
 * with a `cronHandler` set for exactly this reason.
 */
async function conversation(input: {
	cron: boolean;
	toolSteps: number;
	onTool?: () => void;
}) {
	const sqlite = new Database(":memory:");
	openDatabases.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const store = createSqlEngineStore(adapter);
	const claw = owned({
		// The ONE difference between the two arms. `cronHandler` decides the engine's cron posture,
		// which decides `resumesPendingWork`, which decides what a departure means.
		cronHandler: input.cron ? { secret: "cron-secret" } : false,
		database: adapter,
		engine: sqlEngine(
			input.cron
				? { store, workerId: "w1" }
				: { store, workerId: "w1", cron: false },
		),
		model: streamingToolModel(input.toolSteps),
		plugins: [floorPermitsWrites],
		redaction: {
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(adapter),
			}),
		},
		tools: {
			ping: govern(
				tool({
					description: "Ping.",
					inputSchema: jsonSchema<{ n: number }>({
						type: "object",
						properties: { n: { type: "number" } },
						required: ["n"],
					}),
					execute: async ({ n }) => {
						input.onTool?.();
						return { pong: n };
					},
				}),
				{},
			),
		},
	} as Parameters<typeof owned>[0]);
	const plan = await planMigrations({
		db: kdb,
		schema: claw.$tables as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	const { api } = claw;
	const agent = await api.createClaw({ id: "claw-1", name: "Assistant" });
	const thread = await api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Chat",
	});
	return { agent, api, claw, store, thread };
}

/** Send, read exactly one delta, and walk away — the tab closing, in one line. */
async function leaveAfterOneDelta(
	api: Awaited<ReturnType<typeof conversation>>["api"],
	agentId: string,
	threadId: string,
) {
	const stream = await api.sendMessageAndStream({
		clawId: agentId,
		threadId,
		message: "hello",
	});
	for await (const _delta of stream.textStream) break;
	return stream;
}

describe("a departing reader, with somewhere for the run to go", () => {
	it("yields the slice, and the drain finishes the turn into the same thread", async () => {
		let toolCalls = 0;
		const { agent, api, claw, store, thread } = await conversation({
			cron: true,
			toolSteps: 1,
			onTool: () => {
				toolCalls += 1;
			},
		});

		const stream = await leaveAfterOneDelta(api, agent.id, thread.id);
		const first = await stream.result;

		// THE SLICE ENDED EARLY, with resume state behind it. Not `completed` — that would mean the
		// departure changed nothing — and not `parked`, which enqueues no continuation and would leave
		// this turn waiting for a verb nobody is going to say.
		if (!first.driven) throw new Error("expected this caller to drive");
		expect(first.result.status).toBe("yielded");
		if (first.result.status !== "yielded") throw new Error("unreachable");
		expect(first.result.checkpointId).toBeTruthy();
		// AND IT CARRIES WHAT IT SAID. This was the literal `''`, so the words the reader had already
		// watched arrive existed nowhere afterwards.
		expect(first.result.text).toContain("step1");

		// The run is not finished, and says so.
		expect((await store.getRun(stream.runId))?.status).toBe("queued");

		// THE DRAIN PICKS IT UP — the half a `cron: false` deployment does not have.
		const resumed = await claw.$context.engine?.work?.();
		expect((resumed as { status?: string } | undefined)?.status).toBe(
			"completed",
		);
		expect((await store.getRun(stream.runId))?.status).toBe("completed");

		// ONE answer in the thread the reader will come back to, and ONE execution of the tool: the
		// continuation resumed from the checkpoint rather than replaying the turn from step 0.
		const answers = (
			await api.listMessages({ threadId: thread.id, visibility: ["user"] })
		).filter((message) => message.role === "assistant");
		expect(answers).toHaveLength(1);
		expect(JSON.stringify(answers[0]?.content)).toContain("step2");
		expect(toolCalls).toBe(1);
	});

	it("still completes when the departure lands on the FINAL step", async () => {
		// The progress guard makes this free: a single-step turn returns `completed` before it can
		// reach a control point to park at, so there is no checkpoint, no continuation and no drain.
		let toolCalls = 0;
		const { agent, api, store, thread } = await conversation({
			cron: true,
			toolSteps: 0,
			onTool: () => {
				toolCalls += 1;
			},
		});

		const stream = await leaveAfterOneDelta(api, agent.id, thread.id);
		const final = drivenResult(await stream.result);

		expect(final.status).toBe("completed");
		expect(final.text).toBe("step1 thinking out loud");
		expect((await store.getRun(stream.runId))?.status).toBe("completed");
		expect(toolCalls).toBe(0);
		const answers = await api.listMessages({
			threadId: thread.id,
			visibility: ["user"],
		});
		expect(answers.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});
});

describe("a departing reader, with nowhere for the run to go", () => {
	it("detaches and finishes rather than yielding into a queue nobody drains", async () => {
		// THE REGRESSION THE GATE EXISTS FOR. Same model, same departure, `cron: false` — and yielding
		// here would leave a `pending` task whose only claimant is a drain that does not run, so the
		// answer would never land at all. Instead the run finishes in this invocation.
		let toolCalls = 0;
		const { agent, api, store, thread } = await conversation({
			cron: false,
			toolSteps: 1,
			onTool: () => {
				toolCalls += 1;
			},
		});

		const stream = await leaveAfterOneDelta(api, agent.id, thread.id);
		const final = drivenResult(await stream.result);

		expect(final.status).toBe("completed");
		expect((await store.getRun(stream.runId))?.status).toBe("completed");
		// Both steps ran, here, in the invocation the reader abandoned.
		expect(toolCalls).toBe(1);
		const answers = (
			await api.listMessages({ threadId: thread.id, visibility: ["user"] })
		).filter((message) => message.role === "assistant");
		expect(answers).toHaveLength(1);
		expect(JSON.stringify(answers[0]?.content)).toContain("step2");
	});
});

describe("a thread can tell a stopped run from a working one", () => {
	it("leaves a park notice and a park checkpoint when somebody suspends the turn", async () => {
		// D10: a reader has no run id to ask about until something in the thread hands them one, and
		// `listMessages` is the only thread-scoped door there is. A run that parks used to write a
		// checkpoint nobody can reach and nothing else, so the conversation simply stopped.
		const { agent, api, claw, thread } = await conversation({
			cron: true,
			toolSteps: 2,
		});

		const stream = await api.sendMessageAndStream({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});
		// Suspended from the outside WHILE the turn runs, and the stream is drained to the end rather
		// than abandoned — so this tests the park and not the departure.
		let asked = false;
		for await (const _delta of stream.textStream) {
			if (asked) continue;
			asked = true;
			await api.controlRun({ runId: stream.runId, intent: "suspend" });
		}
		const parked = await stream.result;
		if (!parked.driven) throw new Error("expected this caller to drive");
		expect(parked.result.status).toBe("parked");

		const messages = await api.listMessages({ threadId: thread.id });
		expect(messages).toMatchObject([
			{ role: "user", visibility: "user" },
			{
				content: { run: { state: "parked", reason: "suspended" } },
				visibility: "internal",
			},
		]);
		// The partial answer rides the notice, because those words were produced and streamed and the
		// alternative is that they existed nowhere.
		expect(JSON.stringify(messages[1]?.content)).toContain("step1");
		// And the product-history record says PARK, not `step`: a yield comes back on its own and this
		// does not, so a reader that cannot tell them apart cannot tell working from waiting.
		expect(
			await claw.api.getLatestCheckpoint({ runId: stream.runId }),
		).toMatchObject({ kind: "park", state: { reason: "suspended" } });
	});
});
