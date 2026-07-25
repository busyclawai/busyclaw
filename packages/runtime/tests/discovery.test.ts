// The mechanics of `presence: "discoverable"` at the runtime layer: what reaches the provider, what
// the ingress resolves, and the invariant that a runtime with nothing discoverable is untouched.

import type { ToolDefinitionSet } from "@euroclaw/contracts";
import { jsonSchema, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, govern } from "../src/index";
import { discoveryTools, modelToolProjection } from "../src/tools";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/** A model that records what it was offered, emits one call, then answers. */
function callingModel(
	call: { name: string; input?: string } | null,
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
			if (call !== null && step++ === 0) {
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: "c1",
							toolName: call.name,
							input: call.input ?? "{}",
						},
					],
					finishReason: { unified: "tool-calls" as const, raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text" as const, text: "done" }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

const recordingTool = (
	ran: string[],
	label: string,
	presence?: "always" | "discoverable",
) =>
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
		{ presence },
	);

describe("discovery — a runtime with nothing discoverable is untouched", () => {
	it("mints no meta-tools and offers exactly the declared tools", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const runtime = createRuntime({
			model: callingModel(null, offered),
			tools: { readDoc: recordingTool(ran, "readDoc") },
		});
		await runtime.generate("go");
		expect(offered.names).toEqual(["readDoc"]);
	});

	it("a reserved-namespace path collides LOUDLY once discovery is active", () => {
		const ran: string[] = [];
		const tools: ToolDefinitionSet = {
			"euroclaw.search": recordingTool(ran, "impostor"),
			hidden: recordingTool(ran, "hidden", "discoverable"),
		};
		expect(() =>
			createRuntime({ model: callingModel(null, { names: [] }), tools }),
		).toThrow(/reserved namespace/);
	});

	it("a REGISTERED row claiming a reserved path is skipped and warned, never thrown", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const warnings: string[] = [];
		// The same two postures the merge already takes on a collision: code fails loud, data — which
		// a host does not control — is turned away without failing the run.
		const runtime = createRuntime({
			model: callingModel(null, offered),
			tools: { hidden: recordingTool(ran, "hidden", "discoverable") },
			resolveTools: () => ({
				"euroclaw.search": recordingTool(ran, "impostor"),
			}),
			warn: (message) => warnings.push(message),
		});
		await runtime.generate("go");
		expect(offered.names.sort()).toEqual([
			"euroclaw__execute",
			"euroclaw__search",
		]);
		expect(
			warnings.some((message) => message.includes("namespace is reserved")),
		).toBe(true);
	});
});

describe("discovery — the provider edge", () => {
	it("keeps a discoverable tool OUT of the offered set and the meta-tools in it", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const runtime = createRuntime({
			model: callingModel(null, offered),
			tools: {
				readDoc: recordingTool(ran, "readDoc"),
				"docs.admin.publish": recordingTool(ran, "publish", "discoverable"),
			},
		});
		await runtime.generate("go");
		expect(offered.names.sort()).toEqual([
			"euroclaw__execute",
			"euroclaw__search",
			"readDoc",
		]);
	});

	it("still INDEXES the hidden tool's wire name — hiding is UX, not enforcement", () => {
		const ran: string[] = [];
		const projection = modelToolProjection({
			"docs.admin.publish": recordingTool(ran, "publish", "discoverable"),
		});
		expect(Object.keys(projection.tools)).toEqual([]);
		// A model that emits the name anyway resolves to the path, and the floor decides it — rather
		// than falling through unmodeled because nobody offered it.
		expect(
			projection.resolveCall({ name: "docs__admin__publish", input: {} }).path,
		).toBe("docs.admin.publish");
	});

	it("unwraps an execute envelope into the target's own call", () => {
		const ran: string[] = [];
		// Composed the way the runtime composes it: the meta-tools are ordinary members of the run's
		// set, and the ingress unwraps `execute` only because THIS run offers it. A set that never
		// minted them resolves the name to nothing and fails closed at dispatch instead.
		const tools = {
			"docs.admin.publish": recordingTool(ran, "publish", "discoverable"),
		};
		const projection = modelToolProjection({
			...tools,
			...discoveryTools(tools),
		});
		expect(
			projection.resolveCall({
				name: "euroclaw__execute",
				input: { path: "docs.admin.publish", args: { id: "d1" } },
			}),
		).toEqual({ path: "docs.admin.publish", args: { id: "d1" } });
		// An envelope with no usable target stays on the meta-tool, whose executable fails closed —
		// the resolver never guesses a target.
		expect(
			projection.resolveCall({ name: "euroclaw__execute", input: { args: {} } })
				.path,
		).toBe("euroclaw.execute");
		expect(
			projection.resolveCall({
				name: "euroclaw__execute",
				input: { path: "euroclaw.execute" },
			}).path,
		).toBe("euroclaw.execute");
	});

	it("dispatches a routed call — the target runs with the target's args", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const runtime = createRuntime({
			model: callingModel(
				{
					name: "euroclaw__execute",
					input: JSON.stringify({ path: "docs.admin.publish", args: {} }),
				},
				offered,
			),
			tools: {
				"docs.admin.publish": recordingTool(ran, "publish", "discoverable"),
			},
		});
		expect((await runtime.generate("go")).status).toBe("completed");
		expect(ran).toEqual(["publish"]);
	});
});
