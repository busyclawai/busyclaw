// slice-2 proof: a plugin ships its own tools, and they are tools like any other — the model is
// offered them, the runtime dispatches them, and the SAME always-on floor decides them. Nesting is
// the `endpoints()` shape (a nested record is a group), so `{ search, admin: { publish } }` on plugin
// `docs` addresses `docs.search` / `docs.admin.publish`; the model-facing name is the flattened
// projection of that path, because providers reject dots.
//
// The collision cases are the load-bearing ones. A shadowed tool keeps its caller while swapping the
// behaviour and the governance facts behind it — the worst available failure mode — so every way two
// tools can land on the same name or the same path fails LOUD at assembly.

import type { EuroclawPlugin, ToolDefinition } from "@euroclaw/contracts";
import { cedar } from "@euroclaw/policy-cedar";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import { durableRedactor, owned, type V2Model } from "./fixtures";

/** A model that records the tool names it was OFFERED, optionally calls one, then answers. */
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
							type: "tool-call" as const,
							toolCallId: "c1",
							toolName,
							input: "{}",
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
	it("nested records become dotted PATHS; the model is offered the flattened names", async () => {
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

		// Providers reject dots, so the wire name is the projection — never the canonical id.
		expect(offered.names.sort()).toEqual([
			"docs__admin__publish",
			"docs__search",
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

	it("a plugin tool is CALLABLE — the model calls it, the runtime dispatches it", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel("docs__search", offered),
			plugins: [docsPlugin(ran)],
		});

		const result = await claw.api.generate({ prompt: "search" });
		expect(result.status).toBe("completed");
		expect(ran).toEqual(["search"]);
	});

	it("host tools keep working beside plugin tools, and keep their flat address", async () => {
		const ran: string[] = [];
		const offered = { names: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel("readDoc", offered),
			tools: { readDoc: recordingTool(ran, "readDoc", "read") },
			plugins: [docsPlugin(ran)],
		});

		expect((await claw.api.generate({ prompt: "read" })).status).toBe(
			"completed",
		);
		expect(ran).toEqual(["readDoc"]);
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
			model: callingModel("docs__admin__publish", offered),
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
			model: callingModel("docs__search", offered),
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
			model: callingModel("docs__search", offered),
			plugins: [docsPlugin(ran)],
		});

		await expect(claw.$context.runtime.generate("search", {})).rejects.toThrow(
			/no stamped principal/,
		);
		expect(ran).toEqual([]);
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
});
