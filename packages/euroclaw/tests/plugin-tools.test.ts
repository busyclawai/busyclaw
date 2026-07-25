// slice-2 proof: a plugin ships its own tools, and they are tools like any other — the runtime
// dispatches them and the SAME always-on floor decides them. Nesting is the `endpoints()` shape (a
// nested record is a group), so `{ search, admin: { publish } }` on plugin `docs` addresses
// `docs.search` / `docs.admin.publish`; the model-facing name is the flattened projection of that
// path, because providers reject dots.
//
// A plugin's tools now default to `presence: "discoverable"`, so the model reaches them through the
// `euroclaw__execute` meta-tool rather than finding them in its toolset — which is why most calls
// below arrive wrapped. What arrives wrapped is decided, dispatched, audited and parked on the
// TARGET's own path: see tool-discovery.test.ts for that guarantee stated on its own.
//
// The collision cases are the load-bearing ones. A shadowed tool keeps its caller while swapping the
// behaviour and the governance facts behind it — the worst available failure mode — so every way two
// tools can land on the same name or the same path fails LOUD at assembly.

import type { EuroclawPlugin, ToolDefinition } from "@euroclaw/contracts";
import { createMemoryAudit } from "@euroclaw/core";
import { cedar } from "@euroclaw/policy-cedar";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import { durableRedactor, owned, type V2Model } from "./fixtures";

/** One wire call the mock model emits: a tool name and the JSON input beside it. */
type WireCall = { name: string; input?: string };

/** The wire encoding of a DISCOVERY-routed call — the meta-tool's name, the target in its envelope.
 *  This is exactly what a model that has just searched would emit. */
const viaExecute = (
	path: string,
	args: Record<string, unknown> = {},
): WireCall => ({
	name: "euroclaw__execute",
	input: JSON.stringify({ path, args }),
});

/** A model that records the tool names it was OFFERED, optionally emits one call, then answers. */
function callingModel(
	call: WireCall | null,
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
	access: "read" | "write",
	presence?: "always" | "discoverable",
): ToolDefinition =>
	govern(
		tool({
			description: `Record that ${label} ran.`,
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
			}),
			execute: async () => {
				ran.push(label);
				return { ran: label };
			},
		}),
		{ access },
		{ presence },
	);

/** The reference plugin: one top-level tool and one grouped tool, at both access classes. */
const docsPlugin = (ran: string[]): EuroclawPlugin => ({
	id: "docs",
	tools: {
		search: recordingTool(ran, "search", "read"),
		admin: { publish: recordingTool(ran, "publish", "write") },
	},
});

describe("plugin.tools — nesting, addressing, and dispatch", () => {
	it("a plugin's tools are DISCOVERABLE by default — the model is offered the meta-tools", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(null, offered),
			plugins: [docsPlugin(ran)],
		});

		await claw.api.generate({ prompt: "hello" });

		// A plugin can ship fifty tools at zero context cost: none of them is in the toolset, and the
		// two meta-tools that reach them are.
		expect(offered.names.sort()).toEqual([
			"euroclaw__execute",
			"euroclaw__search",
		]);

		// …while the catalog addresses by PATH, which is what gives a plugin a real subtree instead
		// of one flat leaf per tool.
		const catalog = claw.$context.runtime.catalog;
		expect(catalog.describe("docs.admin.publish")?.name).toBe(
			"docs__admin__publish",
		);
		const root = catalog.list().children;
		expect(root).toEqual([
			{ kind: "branch", address: "docs", label: "docs", childCount: 2 },
		]);
		expect(catalog.list("docs.admin").children).toEqual([
			{
				kind: "leaf",
				address: "docs.admin.publish",
				tool: {
					address: "docs.admin.publish",
					name: "docs__admin__publish",
					source: "host",
					description: "Record that publish ran.",
					risk: undefined,
				},
			},
		]);
	});

	it("a plugin tool is CALLABLE — the model routes through execute, the runtime dispatches it", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.search"), offered),
			plugins: [docsPlugin(ran)],
		});

		const result = await claw.api.generate({ prompt: "search" });
		expect(result.status).toBe("completed");
		expect(ran).toEqual(["search"]);
	});

	it("a plugin tool can opt back INTO the context window with presence: always", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel({ name: "docs__search" }, offered),
			plugins: [
				{
					id: "docs",
					tools: { search: recordingTool(ran, "search", "read", "always") },
				},
			],
		});

		expect((await claw.api.generate({ prompt: "search" })).status).toBe(
			"completed",
		);
		expect(ran).toEqual(["search"]);
		// The only tool in the run is `always`, so nothing is discoverable and the meta-tools are
		// not minted at all — the flattened wire name is the whole toolset.
		expect(offered.names).toEqual(["docs__search"]);
	});

	it("host tools keep working beside plugin tools, and keep their flat address", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel({ name: "readDoc" }, offered),
			tools: { readDoc: recordingTool(ran, "readDoc", "read") },
			plugins: [docsPlugin(ran)],
		});

		expect((await claw.api.generate({ prompt: "read" })).status).toBe(
			"completed",
		);
		expect(ran).toEqual(["readDoc"]);
		// The host's own `tools` keep the opposite default: written down by hand, so offered.
		expect(offered.names).toContain("readDoc");
		expect(claw.$context.runtime.catalog.describe("readDoc")?.name).toBe(
			"readDoc",
		);
	});
});

// A plugin tool is governed EXACTLY like a host tool: same floor, same facts, no bypass. These are
// the same two proofs authz-floor.test.ts makes for host tools, re-made through a plugin.
describe("plugin.tools — governed by the same floor", () => {
	it("an unconfirmed autonomous WRITE parks for approval; the tool never runs", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.admin.publish"), offered),
			plugins: [docsPlugin(ran)],
		});

		const result = await claw.api.generate({ prompt: "publish" });
		expect(result.status).toBe("waiting_approval");
		expect(ran).toEqual([]);
	});

	it("a policy targeting the PATH decides the call — the floor speaks paths, not wire names", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.search"), offered),
			plugins: [
				docsPlugin(ran),
				cedar({
					// The canonical id — what a grant would enumerate. A source `forbid` wins over the
					// floor's permit-reads, so the read denying proves the mapper addressed THIS action.
					policies: `forbid(principal, action == Action::"docs.search", resource);`,
				}),
			],
		});

		// The run completes (the model sees the denial and answers) but the tool never ran.
		expect((await claw.api.generate({ prompt: "search" })).status).toBe(
			"completed",
		);
		expect(ran).toEqual([]);
	});

	it("no stamped principal → a plugin tool fails CLOSED, exactly like a host tool", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		// createClaw (not `owned`): nothing seeds `euroclaw__principal`, and there is no identity
		// resolver — so the floor refuses to authorize a modeled action for nobody.
		const claw = createClaw({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.search"), offered),
			plugins: [docsPlugin(ran)],
		});

		await expect(claw.$context.runtime.generate("search", {})).rejects.toThrow(
			/no stamped principal/,
		);
		expect(ran).toEqual([]);
	});
});

// The id UNIFICATION: the wire name lives at the provider edge and nowhere else. Everything past the
// run loop's ingress — the Cedar decision, the audit, the transcript, an approval checkpoint,
// dispatch — speaks the canonical PATH. Grepping the compliance log for `docs.search` used to find
// nothing, because the audit recorded `docs__search` while the decision recorded `docs.search`.
describe("plugin.tools — one id past the provider edge", () => {
	it("the AUDIT and the transcript record the canonical path, not the wire name", async () => {
		const ran: string[] = [];
		const audit = createMemoryAudit();
		const toolEvents: string[] = [];
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.search"), { names: [] }),
			audit,
			events: {
				emit: async (event) => {
					if (event.type === "tool.called") toolEvents.push(event.toolName);
				},
			},
			plugins: [docsPlugin(ran)],
		});

		expect((await claw.api.generate({ prompt: "search" })).status).toBe(
			"completed",
		);
		expect(ran).toEqual(["search"]);

		// The model emitted `euroclaw__execute` — and neither record of the call mentions it, or the
		// flattened `docs__search` either. One id in the log, and it is the one a policy or a grant
		// enumerates.
		const entry = audit.entries().find((e) => e.boundary === "tool");
		expect(entry?.name).toBe("docs.search");
		// The transcript rides the same event the claws-store sink writes its `tool_call` row from.
		expect(toolEvents).toEqual(["docs.search"]);
	});

	it("an approved plugin-tool call resumes onto the SAME tool, correlated as the provider sent it", async () => {
		const ran: string[] = [];
		const audit = createMemoryAudit();
		// Captures the prompt of the model call AFTER the resume — where the parked tool's result is
		// handed back. The correlation pair must be exactly what the provider emitted.
		const resumed: { toolResults: { id: unknown; name: unknown }[] } = {
			toolResults: [],
		};
		const inner = callingModel(viaExecute("docs.admin.publish"), { names: [] });
		const model: V2Model = {
			...inner,
			doGenerate: async (options) => {
				for (const message of options.prompt) {
					if (message.role !== "tool") continue;
					for (const part of message.content) {
						if (part.type !== "tool-result") continue;
						resumed.toolResults.push({
							id: part.toolCallId,
							name: part.toolName,
						});
					}
				}
				return inner.doGenerate(options);
			},
		};
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model,
			audit,
			// `admin.publish` is a WRITE, so the floor parks it for approval on an autonomous run.
			plugins: [docsPlugin(ran)],
		});

		const waiting = await claw.api.generate({ prompt: "publish" });
		if (waiting.status !== "waiting_approval" || !waiting.approvalIds?.[0]) {
			throw new Error("expected approval wait");
		}
		expect(ran).toEqual([]);
		const approvalId = waiting.approvalIds[0];

		// The approval was parked under the CANONICAL id — the same id the Cedar decision used, and
		// the id `continueRun` re-dispatches on. A record written under one id and replayed under
		// another would either miss (fail closed) or, worse, land on some other tool.
		const parked = await claw.api.getApproval({ id: approvalId });
		expect(parked?.toolName).toBe("docs.admin.publish");

		await claw.api.grantApproval({ approvalId });
		expect((await claw.api.continueRun({ approvalId }))?.status).toBe(
			"completed",
		);
		// The right tool ran — exactly once.
		expect(ran).toEqual(["publish"]);
		// …and the result went back keyed the way the provider sent the call: same call id, same
		// name. The parked target was never offered under a name of its own, so there is nothing to
		// re-derive — the checkpoint carries the meta-tool's wire name for this one line. Answering
		// under `docs__admin__publish` would leave a provider that matches a result by NAME (Gemini's
		// functionResponse) staring at an unanswered call.
		expect(resumed.toolResults).toEqual([
			{ id: "c1", name: "euroclaw__execute" },
		]);
	});
});

describe("plugin.tools — collisions fail loud", () => {
	const collide = (input: {
		tools?: Record<string, ToolDefinition>;
		plugins: readonly EuroclawPlugin[];
	}) =>
		createClaw({
			model: callingModel(null, { names: [] }),
			...(input.tools ? { tools: input.tools } : {}),
			plugins: input.plugins,
		});

	it("a plugin tool that lands on a HOST tool's name", () => {
		const ran: string[] = [];
		expect(() =>
			collide({
				tools: { docs__search: recordingTool(ran, "host", "read") },
				plugins: [docsPlugin(ran)],
			}),
		).toThrow(/duplicate euroclaw plugin tool name/);
	});

	it("a plugin tool that lands on a HOST tool's path (distinct wire names, same canonical id)", () => {
		const ran: string[] = [];
		// A hand-registered dotted host tool — the shape a registered/sourced tool already has. Its
		// wire name (`docs.search`) differs from the plugin's (`docs__search`), but both would be the
		// action `docs.search`: one id, two tools, and the policy silently covering whichever won.
		expect(() =>
			collide({
				tools: { "docs.search": recordingTool(ran, "host", "read") },
				plugins: [docsPlugin(ran)],
			}),
		).toThrow(/duplicate euroclaw plugin tool path/);
	});

	it("two DISTINCT paths that collide only after flattening", () => {
		const ran: string[] = [];
		// `docs.admin__publish` and `docs.admin.publish` are different addresses that project onto the
		// same wire name — the collision the path check alone would miss.
		expect(() =>
			collide({
				plugins: [
					{
						id: "docs",
						tools: {
							admin__publish: recordingTool(ran, "flat", "read"),
							admin: { publish: recordingTool(ran, "grouped", "read") },
						},
					},
				],
			}),
		).toThrow(/duplicate euroclaw plugin tool name/);
	});

	it("two plugins whose rooted paths project onto one name", () => {
		const ran: string[] = [];
		expect(() =>
			collide({
				plugins: [
					docsPlugin(ran),
					{
						id: "docs__admin",
						tools: { publish: recordingTool(ran, "b", "read") },
					},
				],
			}),
		).toThrow(/duplicate euroclaw plugin tool name/);
	});

	it("two HOST tools that project onto one name — caught where the names are minted", () => {
		const ran: string[] = [];
		// No plugin involved, so the plugin-merge checks never run. The projection itself is the
		// backstop: one of these two would simply not be offered, and the model calling `a__b` would
		// reach whichever won.
		expect(() =>
			collide({
				tools: {
					"a.b": recordingTool(ran, "dotted", "read"),
					a__b: recordingTool(ran, "flat", "read"),
				},
				plugins: [],
			}),
		).toThrow(/duplicate model-facing tool name/);
	});
});
