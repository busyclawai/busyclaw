import type {
	Detector,
	EffectStore,
	EuroclawPlugin,
	HandleResult,
	PiiSpan,
} from "@euroclaw/contracts";
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
	NESTED_APPROVAL_UNSUPPORTED,
	NESTED_INVOKER_TOOL,
	type SubInvoke,
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

// Step 0 emits one tool call to `toolName`; step 1 finishes with "done".
function callToolOnceModel(
	toolName: string,
	args: Record<string, unknown>,
): V2Model {
	let step = 0;
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
			if (step++ === 0) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName,
							input: JSON.stringify(args),
						},
					],
					finishReason: "tool-calls",
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: "stop",
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

const emailInputSchema = jsonSchema<{ to: string }>({
	type: "object",
	properties: { to: { type: "string" } },
	required: ["to"],
});

// The runtime hands `subInvoke` to an invoker-stamped tool via a key on its execute options.
type NestedExecuteOptions = { subInvoke?: SubInvoke };

// An invoker-stamped capability tool whose execute drives `subInvoke`.
function invokerTool(run: (subInvoke: SubInvoke) => Promise<unknown>) {
	return govern(
		tool({
			description: "Capability tool.",
			inputSchema: jsonSchema({ type: "object" }),
			execute: async (_input, options) => {
				const { subInvoke } = options as unknown as NestedExecuteOptions;
				if (!subInvoke) {
					throw new Error("invoker tool did not receive subInvoke");
				}
				return run(subInvoke);
			},
		}),
		{ invoker: true },
	);
}

describe("@euroclaw/runtime subInvoke", () => {
	it("governs a nested tool call end-to-end and audits both the parent and the nested call", async () => {
		let nested: HandleResult | undefined;
		const denyEmail: EuroclawPlugin = {
			id: "deny-email",
			gates: [
				{
					id: "deny-send-email",
					matcher: (call) => call.name === "send_email",
					handler: () => ({ decision: "deny", reason: "blocked by policy" }),
				},
			],
		};
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			audit: createMemoryAudit(),
			plugins: [denyEmail],
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nested = await subInvoke("send_email", { to: "a@x.com" });
					return { handled: true };
				}),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async () => ({ sent: true }),
				}),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			gateId: "deny-send-email",
		});
		const auditNames = (runtime.audit?.entries() ?? []).map((e) => e.name);
		expect(auditNames).toContain("run_code");
		expect(auditNames).toContain("send_email");
	});

	it("redacts nested args in the audit yet rehydrates them inside the nested tool", async () => {
		let nestedToolSaw = "";
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			audit: createMemoryAudit(),
			redactor: createMemoryRedactor(emailDetector),
			tools: {
				run_code: invokerTool((subInvoke) =>
					subInvoke("send_email", { to: "alice@personal.com" }),
				),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async ({ to }) => {
						nestedToolSaw = to;
						return { sent: true };
					},
				}),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(nestedToolSaw).toBe("alice@personal.com");
		const auditJson = JSON.stringify(runtime.audit?.entries() ?? []);
		expect(auditJson).not.toContain("alice@personal.com");
		expect(auditJson).toMatch(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/);
	});

	it("makes two nested calls without an effect collision — only the parent claims an effect", async () => {
		const claimedIds: string[] = [];
		const base = createEffectStore(memoryAdapter());
		const effectStore: EffectStore = {
			...base,
			claim: async (input) => {
				claimedIds.push(input.id);
				return base.claim(input);
			},
		};
		const nestedOutputs: HandleResult[] = [];
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			effectStore,
			tools: {
				run_code: govern(
					tool({
						description: "Capability tool.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async (_input, options) => {
							const { subInvoke } = options as unknown as NestedExecuteOptions;
							if (!subInvoke) throw new Error("missing subInvoke");
							nestedOutputs.push(await subInvoke("echo", { v: "a" }));
							nestedOutputs.push(await subInvoke("echo", { v: "b" }));
							return { ok: true };
						},
					}),
					{ invoker: true, effect: { output: "none" } },
				),
				echo: tool({
					description: "Echo.",
					inputSchema: jsonSchema<{ v: string }>({
						type: "object",
						properties: { v: { type: "string" } },
						required: ["v"],
					}),
					execute: async ({ v }) => ({ v }),
				}),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(claimedIds).toHaveLength(1);
		expect(nestedOutputs[0]).toMatchObject({
			status: "ok",
			output: { v: "a" },
		});
		expect(nestedOutputs[1]).toMatchObject({
			status: "ok",
			output: { v: "b" },
		});
	});

	it("fails a nested needs-approval closed as a denied value and parks nothing", async () => {
		let nested: HandleResult | undefined;
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nested = await subInvoke("send_email", { to: "a@x.com" });
					return { nested };
				}),
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: emailInputSchema,
						execute: async () => ({ sent: true }),
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			reasonCode: NESTED_APPROVAL_UNSUPPORTED,
		});
		const pending =
			(await runtime.approvals?.list({ status: "pending" })) ?? [];
		expect(pending).toHaveLength(0);
	});

	it("runs concurrent nested calls without cross-contaminating outputs", async () => {
		const results: HandleResult[] = [];
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			audit: createMemoryAudit(),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					const [a, b] = await Promise.all([
						subInvoke("echo", { v: "a" }),
						subInvoke("echo", { v: "b" }),
					]);
					results.push(a, b);
					return { a, b };
				}),
				echo: tool({
					description: "Echo.",
					inputSchema: jsonSchema<{ v: string }>({
						type: "object",
						properties: { v: { type: "string" } },
						required: ["v"],
					}),
					execute: async ({ v }) => ({ v }),
				}),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(results[0]).toMatchObject({ status: "ok", output: { v: "a" } });
		expect(results[1]).toMatchObject({ status: "ok", output: { v: "b" } });
		const echoAudits = (runtime.audit?.entries() ?? []).filter(
			(e) => e.name === "echo",
		);
		expect(echoAudits).toHaveLength(2);
	});

	it("denies invoking an invoker-stamped tool from a nested call", async () => {
		let nested: HandleResult | undefined;
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nested = await subInvoke("other_capability", {});
					return { nested };
				}),
				other_capability: govern(
					tool({
						description: "Another capability tool.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async () => ({ ran: true }),
					}),
					{ invoker: true },
				),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			gateId: "runtime:nested-invoke",
			reasonCode: NESTED_INVOKER_TOOL,
		});
	});

	it("does not hand subInvoke to a tool without invoker", async () => {
		let sawSubInvokeKey: boolean | undefined;
		const runtime = createRuntime({
			model: callToolOnceModel("plain", {}),
			tools: {
				plain: tool({
					description: "Plain tool.",
					inputSchema: jsonSchema({ type: "object" }),
					execute: async (_input, options) => {
						sawSubInvokeKey = "subInvoke" in (options as object);
						return { ok: true };
					},
				}),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(sawSubInvokeKey).toBe(false);
	});

	it("applies a per-tool govern() gate to a nested call", async () => {
		let nested: HandleResult | undefined;
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nested = await subInvoke("send_email", { to: "a@x.com" });
					return { handled: true };
				}),
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: emailInputSchema,
						execute: async () => ({ sent: true }),
					}),
					{ gate: () => ({ decision: "deny", reason: "per-tool deny" }) },
				),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			gateId: "tool:send_email",
		});
	});

	it("applies a govern() gate to a nested call on a PER-RUN (resolveTools) tool", async () => {
		// Regression: the nested core must register gates from the RESOLVED tool set it executes
		// from (runTools), not the static `tools`. A gated tool supplied per-run via resolveTools
		// and reached through subInvoke would otherwise run UNGATED on the nested core — a gate
		// bypass. Distinguished from the test above by placing the gated tool in resolveTools.
		let nested: HandleResult | undefined;
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nested = await subInvoke("send_email", { to: "a@x.com" });
					return { handled: true };
				}),
			},
			resolveTools: () => ({
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: emailInputSchema,
						execute: async () => ({ sent: true }),
					}),
					{ gate: () => ({ decision: "deny", reason: "per-tool deny" }) },
				),
			}),
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			gateId: "tool:send_email",
		});
	});
});
