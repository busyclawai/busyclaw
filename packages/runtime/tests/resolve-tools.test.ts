import type { ToolDefinitionSet } from "@euroclaw/contracts";
import { CONFIG_SCOPE_ID_CONTEXT_KEY } from "@euroclaw/contracts";
import { jsonSchema, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, govern } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/** A model that records the tools it was offered, calls one tool once, then stops. */
function callingModel(
	toolName: string | null,
	offered: { names: string[] },
): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			offered.names = (options.tools ?? []).map(
				(t) => (t as { name: string }).name,
			);
			const usage = {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			};
			if (toolName !== null && step++ === 0) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName,
							input: "{}",
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

const recordingTool = (ran: string[], label: string) =>
	govern(
		{
			description: `Record that ${label} ran.`,
			inputSchema: jsonSchema({ type: "object", properties: {} }),
			execute: async () => {
				ran.push(label);
				return { ran: label };
			},
		},
		{ access: "read" },
	);

const scopeResolver = (ctx: Record<string, unknown>) =>
	typeof ctx.org === "string"
		? { scope: "organization", scopeId: ctx.org }
		: undefined;

describe("runtime resolveTools — per-scope tool resolution", () => {
	it("dispatches a scope's registered tool for that scope's run", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const registered: ToolDefinitionSet = {
			reg_tool: recordingTool(ran, "registered"),
		};
		const runtime = createRuntime({
			model: callingModel("reg_tool", offered),
			tools: {},
			configScope: scopeResolver,
			resolveTools: (ctx) =>
				ctx[CONFIG_SCOPE_ID_CONTEXT_KEY] === "org-a" ? registered : {},
		});
		const result = await runtime.generate("go", { org: "org-a" });
		expect(result.status).toBe("completed");
		expect(ran).toEqual(["registered"]);
		expect(offered.names).toContain("reg_tool");
	});

	it("a scope with nothing registered is offered only the code tools", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const registered: ToolDefinitionSet = {
			reg_tool: recordingTool(ran, "registered"),
		};
		const runtime = createRuntime({
			model: callingModel(null, offered), // no tool call — just inspect what's offered
			tools: { code_tool: recordingTool(ran, "code") },
			configScope: scopeResolver,
			resolveTools: (ctx) =>
				ctx[CONFIG_SCOPE_ID_CONTEXT_KEY] === "org-a" ? registered : {},
		});
		await runtime.generate("go", { org: "org-b" });
		expect(offered.names).toContain("code_tool");
		expect(offered.names).not.toContain("reg_tool"); // org-b sees only code tools
	});

	it("a registered tool colliding with a code tool does not shadow it (code wins, warned)", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const warnings: string[] = [];
		const runtime = createRuntime({
			model: callingModel("shared", offered),
			tools: { shared: recordingTool(ran, "code") },
			configScope: scopeResolver,
			resolveTools: () => ({
				shared: recordingTool(ran, "registered"),
			}),
			warn: (message) => warnings.push(message),
		});
		await runtime.generate("go", { org: "org-a" });
		expect(ran).toEqual(["code"]); // the code tool ran; the registered one was skipped
		expect(
			warnings.some((message) =>
				message.includes('registered tool "shared" skipped'),
			),
		).toBe(true);
	});

	it("a registered tool whose PATH projects onto an offered name is skipped too", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const warnings: string[] = [];
		// Distinct paths, one wire name: the flat `a__b` and the dotted `a.b` are different tools that
		// the provider cannot tell apart. Letting the second in would drop one from the offered set
		// while leaving the other reachable under it — the model calls `a__b` and gets whichever won.
		const runtime = createRuntime({
			model: callingModel("a__b", offered),
			tools: { a__b: recordingTool(ran, "code") },
			configScope: scopeResolver,
			resolveTools: () => ({ "a.b": recordingTool(ran, "registered") }),
			warn: (message) => warnings.push(message),
		});
		await runtime.generate("go", { org: "org-a" });
		expect(ran).toEqual(["code"]);
		expect(offered.names).toEqual(["a__b"]);
		expect(
			warnings.some((message) => message.includes('already offered as "a__b"')),
		).toBe(true);
	});
});
