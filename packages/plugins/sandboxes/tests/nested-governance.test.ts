// Isolation hardening — NESTED GOVERNANCE: every tool call a sandboxed script makes stays governed.
// Provider-level (N1–N3) checks the sandbox→invoker bridge faithfully carries governance verdicts
// and never lets one call's outcome bleed into another. Runtime-level (N4–N5) checks the two
// fail-closed guards the nested-invoke design depends on: a script cannot re-enter a capability
// tool, and a nested needs-approval degrades to a denied value instead of parking a live isolate.

import { createMemoryAudit } from "@euroclaw/core";
import {
	createRuntime,
	govern,
	NESTED_APPROVAL_UNSUPPORTED,
	NESTED_INVOKER_TOOL,
} from "@euroclaw/runtime";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import type {
	ExecutionResult,
	Sandbox,
	SandboxInvokeInput,
	SandboxToolInvoker,
} from "../src/core/contracts";
import { executeInSandbox, runCodeTool } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

// Step 0 emits one tool call to `toolName`; step 1 finishes with "done". (subinvoke.test.ts fixture.)
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

// Observe-only sandbox wrapper: delegates to a real quickjs provider and records the last
// ExecutionResult, so a runtime-level test can inspect exactly what the guest returned (the value it
// observed from a nested call). It changes nothing about execution — pure instrumentation.
function recordingSandbox(): {
	sandbox: Sandbox;
	last: () => ExecutionResult | undefined;
} {
	const inner = quickjs();
	let captured: ExecutionResult | undefined;
	return {
		last: () => captured,
		sandbox: {
			provider: inner.provider,
			posture: inner.posture,
			validate: inner.validate,
			execute: async (input) => {
				const res = await inner.execute(input);
				captured = res.output;
				return res;
			},
		},
	};
}

describe("@euroclaw/sandboxes nested governance", () => {
	// N1 — a governed VALUE (denied, with gateId/reason/reasonCode) round-trips intact to the guest:
	// the bridge carries the governance verdict faithfully, so the script reasons on it. (Complements
	// escape E7, which checks the argument direction.)
	it("N1: a governed verdict round-trips intact to the guest", async () => {
		const invoker: SandboxToolInvoker = {
			invoke: async () => ({
				status: "denied",
				gateId: "g",
				reason: "no",
				reasonCode: "POLICY_X",
			}),
		};
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: "const r = await tools.x.y({}); return { status: r.status, gateId: r.gateId, reasonCode: r.reasonCode };",
			invoker,
			context: {},
		});
		expect(res.error).toBeUndefined();
		expect(res.result).toEqual({
			status: "denied",
			gateId: "g",
			reasonCode: "POLICY_X",
		});
	}, 30000);

	// N2 — concurrent nested calls do not cross-contaminate: each is recorded with its own distinct
	// args, and each result carries its own payload back to the guest.
	it("N2: concurrent nested calls keep distinct args and results", async () => {
		const calls: SandboxInvokeInput[] = [];
		const invoker: SandboxToolInvoker = {
			invoke: async (input) => {
				calls.push(input);
				return { i: (input.args as { i: number }).i };
			},
		};
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: "const [a, b] = await Promise.all([tools.a({ i: 1 }), tools.b({ i: 2 })]); return { a, b };",
			invoker,
			context: {},
		});
		expect(res.error).toBeUndefined();
		expect(calls).toEqual([
			{ path: "a", args: { i: 1 } },
			{ path: "b", args: { i: 2 } },
		]);
		expect(res.result).toEqual({ a: { i: 1 }, b: { i: 2 } });
	}, 30000);

	// N3 — a denial does not "stick open": each call is independently gated, so a prior call never
	// grants a later one. Two identical calls both come back denied.
	it("N3: a denial does not grant a later call", async () => {
		const invoker: SandboxToolInvoker = {
			invoke: async () => ({ status: "denied", gateId: "g", reason: "no" }),
		};
		const { output: res } = await executeInSandbox({
			sandbox: quickjs(),
			code: "const r1 = await tools.x({}); const r2 = await tools.x({}); return [r1.status, r2.status];",
			invoker,
			context: {},
		});
		expect(res.error).toBeUndefined();
		expect(res.result).toEqual(["denied", "denied"]);
	}, 30000);

	// N4 — recursion guard: a script that re-enters the capability tool (`tools.run_code(...)`) is
	// denied a nested VALUE with reasonCode NESTED_INVOKER_TOOL, and the outer run still completes.
	// [P0-if-fails] — re-entering the capability tool would be an authority-escalation path.
	it("N4: a nested run_code call is denied and the outer run completes", async () => {
		const rec = recordingSandbox();
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {
				code: 'const r = await tools.run_code({ code: "return 1" }); return r.reasonCode ?? r.status;',
			}),
			audit: createMemoryAudit(),
			tools: { run_code: runCodeTool({ sandbox: rec.sandbox }) },
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		// The guest observed the nested run_code resolve to a denied value with the recursion code.
		expect(rec.last()?.result).toBe(NESTED_INVOKER_TOOL);
	}, 30000);

	// N5 — a nested needs-approval fails closed as a denied VALUE (reasonCode
	// NESTED_APPROVAL_UNSUPPORTED); the outer run completes (never waiting_approval, never hangs) and
	// nothing is parked. [P0-if-fails] — a live isolate cannot await a days-long human approval.
	it("N5: a nested needs-approval fails closed without parking or hanging", async () => {
		const rec = recordingSandbox();
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {
				code: "const r = await tools.sensitive({}); return r.reasonCode ?? r.status;",
			}),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: rec.sandbox }),
				sensitive: govern(
					tool({
						description: "Sensitive.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async () => ({ ran: true }),
					}),
					{ gate: () => ({ decision: "needs-approval" }) },
				),
			},
		});

		const result = await runtime.run("do it");

		expect(result.status).toBe("completed");
		expect(rec.last()?.result).toBe(NESTED_APPROVAL_UNSUPPORTED);
		const pending =
			(await runtime.approvals?.list({ status: "pending" })) ?? [];
		expect(pending).toHaveLength(0);
	}, 30000);
});
