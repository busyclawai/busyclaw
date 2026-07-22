import { createMemoryAudit } from "@euroclaw/core";
import { createRuntime, govern } from "@euroclaw/runtime";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { runCodeTool } from "../src/index";
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

const vSchema = jsonSchema<{ v: string }>({
	type: "object",
	properties: { v: { type: "string" } },
	required: ["v"],
});

describe("@euroclaw/sandboxes run_code end-to-end", () => {
	it("runs a script whose nested tool call is governed and audited alongside run_code", async () => {
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {
				code: 'return await tools.echo({ v: "hi" })',
			}),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: quickjs() }),
				echo: tool({
					description: "Echo.",
					inputSchema: vSchema,
					execute: async ({ v }) => ({ v }),
				}),
			},
		});

		const result = await runtime.generate("do it");

		expect(result.status).toBe("completed");
		const names = (runtime.audit?.entries() ?? []).map((e) => e.name);
		expect(names).toContain("run_code");
		expect(names).toContain("echo");
	});

	it("denies a nested call inside the script yet still completes run_code", async () => {
		const runtime = createRuntime({
			model: callToolOnceModel("run_code", {
				code: 'const r = await tools.echo({ v: "hi" }); return r.status;',
			}),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: quickjs() }),
				echo: govern(
					tool({
						description: "Echo.",
						inputSchema: vSchema,
						execute: async ({ v }) => ({ v }),
					}),
					{ gate: () => ({ decision: "deny", reason: "blocked in test" }) },
				),
			},
		});

		const result = await runtime.generate("do it");

		expect(result.status).toBe("completed");
		const entries = runtime.audit?.entries() ?? [];
		expect(entries.find((e) => e.name === "echo")?.status).toBe("denied");
		expect(entries.find((e) => e.name === "run_code")?.status).toBe("ok");
	});
});
