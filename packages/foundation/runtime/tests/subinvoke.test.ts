import type {
	BusyclawPlugin,
	Detector,
	EffectStore,
	HandleResult,
	PiiSpan,
} from "@busyclaw/contracts";
import {
	createMemoryAudit,
	createMemoryRedactor,
	createStoredRedactor,
} from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import {
	createEffectStore,
	createPiiMappingStore,
} from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
	createRuntime,
	govern,
	NESTED_APPROVAL_UNSUPPORTED,
	NESTED_EFFECT_UNSUPPORTED,
	NESTED_INVOKER_TOOL,
	type SubInvoke,
} from "../src/index";
import { durableStores } from "./durable-stores";

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
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
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
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName,
							input: JSON.stringify(args),
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

describe("@busyclaw/runtime subInvoke", () => {
	it("governs a nested tool call end-to-end and audits both the parent and the nested call", async () => {
		let nested: HandleResult | undefined;
		const denyEmail = {
			id: "deny-email",
			gates: [
				{
					id: "deny-send-email",
					matcher: (call) => call.name === "send_email",
					handler: () => ({ decision: "deny", reason: "blocked by policy" }),
				},
			],
		} satisfies BusyclawPlugin;
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			audit: createMemoryAudit(),
			plugins: [denyEmail],
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
					{},
				),
			},
		});

		const result = await runtime.generate("do it");

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
				send_email: govern(
					tool({
						description: "Send an email.",
						inputSchema: emailInputSchema,
						execute: async ({ to }) => {
							nestedToolSaw = to;
							return { sent: true };
						},
					}),
					{},
				),
			},
		});

		const result = await runtime.generate("do it");

		expect(result.status).toBe("completed");
		expect(nestedToolSaw).toBe("alice@personal.com");
		const auditJson = JSON.stringify(runtime.audit?.entries() ?? []);
		expect(auditJson).not.toContain("alice@personal.com");
		expect(auditJson).toMatch(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/);
	});

	// The OUTPUT direction, which had no coverage at all until this was written: a mutation disabling
	// nested re-redaction broke nothing anywhere in the repo.
	//
	// The caller here is untrusted BRAIN — model-authored code inside an invoker tool — so what a leaf
	// tool returns must be redacted again before it crosses back, exactly as the args were on the way
	// in. Without it, a nested tool is a laundering path: the parent asks for something the model may
	// not see, and receives it in the clear because the redaction only ever ran at the outer boundary.
	// This matters more since a governed fetch became a nested call, because then the value crossing
	// back is a THIRD PARTY'S response.
	it("re-redacts what a nested tool RETURNS, before the caller sees it", async () => {
		let nestedSaw: unknown;
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			audit: createMemoryAudit(),
			redactor: createMemoryRedactor(emailDetector),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nestedSaw = await subInvoke("lookup", {});
					return { done: true };
				}),
				lookup: govern(
					tool({
						description: "Return a record.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						// A third party's payload, from the caller's point of view.
						execute: async () => ({ email: "bob@personal.com" }),
					}),
					{},
				),
			},
		});

		const result = await runtime.generate("do it");
		expect(result.status).toBe("completed");
		// The nested caller got a placeholder, not the address.
		const seen = JSON.stringify(nestedSaw);
		expect(seen).not.toContain("bob@personal.com");
		expect(seen).toMatch(/\{\{pii:[a-z]+:[a-z0-9-]+\}\}/);
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
				echo: govern(
					tool({
						description: "Echo.",
						inputSchema: jsonSchema<{ v: string }>({
							type: "object",
							properties: { v: { type: "string" } },
							required: ["v"],
						}),
						execute: async ({ v }) => ({ v }),
					}),
					{},
				),
			},
		});

		const result = await runtime.generate("do it");

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
			...durableStores(db),
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

		const result = await runtime.generate("do it");

		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			reasonCode: NESTED_APPROVAL_UNSUPPORTED,
		});
		const pending =
			(await runtime.approvals?.list({ status: "pending" })) ?? [];
		expect(pending).toHaveLength(0);
	});

	it("hands the guest the MODEL's annotations and drops the host's — this value is read by model code", async () => {
		// The least obvious model-facing door: what subInvoke returns round-trips into the sandbox as
		// JSON, and the script reading it was written by the model. So the same wall the transcript has
		// applies here — and the model-audience half survives the park→deny conversion, because "you
		// cannot do this here, do X instead" is precisely what its author wrote it for.
		const nested: HandleResult[] = [];
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nested.push(await subInvoke("parks", {}));
					nested.push(await subInvoke("refuses", {}));
					return { ok: true };
				}),
				parks: govern(
					tool({
						description: "Parks.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						execute: async () => ({ done: true }),
					}),
					{
						gate: () => ({
							decision: "needs-approval",
							annotations: { escalate: "betterauth:team_eng" },
							modelAnnotations: { guidance: "ask a release manager" },
						}),
					},
				),
				refuses: govern(
					tool({
						description: "Refuses.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						execute: async () => ({ done: true }),
					}),
					{
						gate: () => ({
							decision: "deny",
							reason: "no",
							annotations: { escalate: "betterauth:team_eng" },
							modelAnnotations: { guidance: "try the read-only endpoint" },
						}),
					},
				),
			},
		});

		expect((await runtime.generate("do it")).status).toBe("completed");
		expect(nested).toHaveLength(2);
		for (const outcome of nested) {
			expect(outcome).toMatchObject({ status: "denied" });
			expect(outcome).not.toHaveProperty("annotations");
			expect(JSON.stringify(outcome)).not.toContain("betterauth:team_eng");
		}
		expect(nested[0]).toMatchObject({
			modelAnnotations: { guidance: "ask a release manager" },
		});
		expect(nested[1]).toMatchObject({
			modelAnnotations: { guidance: "try the read-only endpoint" },
		});
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
				echo: govern(
					tool({
						description: "Echo.",
						inputSchema: jsonSchema<{ v: string }>({
							type: "object",
							properties: { v: { type: "string" } },
							required: ["v"],
						}),
						execute: async ({ v }) => ({ v }),
					}),
					{},
				),
			},
		});

		const result = await runtime.generate("do it");

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

		const result = await runtime.generate("do it");

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
				plain: govern(
					tool({
						description: "Plain tool.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async (_input, options) => {
							sawSubInvokeKey = "subInvoke" in (options as object);
							return { ok: true };
						},
					}),
					{},
				),
			},
		});

		const result = await runtime.generate("do it");

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

		const result = await runtime.generate("do it");

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

		const result = await runtime.generate("do it");

		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			gateId: "tool:send_email",
		});
	});

	// H-09's third half. A nested call never reaches the effect ledger — the nested core has none, and
	// a deterministic child id cannot be derived honestly from model-authored code that may not replay
	// the same calls in the same order. So a tool that declares it cannot run twice is refused rather
	// than run unledgered, where a parent retry would repeat it in silence.
	it("refuses a required-idempotency tool from nested execution, as a denied value", async () => {
		let nested: HandleResult | undefined;
		let toolRuns = 0;
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			...durableStores(db),
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					nested = await subInvoke("charge_card", {});
					return { nested };
				}),
				charge_card: govern(
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

		const result = await runtime.generate("do it");

		// A VALUE, not a throw — the guest reads it and can react, the same door the nested
		// needs-approval conversion uses. The run itself completes.
		expect(result.status).toBe("completed");
		expect(nested).toMatchObject({
			status: "denied",
			reasonCode: NESTED_EFFECT_UNSUPPORTED,
		});
		expect(toolRuns).toBe(0);
	});

	it("lets a nested call through when a duplicate is survivable", async () => {
		let toolRuns = 0;
		const db = memoryAdapter();
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {}),
			...durableStores(db),
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
			}),
			tools: {
				run_code: invokerTool(async (subInvoke) => {
					await subInvoke("ping", {});
					return { ok: true };
				}),
				ping: govern(
					tool({
						description: "Ping.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						execute: async () => {
							toolRuns++;
							return { pong: true };
						},
					}),
					{ effect: { kind: "external", idempotency: "optional" } },
				),
			},
		});

		expect((await runtime.generate("do it")).status).toBe("completed");
		expect(toolRuns).toBe(1);
	});
});
