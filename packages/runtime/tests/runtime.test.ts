import type {
	Detector,
	EffectStore,
	EuroclawPlugin,
	PiiSpan,
} from "@euroclaw/contracts";
import { RUN_MODE_CONTEXT_KEY, userPrincipal } from "@euroclaw/contracts";
import {
	createMemoryAudit,
	createMemoryRedactor,
	createStoredRedactor,
} from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import {
	createEffectStore,
	createPiiMappingStore,
} from "@euroclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
	createRuntime,
	govern,
	type RuntimeEvent,
	runtimeRunOptionsWithRecording,
} from "../src/index";

const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			value,
			kind: "email",
			source: "regex",
		});
	}
	return spans;
};

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function scriptedModel(received: { prompt: string }): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const promptText = JSON.stringify(options.prompt);
			received.prompt = promptText;
			const usage = {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			};
			if (step++ === 0) {
				const token =
					promptText.match(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/)?.[0] ?? "NOTOKEN";
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "send_email",
							input: JSON.stringify({ to: token }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop", raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

function textOnlyModel(text: string): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
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
		}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

describe("@euroclaw/runtime", () => {
	it("rejects database-backed approval runtime with non-durable redactor", () => {
		expect(() =>
			createRuntime({
				model: scriptedModel({ prompt: "" }),
				database: memoryAdapter(),
				redactor: createMemoryRedactor(emailDetector),
			}),
		).toThrow(/durable redactor/);
	});

	it("rejects database-backed approval runtime with no redactor", () => {
		expect(() =>
			createRuntime({
				model: scriptedModel({ prompt: "" }),
				database: memoryAdapter(),
			}),
		).toThrow(/durable redactor/);
	});

	it("redacts model prompts, rehydrates tool args, and audits both boundaries", async () => {
		let toolSaw = "";
		const received = { prompt: "" };
		const runtime = createRuntime({
			model: scriptedModel(received),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: {
				send_email: tool({
					description: "Send an email.",
					inputSchema: jsonSchema<{ to: string }>({
						type: "object",
						properties: { to: { type: "string" } },
						required: ["to"],
					}),
					execute: async ({ to }) => {
						toolSaw = to;
						return { sent: true };
					},
				}),
			},
		});

		const result = await runtime.generate("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		expect(result.text).toBe("done");
		expect(received.prompt).not.toContain("alice@personal.com");
		expect(received.prompt).toMatch(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/);
		expect(toolSaw).toBe("alice@personal.com");
		expect(JSON.stringify(runtime.audit?.entries() ?? [])).not.toContain(
			"alice@personal.com",
		);
	});

	it("fails closed when runtime model audit append fails", async () => {
		const runtime = createRuntime({
			model: textOnlyModel("done"),
			audit: {
				append: async () => {
					throw new Error("audit unavailable");
				},
				entries: () => [],
			},
		});

		await expect(runtime.generate("hello")).rejects.toThrow(/audit unavailable/);
	});

	it("emits typed run lifecycle events and awaits sinks", async () => {
		const events: RuntimeEvent[] = [];
		let completedSinkFinished = false;
		const runtime = createRuntime({
			model: textOnlyModel("done"),
			environment: {
				newId: (prefix) => `${prefix}_fixed`,
				now: () => "2026-01-01T00:00:00.000Z",
			},
			events: {
				async emit(event) {
					events.push(event);
					if (event.type === "run.completed") {
						await Promise.resolve();
						completedSinkFinished = true;
					}
				},
			},
		});

		const result = await runtime.generate(
			"hello",
			undefined,
			runtimeRunOptionsWithRecording(undefined, {
				clawId: "claw-1",
				runId: "run-1",
				threadId: "thread-1",
			}),
		);

		expect(result).toMatchObject({ status: "completed", text: "done" });
		expect(completedSinkFinished).toBe(true);
		expect(events.map((event) => event.type)).toEqual([
			"run.started",
			"model.completed",
			"run.completed",
		]);
		expect(events[0]).toMatchObject({
			prompt: "hello",
			recording: {
				clawId: "claw-1",
				runId: "run-1",
				threadId: "thread-1",
			},
			runId: "run-1",
		});
		expect(events[0]).toMatchObject({
			createdAt: "2026-01-01T00:00:00.000Z",
			id: "evt_fixed",
		});
	});

	it("a throwing observer sink does not fail the run and is warned", async () => {
		const warnings: string[] = [];
		const seenAfter: string[] = [];
		const runtime = createRuntime({
			model: textOnlyModel("done"),
			events: [
				{
					emit(event) {
						if (event.type === "run.completed") {
							throw new Error("observer sink unavailable");
						}
					},
				},
				{
					emit(event) {
						seenAfter.push(event.type);
					},
				},
			],
			warn: (message) => warnings.push(message),
		});

		const result = await runtime.generate("hello");

		expect(result).toMatchObject({ status: "completed", text: "done" });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("observer event sink failed");
		expect(warnings[0]).toContain("run.completed");
		expect(warnings[0]).toContain("observer sink unavailable");
		// The failure stays isolated — later observers still saw every event.
		expect(seenAfter).toContain("run.completed");
	});

	it("fails closed when the recording sink fails", async () => {
		const runtime = createRuntime({
			model: textOnlyModel("done"),
			recording: {
				emit(event) {
					if (event.type === "run.completed") {
						throw new Error("recording sink unavailable");
					}
				},
			},
		});

		await expect(runtime.generate("hello")).rejects.toThrow(
			/recording sink unavailable/,
		);
	});

	it("redacts tool error payloads before persistence", async () => {
		const events: RuntimeEvent[] = [];
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			audit: createMemoryAudit(),
			database: db,
			events: { emit: (event) => events.push(event) },
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: tool({
					description: "Send an email.",
					inputSchema: jsonSchema<{ to: string }>({
						type: "object",
						properties: { to: { type: "string" } },
						required: ["to"],
					}),
					execute: async ({ to }) => {
						throw new Error(`cannot email ${to}`);
					},
				}),
			},
		});

		await expect(runtime.generate("email alice@personal.com")).rejects.toThrow(
			/cannot email alice@personal.com/,
		);
		expect(JSON.stringify(events)).not.toContain("alice@personal.com");
		expect(JSON.stringify(runtime.audit?.entries() ?? [])).not.toContain(
			"alice@personal.com",
		);
	});

	it("ignores caller-supplied reserved recording context", async () => {
		const events: RuntimeEvent[] = [];

		const result = await createRuntime({
			model: textOnlyModel("done"),
			events: { emit: (event) => events.push(event) },
		}).generate("hello", { euroclaw__recording: { clawId: "claw-1" } });

		expect(result.status).toBe("completed");
		expect(events.every((event) => event.recording === undefined)).toBe(true);
	});

	it("emits waiting approval events", async () => {
		const events: RuntimeEvent[] = [];
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			events: { emit: (event) => events.push(event) },
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async () => ({ sent: true }),
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
					},
				),
			},
		});

		const result = await runtime.generate(
			"email alice@personal.com",
			undefined,
			runtimeRunOptionsWithRecording(undefined, {
				clawId: "claw-1",
				runId: "run-approval",
				threadId: "thread-1",
			}),
		);

		expect(result.status).toBe("waiting_approval");
		expect(events.map((event) => event.type)).toEqual([
			"run.started",
			"model.completed",
			"tool.called",
			"tool.waiting_approval",
			"run.waiting_approval",
		]);
		expect(events[2]).toMatchObject({
			toolCallId: "c1",
			toolName: "send_email",
			type: "tool.called",
		});
		expect(events[3]).toMatchObject({
			toolCallId: "c1",
			toolName: "send_email",
			type: "tool.waiting_approval",
		});
		expect(events[4]).toMatchObject({
			runId: "run-approval",
			type: "run.waiting_approval",
		});
		if (events[4]?.type !== "run.waiting_approval") {
			throw new Error("expected waiting approval event");
		}
		expect(events[4].approvalIds).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("alice@personal.com");
		expect(events[0]).toMatchObject({
			prompt: expect.stringMatching(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/),
		});
		expect(events[2]).toMatchObject({
			args: { to: expect.stringMatching(/^\{\{pii:/) },
		});
		const approvals = await runtime.approvals?.list({ status: "pending" });
		expect(JSON.stringify(approvals)).not.toContain("alice@personal.com");
	});

	it("fails closed before provider execution when a model boundary asks for an approval wait", async () => {
		let providerRan = false;
		const runtime = createRuntime({
			model: {
				...textOnlyModel("done"),
				doGenerate: async () => {
					providerRan = true;
					return {
						content: [{ type: "text", text: "done" }],
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
			plugins: [
				{
					id: "model-approval-policy",
					boundaryGates: [
						{
							id: "approve-model-egress",
							matcher: (call) => call.boundary === "model",
							handler: () => ({
								decision: "needs-approval",
								reason: "provider egress requires approval",
							}),
						},
					],
				},
			],
		});

		await expect(runtime.generate("hello")).rejects.toThrow(
			/model boundary approval waits are unsupported/,
		);
		expect(providerRan).toBe(false);
	});

	it("does not rehydrate final model text outside a trusted boundary", async () => {
		const runtime = createRuntime({
			model: {
				specificationVersion: "v4",
				provider: "mock",
				modelId: "mock",
				supportedUrls: {},
				doGenerate: async (options) => {
					const promptText = JSON.stringify(options.prompt);
					const token =
						promptText.match(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/)?.[0] ?? "NOTOKEN";
					return {
						content: [{ type: "text", text: `final ${token}` }],
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
				doStream: async () => {
					throw new Error("stream not used");
				},
			},
			redactor: createMemoryRedactor(emailDetector),
		});

		const result = await runtime.generate("email alice@personal.com");

		expect(result.text).toMatch(/final \{\{pii:[a-z]+:[a-z0-9-]+\}\}/);
		expect(result.text).not.toContain("alice@personal.com");
	});

	it("fails closed when a model step returns multiple tool calls", async () => {
		const runtime = createRuntime({
			model: {
				specificationVersion: "v4",
				provider: "mock",
				modelId: "mock",
				supportedUrls: {},
				doGenerate: async () => ({
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "a",
							input: JSON.stringify({}),
						},
						{
							type: "tool-call",
							toolCallId: "c2",
							toolName: "b",
							input: JSON.stringify({}),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
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
				}),
				doStream: async () => {
					throw new Error("stream not used");
				},
			},
			tools: {
				a: tool({
					description: "A.",
					inputSchema: jsonSchema({ type: "object" }),
					execute: async () => ({}),
				}),
				b: tool({
					description: "B.",
					inputSchema: jsonSchema({ type: "object" }),
					execute: async () => ({}),
				}),
			},
		});

		await expect(runtime.generate("do both")).rejects.toThrow(/one tool call/);
	});

	it("persists needs-approval calls and resumes the approved tool once", async () => {
		let toolRan: string | undefined;
		let toolRuns = 0;
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async ({ to }) => {
							toolRuns++;
							toolRan = to;
							return { sent: true };
						},
					}),
					{
						gate: () => ({
							decision: "needs-approval",
							reasonCode: "OVERSIGHT_REQUIRED",
						}),
					},
				),
			},
		});

		const waiting = await runtime.generate("email alice@personal.com the offer");
		expect(waiting.status).toBe("waiting_approval");
		if (waiting.status !== "waiting_approval") {
			throw new Error("expected runtime to wait for approval");
		}
		expect(waiting.approvalIds).toHaveLength(1);
		expect(toolRan).toBeUndefined();
		const pending =
			(await runtime.approvals?.list({ status: "pending" })) ?? [];
		expect(pending).toHaveLength(1);
		const [approval] = pending;
		if (!approval) throw new Error("missing approval");
		expect(approval.metadata).toMatchObject({
			version: "runtime.ai-sdk.v1",
			toolCallId: "c1",
			toolName: "send_email",
		});

		await runtime.approvals?.grant(approval.id, userPrincipal("alice"));
		const result = await runtime.continueRun(approval.id);

		expect(result?.status).toBe("completed");
		expect(result?.text).toBe("done");
		expect(toolRan).toBe("alice@personal.com");
		expect(toolRuns).toBe(1);
		expect((await runtime.approvals?.get(approval.id))?.status).toBe(
			"consumed",
		);
		expect(
			(await runtime.effects?.get(`approval:${approval.id}:tool:c1`))?.status,
		).toBe("completed");

		const retry = await runtime.continueRun(approval.id);
		expect(retry?.status).toBe("completed");
		expect(retry?.text).toBe("done");
		expect(toolRuns).toBe(1);
	});

	it("does not execute a consumed approval again while its effect is in progress", async () => {
		let toolRuns = 0;
		let releaseTool: () => void = () => {};
		const toolStarted = new Promise<void>((resolveStarted) => {
			releaseTool = resolveStarted;
		});
		let unblockTool: () => void = () => {};
		const toolBlocked = new Promise<void>((resolveBlocked) => {
			unblockTool = resolveBlocked;
		});
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async () => {
							toolRuns++;
							releaseTool();
							await toolBlocked;
							return { sent: true };
						},
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
					},
				),
			},
		});

		const waiting = await runtime.generate("email alice@personal.com the offer");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected runtime to wait for approval");
		}
		const approvalId = waiting.approvalIds[0];
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));

		const firstResume = runtime.continueRun(approvalId);
		await toolStarted;

		await expect(runtime.continueRun(approvalId)).rejects.toThrow(
			/effect is already in progress/,
		);
		expect(toolRuns).toBe(1);

		unblockTool();
		expect((await firstResume)?.status).toBe("completed");
		expect(toolRuns).toBe(1);
	});

	it('does not retry an expired effect for idempotency: "none" tools', async () => {
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
						id: input.id,
						status: "started",
						toolName: input.toolName,
						inputHash: input.inputHash,
						leaseExpiresAt: "2026-01-01T00:00:01.000Z",
						createdAt: input.now,
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
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			effectStore,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async () => {
							toolRuns++;
							return { sent: true };
						},
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
						effect: { idempotency: "none" },
					},
				),
			},
		});

		const waiting = await runtime.generate("email alice@personal.com the offer");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected runtime to wait for approval");
		}
		const approvalId = waiting.approvalIds[0];
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));

		await expect(runtime.continueRun(approvalId)).rejects.toThrow(
			/unknown and cannot be retried without idempotency/,
		);
		expect(reclaimExpired).toBe(false);
		expect(toolRuns).toBe(0);
	});

	it("redacts persisted effect output by default", async () => {
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async ({ to }) => ({ sent: true, recipient: to }),
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
					},
				),
			},
		});

		const waiting = await runtime.generate("email alice@personal.com the offer");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected runtime to wait for approval");
		}
		const approvalId = waiting.approvalIds[0];
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));
		await runtime.continueRun(approvalId);

		const effect = await runtime.effects?.get(`approval:${approvalId}:tool:c1`);
		expect(effect?.output).toMatchObject({ sent: true });
		expect(JSON.stringify(effect?.output)).toMatch(
			/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/,
		);
		expect(JSON.stringify(effect?.output)).not.toContain("alice@personal.com");
	});

	it("fails closed when redacted effect output has no redactor", async () => {
		let toolRuns = 0;
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			effectStore: createEffectStore(memoryAdapter()),
			tools: {
				send_email: tool({
					description: "Send an email.",
					inputSchema: jsonSchema<{ to: string }>({
						type: "object",
						properties: { to: { type: "string" } },
						required: ["to"],
					}),
					execute: async () => {
						toolRuns++;
						return { sent: true };
					},
				}),
			},
		});

		await expect(runtime.generate("email alice@personal.com")).rejects.toThrow(
			/redacted effect output requires a redactor/,
		);
		expect(toolRuns).toBe(0);
	});

	it("persists full effect output only when requested", async () => {
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async ({ to }) => ({ sent: true, recipient: to }),
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
						effect: { output: "full" },
					},
				),
			},
		});

		const waiting = await runtime.generate("email alice@personal.com the offer");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected runtime to wait for approval");
		}
		const approvalId = waiting.approvalIds[0];
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));
		await runtime.continueRun(approvalId);

		const effect = await runtime.effects?.get(`approval:${approvalId}:tool:c1`);
		expect(effect?.output).toEqual({
			sent: true,
			recipient: "alice@personal.com",
		});
	});

	it('does not persist effect output by default for idempotency: "none" tools', async () => {
		let toolRuns = 0;
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async ({ to }) => {
							toolRuns++;
							return { sent: true, recipient: to };
						},
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
						effect: { idempotency: "none" },
					},
				),
			},
		});

		const waiting = await runtime.generate("email alice@personal.com the offer");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected runtime to wait for approval");
		}
		const approvalId = waiting.approvalIds[0];
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));
		expect((await runtime.continueRun(approvalId))?.status).toBe("completed");
		expect(toolRuns).toBe(1);

		const effect = await runtime.effects?.get(`approval:${approvalId}:tool:c1`);
		expect(effect?.status).toBe("completed");
		expect(effect?.output).toBeUndefined();

		await expect(runtime.continueRun(approvalId)).rejects.toThrow(
			/completed effect output is unavailable/,
		);
		expect(toolRuns).toBe(1);
	});

	it("stamps runMode into the gate context — interactive from options, autonomous by default", async () => {
		const seen: unknown[] = [];
		// A gate observes the resolved context — it sees the runtime-stamped euroclaw__runMode.
		const capture: EuroclawPlugin = {
			id: "capture-runmode",
			gates: [
				{
					id: "capture",
					matcher: (call) => call.name === "send_email",
					handler: (_call, ctx) => {
						seen.push(ctx[RUN_MODE_CONTEXT_KEY]);
						return { decision: "permit" };
					},
				},
			],
		};
		const makeRuntime = () =>
			createRuntime({
				model: scriptedModel({ prompt: "" }),
				plugins: [capture],
				tools: {
					send_email: tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async () => ({ sent: true }),
					}),
				},
			});
		await makeRuntime().generate("do it", undefined, { runMode: "interactive" });
		await makeRuntime().generate("do it"); // no runMode → fail-closed default
		expect(seen).toEqual(["interactive", "autonomous"]);
	});

	it("emits model.completed once per step with usage, unified finishReason, and durationMs", async () => {
		const events: RuntimeEvent[] = [];
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			events: { emit: (event) => events.push(event) },
			tools: {
				send_email: tool({
					description: "Send an email.",
					inputSchema: jsonSchema<{ to: string }>({
						type: "object",
						properties: { to: { type: "string" } },
						required: ["to"],
					}),
					execute: async () => ({ sent: true }),
				}),
			},
		});

		await runtime.generate("email the offer");

		const modelEvents = events.filter(
			(event) => event.type === "model.completed",
		);
		expect(modelEvents).toHaveLength(2);
		// The fixture reports inputTokens.total=1 / outputTokens.total=1 per call; the SDK
		// normalizes totalTokens to their sum.
		expect(modelEvents[0]).toMatchObject({
			finishReason: "tool-calls",
			step: 0,
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});
		expect(modelEvents[1]).toMatchObject({
			finishReason: "stop",
			step: 1,
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});
		for (const event of modelEvents) {
			if (event.type !== "model.completed") continue;
			expect(event.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("emits model.failed with a redacted error, then the model failure propagates", async () => {
		const events: RuntimeEvent[] = [];
		const failingModel: V2Model = {
			specificationVersion: "v4",
			provider: "mock",
			modelId: "mock",
			supportedUrls: {},
			doGenerate: async () => {
				throw new Error("provider rejected prompt for alice@personal.com");
			},
			doStream: async () => {
				throw new Error("stream not used");
			},
		};
		const runtime = createRuntime({
			model: failingModel,
			redactor: createMemoryRedactor(emailDetector),
			events: { emit: (event) => events.push(event) },
		});

		await expect(runtime.generate("hello")).rejects.toThrow(/provider rejected/);

		const failed = events.find((event) => event.type === "model.failed");
		if (failed?.type !== "model.failed") {
			throw new Error("expected model.failed event");
		}
		expect(failed.step).toBe(0);
		expect(failed.durationMs).toBeGreaterThanOrEqual(0);
		expect(failed.error.name).toBe("Error");
		expect(failed.error.message).not.toContain("alice@personal.com");
		expect(failed.error.message).toMatch(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/);
	});

	it("stamps durationMs on tool.completed on the loop path", async () => {
		const events: RuntimeEvent[] = [];
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			events: { emit: (event) => events.push(event) },
			tools: {
				send_email: tool({
					description: "Send an email.",
					inputSchema: jsonSchema<{ to: string }>({
						type: "object",
						properties: { to: { type: "string" } },
						required: ["to"],
					}),
					execute: async () => ({ sent: true }),
				}),
			},
		});

		await runtime.generate("email the offer");

		const completed = events.find((event) => event.type === "tool.completed");
		if (completed?.type !== "tool.completed") {
			throw new Error("expected tool.completed event");
		}
		expect(typeof completed.durationMs).toBe("number");
		expect(completed.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("stamps durationMs on tool.completed on the approval-resume path", async () => {
		const events: RuntimeEvent[] = [];
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			events: { emit: (event) => events.push(event) },
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: jsonSchema<{ to: string }>({
							type: "object",
							properties: { to: { type: "string" } },
							required: ["to"],
						}),
						execute: async () => ({ sent: true }),
					}),
					{
						gate: () => ({ decision: "needs-approval" }),
					},
				),
			},
		});

		const waiting = await runtime.generate("email alice@personal.com the offer");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected runtime to wait for approval");
		}
		const approvalId = waiting.approvalIds[0];
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));
		const result = await runtime.continueRun(approvalId);
		expect(result?.status).toBe("completed");

		// The only tool.completed comes from the resume path — the loop parked before executing.
		const completed = events.find((event) => event.type === "tool.completed");
		if (completed?.type !== "tool.completed") {
			throw new Error("expected tool.completed event");
		}
		expect(typeof completed.durationMs).toBe("number");
		expect(completed.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("run.completed carries the field-wise usage sum across the run's model calls", async () => {
		const events: RuntimeEvent[] = [];
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			events: { emit: (event) => events.push(event) },
			tools: {
				send_email: tool({
					description: "Send an email.",
					inputSchema: jsonSchema<{ to: string }>({
						type: "object",
						properties: { to: { type: "string" } },
						required: ["to"],
					}),
					execute: async () => ({ sent: true }),
				}),
			},
		});

		await runtime.generate("email the offer");

		const completed = events.find((event) => event.type === "run.completed");
		if (completed?.type !== "run.completed") {
			throw new Error("expected run.completed event");
		}
		// Two model calls at 1 input / 1 output / 2 total each; unreported detail counts stay
		// unreported (undefined), never fabricated as zero.
		expect(completed.usage).toEqual({
			inputTokens: 2,
			inputTokenDetails: {},
			outputTokens: 2,
			outputTokenDetails: {},
			totalTokens: 4,
		});
	});
});
