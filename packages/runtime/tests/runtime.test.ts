import type {
	BusyclawPlugin,
	Detector,
	EffectStore,
	Event,
	PiiSpan,
} from "@busyclaw/contracts";
import { RUN_MODE_CONTEXT_KEY, userPrincipal } from "@busyclaw/contracts";
import {
	createMemoryAudit,
	createMemoryRedactor,
	createStoredRedactor,
} from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import {
	createApprovalStore,
	createEffectStore,
	createPiiMappingStore,
} from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { governanceToolResult } from "../src/ai-sdk-loop";
import {
	createRuntime,
	govern,
	type RuntimeEvent,
	type RuntimeResult,
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

/** `onGenerate` fires when the provider is actually reached — the hook belongs here rather than in a
 *  spread-and-override at the call site, where the V2|V3|V4 union leaves `doGenerate` with no single
 *  signature to write. */
function textOnlyModel(text: string, onGenerate?: () => void): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			...(onGenerate?.(), {}),
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

describe("@busyclaw/runtime", () => {
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
				send_email: govern(
					tool({
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
					{},
				),
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

		await expect(runtime.generate("hello")).rejects.toThrow(
			/audit unavailable/,
		);
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
				async emit(event: RuntimeEvent) {
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
					emit(event: RuntimeEvent) {
						if (event.type === "run.completed") {
							throw new Error("observer sink unavailable");
						}
					},
				},
				{
					emit(event: RuntimeEvent) {
						seenAfter.push(event.type);
					},
				},
			],
			warn: (message: string) => void warnings.push(message),
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
				emit(event: RuntimeEvent) {
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
			events: { emit: (event) => void events.push(event) },
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
						execute: async ({ to }): Promise<{ sent: boolean }> => {
							throw new Error(`cannot email ${to}`);
						},
					}),
					{},
				),
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
			events: { emit: (event) => void events.push(event) },
		}).generate("hello", { busyclaw__recording: { clawId: "claw-1" } });

		expect(result.status).toBe("completed");
		expect(events.every((event) => event.recording === undefined)).toBe(true);
	});

	it("emits waiting approval events", async () => {
		const events: RuntimeEvent[] = [];
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			events: { emit: (event) => void events.push(event) },
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
		const model = textOnlyModel("done", () => {
			providerRan = true;
		});
		const runtime = createRuntime({
			model,
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
				a: govern(
					tool({
						description: "A.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async () => ({}),
					}),
					{},
				),
				b: govern(
					tool({
						description: "B.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async () => ({}),
					}),
					{},
				),
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

		const waiting = await runtime.generate(
			"email alice@personal.com the offer",
		);
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
			"completed",
		);
		expect(
			(await runtime.effects?.get(`approval:${approval.id}:tool:c1`))?.status,
		).toBe("completed");

		// A finished approval is ANSWERED — the stored result comes back verbatim and no model loop
		// runs. This used to re-enter the loop and only avoid a second tool call because the effect
		// ledger deduped it, which put the whole guarantee on a ledger that fails open elsewhere.
		const retry = await runtime.continueRun(approval.id);
		expect(retry).toEqual(result);
		expect(toolRuns).toBe(1);
		// …and the approval stays finished; a served answer changes nothing.
		expect((await runtime.approvals?.get(approval.id))?.status).toBe(
			"completed",
		);
	});

	it("refuses a second resume while the first still holds the lease", async () => {
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

		const waiting = await runtime.generate(
			"email alice@personal.com the offer",
		);
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected runtime to wait for approval");
		}
		const approvalId = waiting.approvalIds[0];
		await runtime.approvals?.grant(approvalId, userPrincipal("alice"));

		const firstResume = runtime.continueRun(approvalId);
		await toolStarted;

		// The APPROVAL lease refuses the second resume outright — earlier and stronger than the effect
		// ledger noticing a duplicate afterwards, because nothing re-enters the model loop at all.
		expect(await runtime.continueRun(approvalId)).toBeNull();
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
						// Echoed back from what the runtime stamped, which is the point: the anchors reach
						// the store from the RUN's own authority, so a stub that invented them would be
						// asserting its own values rather than the ones under test.
						...input.anchors,
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

		const waiting = await runtime.generate(
			"email alice@personal.com the offer",
		);
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

		const waiting = await runtime.generate(
			"email alice@personal.com the offer",
		);
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
					{},
				),
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

		const waiting = await runtime.generate(
			"email alice@personal.com the offer",
		);
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

		const waiting = await runtime.generate(
			"email alice@personal.com the offer",
		);
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

		// A second resume no longer needs the effect ledger to reconstruct anything: the approval stores
		// what it produced, so it is answered from there. This used to throw "completed effect output is
		// unavailable" — a replay running into a ledger that deliberately kept no output for a
		// `none`-idempotency tool, which is a failure mode the replay itself created.
		const retry = await runtime.continueRun(approvalId);
		expect(retry?.status).toBe("completed");
		expect(toolRuns).toBe(1);
	});

	it("stamps runMode into the gate context — interactive from options, autonomous by default", async () => {
		const seen: unknown[] = [];
		// A gate observes the resolved context — it sees the runtime-stamped busyclaw__runMode.
		const capture = {
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
		} satisfies BusyclawPlugin;
		const makeRuntime = () =>
			createRuntime({
				model: scriptedModel({ prompt: "" }),
				plugins: [capture],
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
						{},
					),
				},
			});
		await makeRuntime().generate("do it", undefined, {
			runMode: "interactive",
		});
		await makeRuntime().generate("do it"); // no runMode → fail-closed default
		expect(seen).toEqual(["interactive", "autonomous"]);
	});

	it("emits model.completed once per step with usage, unified finishReason, and durationMs", async () => {
		const events: RuntimeEvent[] = [];
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			events: { emit: (event) => void events.push(event) },
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
					{},
				),
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
			events: { emit: (event) => void events.push(event) },
		});

		await expect(runtime.generate("hello")).rejects.toThrow(
			/provider rejected/,
		);

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
			events: { emit: (event) => void events.push(event) },
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
					{},
				),
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
			events: { emit: (event) => void events.push(event) },
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

		const waiting = await runtime.generate(
			"email alice@personal.com the offer",
		);
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
			events: { emit: (event) => void events.push(event) },
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
					{},
				),
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

// The transcript payload a blocked call becomes — the one place author-written policy text is
// deliberately handed to the model, and the one place the host's own metadata must not be.
describe("governanceToolResult — what a blocked call tells the model", () => {
	const bags = {
		annotations: { escalate: "betterauth:team_eng" },
		modelAnnotations: { guidance: "ask a release manager" },
	};

	it("carries the model bag under `annotations` and leaves the host bag behind", () => {
		expect(
			governanceToolResult({
				status: "denied",
				gateId: "policy",
				reason: "no",
				reasonCode: "DENIED",
				demands: [{ gateId: "policy", reason: "no" }],
				...bags,
			}),
		).toEqual({
			__governance: "denied",
			reason: "no",
			reasonCode: "DENIED",
			// `annotations` from the MODEL's side of the wall — it never sees the other one, so the name
			// is complete from where it is read.
			annotations: { guidance: "ask a release manager" },
		});
	});

	it("does the same for a needs-approval, though no runtime path reaches it with one today", () => {
		// Worth pinning anyway: in the loop a park RETURNS (the run waits for a human) and on resume a
		// second park throws, so the live park→model doors are the disclosure and the nested invoke.
		// If a path ever hands a park to the model here, it must not start leaking the host's bag.
		expect(
			governanceToolResult({
				status: "needs-approval",
				gateId: "policy",
				reason: "approval required",
				demands: [{ gateId: "policy", reason: "approval required" }],
				...bags,
			}),
		).toMatchObject({
			__governance: "needs-approval",
			annotations: { guidance: "ask a release manager" },
		});
	});

	it("omits `annotations` entirely when the policy wrote nothing for the model", () => {
		const result = governanceToolResult({
			status: "denied",
			gateId: "policy",
			reason: "no",
			demands: [{ gateId: "policy", reason: "no" }],
			annotations: { escalate: "betterauth:team_eng" },
		});
		expect(result).not.toHaveProperty("annotations");
		expect(JSON.stringify(result)).not.toContain("betterauth:team_eng");
	});

	// A registered source can be re-registered while an approval sits pending. The ADDRESS survives
	// what it points at, so a resume would dispatch onto whatever the name means now — a different
	// path, schema or governance from the one the human read and agreed to.
	describe("an approved tool that changed underneath the approval", () => {
		const parkAndGrant = async (version: () => string) => {
			let toolRuns = 0;
			const db = memoryAdapter();
			const runtime = createRuntime({
				model: scriptedModel({ prompt: "" }),
				database: db,
				redactor: createStoredRedactor({
					detector: emailDetector,
					mappings: createPiiMappingStore(db),
				}),
				// Per-run resolution is what a data-backed tool set really is — resolved fresh on every
				// run, including the resume, which is exactly how the drift gets in.
				resolveTools: () => ({
					send_email: {
						...govern(
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
							{ gate: () => ({ decision: "needs-approval" }) },
						),
						contentVersion: version(),
					},
				}),
			});
			const waiting = await runtime.generate(
				"email alice@personal.com the offer",
			);
			if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
				throw new Error("expected runtime to wait for approval");
			}
			const approvalId = waiting.approvalIds[0];
			await runtime.approvals?.grant(approvalId, userPrincipal("alice"));
			return { runtime, approvalId, runs: () => toolRuns };
		};

		it("refuses the resume and does not run the tool", async () => {
			let version = "v1";
			const { runtime, approvalId, runs } = await parkAndGrant(() => version);
			// The spec is re-registered between the ask and the answer.
			version = "v2";
			await expect(runtime.continueRun(approvalId)).rejects.toThrow(
				/changed since it was approved/,
			);
			expect(runs()).toBe(0);
			// Not consumed by the refusal — the approval is still there to be re-decided, and the lease
			// was never taken, so nothing has to lapse before someone can act on it.
			expect((await runtime.approvals?.get(approvalId))?.status).toBe(
				"approved",
			);
		});

		it("resumes normally when the tool is unchanged", async () => {
			const { runtime, approvalId, runs } = await parkAndGrant(() => "v1");
			expect((await runtime.continueRun(approvalId))?.status).toBe("completed");
			expect(runs()).toBe(1);
		});
	});

	// H-09. `idempotency: "required"` is the strongest thing a tool can say about itself: this cannot
	// safely run twice. With no ledger there is nothing that could tell a retry from a first attempt,
	// and the paths that retry — crash recovery, approval resume, lease recovery — are exactly the ones
	// that would then double-charge.
	it("refuses a required-idempotency tool when the claw has no effect store", async () => {
		let toolRuns = 0;
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			// No database ⇒ no effect store. This used to execute anyway.
			tools: {
				// The scripted model calls `send_email`; the effect policy is what this is about.
				send_email: govern(
					tool({
						description: "Charge a card.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						execute: async () => {
							toolRuns++;
							return { charged: true };
						},
					}),
					{ effect: { kind: "external", idempotency: "required" } },
				),
			},
		});

		await expect(runtime.generate("email alice@personal.com")).rejects.toThrow(
			/requires idempotency but this claw has no effect store/,
		);
		expect(toolRuns).toBe(0);
	});

	it("still runs a tool that says a duplicate is survivable", async () => {
		let toolRuns = 0;
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			tools: {
				// The scripted model calls `send_email`; the effect policy is what this is about.
				send_email: govern(
					tool({
						description: "Charge a card.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						execute: async () => {
							toolRuns++;
							return { charged: true };
						},
					}),
					// `optional` is the tool saying it would PREFER a ledger, not that it needs one.
					{ effect: { kind: "external", idempotency: "optional" } },
				),
			},
		});

		expect((await runtime.generate("email alice@personal.com")).status).toBe(
			"completed",
		);
		expect(toolRuns).toBe(1);
	});

	it("hands the ledger's effect id to the tool, matching the row it claimed", async () => {
		let seenEffectId: unknown;
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
						execute: async (_args, options) => {
							seenEffectId = (options as { effectId?: unknown }).effectId;
							return { sent: true };
						},
					}),
					{ effect: { kind: "external", idempotency: "required" } },
				),
			},
		});

		expect(
			(await runtime.generate("email alice@personal.com the offer")).status,
		).toBe("completed");
		// The SAME id the ledger claimed — that is what makes it stable across a retry, and therefore
		// worth anything as a provider's idempotency key. A freshly minted one per attempt would be
		// indistinguishable from no key at all.
		expect(typeof seenEffectId).toBe("string");
		expect(await runtime.effects?.get(seenEffectId as string)).toMatchObject({
			status: "completed",
			toolName: "send_email",
		});
	});

	// H-06. An ad-hoc run has no claw, and that was read as "no container" — so EVERY contextless run
	// shared one namespace. Holding a placeholder minted by someone else's run was then enough to have
	// a tool hand you the value behind it, because the tool edge rehydrates and the namespace matched.
	it("does not rehydrate a placeholder minted by a different ad-hoc run", async () => {
		const db = memoryAdapter();
		const seen: string[] = [];
		const make = () =>
			createRuntime({
				model: scriptedModel({ prompt: "" }),
				database: db,
				redactor: createStoredRedactor({
					detector: emailDetector,
					// The SAME mapping store — the isolation has to come from the container, not from
					// two runtimes that simply cannot see each other's rows.
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
							execute: async (args) => {
								seen.push((args as { to: string }).to);
								return { sent: true };
							},
						}),
						{},
					),
				},
			});

		// Run one mints a placeholder for a real address, and its own tool edge rehydrates it.
		const first = { prompt: "" };
		const runtimeA = createRuntime({
			model: scriptedModel(first),
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
						execute: async (args) => {
							seen.push((args as { to: string }).to);
							return { sent: true };
						},
					}),
					{},
				),
			},
		});
		await runtimeA.generate("email alice@personal.com the offer");
		expect(seen[0]).toBe("alice@personal.com");
		const token = first.prompt.match(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/)?.[0];
		if (!token) throw new Error("expected run one to mint a placeholder");

		// Run two is a DIFFERENT ad-hoc run and presents the stolen token. It must come out the other
		// side as itself — an opaque string — never as the address behind it.
		await make().generate(`email ${token} the offer`);
		expect(seen[1]).toBe(token);
		expect(seen[1]).not.toBe("alice@personal.com");
	});

	// H-07. Ordinary message and tool redaction minted mappings linked to NO subject, because nothing
	// could stamp one: the context key is reserved (so a caller cannot supply it) and no resolver wrote
	// it. `forgetSubject` then answered successfully having found nothing — the worst possible
	// compliance reply, because it is indistinguishable from a completed erasure.
	describe("erasure reaches what ordinary redaction minted", () => {
		const build = (subject?: (ctx: Record<string, unknown>) => string) => {
			const db = memoryAdapter();
			const mappings = createPiiMappingStore(db);
			const runtime = createRuntime({
				model: scriptedModel({ prompt: "" }),
				database: db,
				redactor: createStoredRedactor({ detector: emailDetector, mappings }),
				...(subject !== undefined ? { subject } : {}),
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
						{},
					),
				},
			});
			return { runtime, mappings };
		};

		it("erases a mapping the normal flow minted when a subject resolver names one", async () => {
			const { runtime, mappings } = build(() => "person-7");
			await runtime.generate("email alice@personal.com the offer");

			// The junction exists because trusted code said whose data this is — busyclaw cannot infer
			// that from the value, so a deployment that owes anyone erasure has to say.
			expect(await mappings.deleteForSubject("person-7")).toBeGreaterThan(0);
			// And it is gone: a second erasure finds nothing left to shred.
			expect(await mappings.deleteForSubject("person-7")).toBe(0);
		});

		it("reports ZERO when nothing was ever linked — not a silent success", async () => {
			const { runtime, mappings } = build();
			await runtime.generate("email alice@personal.com the offer");
			// A mapping WAS minted; it simply belongs to no subject, so erasure cannot reach it. The
			// count is what makes that visible instead of reading as a completed shred.
			expect(await mappings.deleteForSubject("person-7")).toBe(0);
		});
	});
});

// R-H08 — a runner that LOST its lease has not succeeded.
//
// `complete(id, leaseId, result)` returns null when the lease has moved on: a recovery reclaimed the
// approval mid-run and owns the terminal answer now. The runtime used to ignore that null and hand
// the caller its own computed result anyway — the comment even said so ("the caller still gets the
// result it computed"). So one approval had two answers: the winner's, which is persisted and served
// to every later resume, and the loser's, which went to whoever happened to be holding this call.
// The caller had no way to tell which they had.
//
// It emitted a terminal run event too, before the completion was even attempted, so a run that lost
// announced an outcome that never counted.
describe("a superseded approval resume does not report success", () => {
	it("returns the WINNER's stored result, not its own", async () => {
		const db = memoryAdapter();
		let toolRuns = 0;
		const winners: RuntimeResult = {
			status: "completed",
			text: "the recovery's answer",
			steps: 1,
		};
		// The real sequence, not a shortcut: this runner starts on an APPROVED record, the recovery
		// finishes while it works, and the loss is discovered when its own `complete` is refused.
		const real = createApprovalStore(db);
		let superseded = false;
		const approvalStore = {
			...real,
			complete: async () => {
				superseded = true;
				return null;
			},
			get: async (id: string) => {
				const record = await real.get(id);
				if (record === null) return null;
				return superseded
					? { ...record, status: "completed" as const, result: winners }
					: record;
			},
		};

		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			approvalStore,
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
						execute: async (): Promise<{ sent: boolean }> => {
							toolRuns += 1;
							return { sent: true };
						},
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});
		const waiting = await runtime.generate("email alice@personal.com");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected an approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await approvalStore.grant(approvalId, userPrincipal("alice"));

		expect(await runtime.continueRun(approvalId)).toEqual(winners);
		expect(toolRuns).toBe(1);
	});

	it("announces no outcome for the run it lost", async () => {
		// The terminal event used to be emitted BEFORE the completion was even attempted, so a
		// superseded runner announced a result that never counted — and observers, transcripts and
		// anything else downstream took it at face value. Closing the lease first is what orders this.
		const db = memoryAdapter();
		const events: RuntimeEvent[] = [];
		const winners: RuntimeResult = {
			status: "completed",
			text: "the recovery's answer",
			steps: 1,
		};
		const real = createApprovalStore(db);
		let superseded = false;
		const approvalStore = {
			...real,
			complete: async () => {
				superseded = true;
				return null;
			},
			get: async (id: string) => {
				const record = await real.get(id);
				if (record === null) return null;
				return superseded
					? { ...record, status: "completed" as const, result: winners }
					: record;
			},
		};
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			approvalStore,
			events: { emit: (event: RuntimeEvent) => void events.push(event) },
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
						execute: async (): Promise<{ sent: boolean }> => ({ sent: true }),
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});
		const waiting = await runtime.generate("email alice@personal.com");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected an approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await approvalStore.grant(approvalId, userPrincipal("alice"));
		events.length = 0;

		await runtime.continueRun(approvalId);
		expect(
			events.filter((event) => event.type === "run.completed"),
		).toHaveLength(0);
	});
});

// R-H08 clause 3 — a resume says "still here" while it works, and stops when it is not.
//
// A resume took ONE fifteen-minute lease and never renewed it. A slow tool or model tail outlived it
// and a second runner reclaimed work that was never stuck — the race the completion check can only
// notice afterwards, by which point both runners have executed. The keepalive is the half that
// prevents it rather than reporting it.
describe("an approval lease is kept alive, and lost is stopped", () => {
	it("aborts the run when the store says the lease is gone", async () => {
		const db = memoryAdapter();
		let toolStarted = 0;
		let toolFinished = 0;
		const real = createApprovalStore(db);
		const approvalStore = {
			...real,
			// The lease has moved on. This is precisely what a reclaimed approval reports.
			heartbeat: async () => null,
		};
		const runtime = createRuntime({
			model: scriptedModel({ prompt: "" }),
			database: db,
			approvalStore,
			// Short enough that the keepalive fires while the tool is still running — the beat interval
			// is a third of the lease, so this makes the race observable in milliseconds instead of
			// waiting out fifteen minutes.
			approvalLeaseMs: 900,
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
						execute: async (): Promise<{ sent: boolean }> => {
							toolStarted += 1;
							await new Promise((resolve) => setTimeout(resolve, 800));
							toolFinished += 1;
							return { sent: true };
						},
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});
		const waiting = await runtime.generate("email alice@personal.com");
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected an approval wait");
		}
		const approvalId = waiting.approvalIds[0];
		await approvalStore.grant(approvalId, userPrincipal("alice"));

		await expect(runtime.continueRun(approvalId)).rejects.toThrow(
			/lost its lease mid-run/,
		);
		// It got as far as running the approved tool — the abort lands at the next boundary, not
		// mid-call — and then stopped instead of continuing into steps it no longer owned.
		expect(toolStarted).toBe(1);
		expect(toolFinished).toBe(1);
	}, 15_000);
});
