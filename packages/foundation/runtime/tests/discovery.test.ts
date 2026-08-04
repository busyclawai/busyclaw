// The mechanics of `presence: "discoverable"` at the runtime layer: what reaches the provider, what
// the ingress resolves, and the invariant that a runtime with nothing discoverable is untouched.

import type { ToolDefinitionSet } from "@busyclaw/contracts";
import { jsonSchema, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, govern } from "../src/index";
import { discoveryTools, modelToolProjection } from "../src/tools";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/** A model that records what it was offered, emits one call, then answers. `results` (optional)
 *  collects the tool RESULTS it is handed back, for a test that reads what a tool actually said. */
function callingModel(
	call: { name: string; input?: string } | null,
	offered: { names: string[] },
	results?: string[],
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
			for (const message of options.prompt) {
				if (message.role !== "tool") continue;
				for (const part of message.content) {
					if (part.type !== "tool-result") continue;
					const output = part.output;
					results?.push(
						output.type === "text" ? output.value : JSON.stringify(output),
					);
				}
			}
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

/** A model that searches once and collects what the search result actually said. */
function searchingModel(query: string, results: string[]): V2Model {
	return callingModel(
		{ name: "busyclaw__search", input: JSON.stringify({ query }) },
		{ names: [] },
		results,
	);
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
			"busyclaw.search": recordingTool(ran, "impostor"),
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
				"busyclaw.search": recordingTool(ran, "impostor"),
			}),
			warn: (message: string) => void warnings.push(message),
		});
		await runtime.generate("go");
		expect(offered.names.sort()).toEqual([
			"busyclaw__execute",
			"busyclaw__search",
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
			"busyclaw__execute",
			"busyclaw__search",
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
				name: "busyclaw__execute",
				input: { path: "docs.admin.publish", args: { id: "d1" } },
			}),
		).toEqual({ path: "docs.admin.publish", args: { id: "d1" } });
		// An envelope with no usable target is REFUSED here — the resolver never guesses a target, and
		// no longer passes the call through to the meta-tool for its executable to reject.
		//
		// Where it fails moved for a governance reason. Passing it through relied on the floor skipping
		// unmodeled actions; once the floor gates every call, `busyclaw.execute` would reach a policy
		// decision — the one thing discovery.ts exists to prevent, because a permit naming it would
		// unlock every discoverable tool at once. Refusing the broken ENCODING at the ingress keeps the
		// meta-tool out of every decision, and keeps the two facts distinct: "you named no target" is
		// not "you may not do that", and only the first tells the model how to fix its call.
		for (const input of [{ args: {} }, { path: "busyclaw.execute" }]) {
			expect(() =>
				projection.resolveCall({ name: "busyclaw__execute", input }),
			).toThrow(/needs the canonical `path`/);
		}
	});

	it("dispatches a routed call — the target runs with the target's args", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const runtime = createRuntime({
			model: callingModel(
				{
					name: "busyclaw__execute",
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

describe("discovery — search discloses what the floor would say", () => {
	const searched = (results: readonly string[]) =>
		(
			JSON.parse(results[0] ?? "{}") as {
				tools?: { path: string; authorization?: string }[];
			}
		).tools ?? [];

	it("reports the gates that actually exist — a bare runtime objects to nothing", async () => {
		// No policy engine here at all (the Cedar floor is the CLAW's assembly, not the runtime's), so
		// the honest answer is `available`: the disclosure describes the gates this run has, never an
		// idea of what governance ought to be.
		const ran: string[] = [];
		const results: string[] = [];
		const runtime = createRuntime({
			model: searchingModel("publish", results),
			tools: {
				"docs.admin.publish": recordingTool(ran, "publish", "discoverable"),
			},
		});
		await runtime.generate("go");
		expect(searched(results)).toEqual([
			expect.objectContaining({
				path: "docs.admin.publish",
				authorization: "available",
			}),
		]);
	});

	it("a gate that refuses to decide leaves the tool listed with NO hint at all", async () => {
		// The probe asks with no arguments; this gate assumes it has some and throws. That is not a
		// denial and must never be shown as one — the tool is listed exactly as it was before
		// disclosure existed, and the model is free to try it.
		const results: string[] = [];
		const runtime = createRuntime({
			model: searchingModel("publish", results),
			tools: {
				"docs.admin.publish": govern(
					{
						description: "Publish a document.",
						inputSchema: jsonSchema<{ id: string }>({
							type: "object",
							properties: { id: { type: "string" } },
							required: ["id"],
						}),
						execute: async () => ({ published: true }),
					},
					{
						access: "read",
						gate: (call) => {
							if (typeof call.args.id !== "string") {
								throw new Error("id is required");
							}
							return { decision: "permit" };
						},
					},
					{ presence: "discoverable" },
				),
			},
		});
		await runtime.generate("go");
		const [disclosed] = searched(results);
		expect(disclosed?.path).toBe("docs.admin.publish");
		expect(disclosed?.authorization).toBeUndefined();
	});
});
