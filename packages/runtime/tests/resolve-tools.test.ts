import { ORGANIZATION_CONTEXT_KEY } from "@euroclaw/contracts";
import { jsonSchema, type ToolSet, type wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
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
			inputSchema: jsonSchema({ type: "object", properties: {} }),
			execute: async () => {
				ran.push(label);
				return { ran: label };
			},
		},
		{ access: "read" },
	);

const orgResolver = (ctx: Record<string, unknown>) =>
	typeof ctx.org === "string" ? ctx.org : undefined;

describe("runtime resolveTools — per-organization tool resolution", () => {
	it("dispatches an organization's registered tool for that org's run", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const registered: ToolSet = {
			reg_tool: recordingTool(ran, "registered") as ToolSet[string],
		};
		const runtime = createRuntime({
			model: callingModel("reg_tool", offered),
			tools: {},
			organization: orgResolver,
			resolveTools: (ctx) =>
				ctx[ORGANIZATION_CONTEXT_KEY] === "org-a" ? registered : {},
		});
		const result = await runtime.run("go", { org: "org-a" });
		expect(result.status).toBe("completed");
		expect(ran).toEqual(["registered"]);
		expect(offered.names).toContain("reg_tool");
	});

	it("an organization with nothing registered is offered only the code tools", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const registered: ToolSet = {
			reg_tool: recordingTool(ran, "registered") as ToolSet[string],
		};
		const runtime = createRuntime({
			model: callingModel(null, offered), // no tool call — just inspect what's offered
			tools: { code_tool: recordingTool(ran, "code") as ToolSet[string] },
			organization: orgResolver,
			resolveTools: (ctx) =>
				ctx[ORGANIZATION_CONTEXT_KEY] === "org-a" ? registered : {},
		});
		await runtime.run("go", { org: "org-b" });
		expect(offered.names).toContain("code_tool");
		expect(offered.names).not.toContain("reg_tool"); // org-b sees only code tools
	});

	it("a registered tool colliding with a code tool does not shadow it (code wins, logged)", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runtime = createRuntime({
			model: callingModel("shared", offered),
			tools: { shared: recordingTool(ran, "code") as ToolSet[string] },
			organization: orgResolver,
			resolveTools: () => ({
				shared: recordingTool(ran, "registered") as ToolSet[string],
			}),
		});
		await runtime.run("go", { org: "org-a" });
		expect(ran).toEqual(["code"]); // the code tool ran; the registered one was skipped
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('registered tool "shared" skipped'),
		);
		warn.mockRestore();
	});
});
