// `presence: "discoverable"` end to end: a tool that is NOT in the model's context window, found
// through `euroclaw__search` and run through `euroclaw__execute`.
//
// THE PROOF THIS FILE EXISTS FOR is the second describe. If the floor decided on "execute", one
// permit would unlock every discoverable tool at once — so the assertion is that a policy naming the
// TARGET's canonical path denies an execute-routed call, and that the compliance record says the
// target, not the meta-tool. Everything else here is the surface around that.

import type { EuroclawPlugin, ToolDefinition } from "@euroclaw/contracts";
import { createMemoryAudit } from "@euroclaw/core";
import { cedar } from "@euroclaw/policy-cedar";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import { durableRedactor, owned, type V2Model } from "./fixtures";

type WireCall = { name: string; input?: string };

const viaExecute = (
	path: string,
	args: Record<string, unknown> = {},
): WireCall => ({
	name: "euroclaw__execute",
	input: JSON.stringify({ path, args }),
});

const search = (query: string): WireCall => ({
	name: "euroclaw__search",
	input: JSON.stringify({ query }),
});

/** A model that emits one call, records the RESULT it gets back, then answers. */
function callingModel(
	call: WireCall,
	seen: { results: string[]; offered: string[] },
): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			seen.offered = (options.tools ?? []).map(
				(t) => (t as { name: string }).name,
			);
			for (const message of options.prompt) {
				if (message.role !== "tool") continue;
				for (const part of message.content) {
					if (part.type !== "tool-result") continue;
					const output = part.output;
					seen.results.push(
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
			if (step++ === 0) {
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

const publishTool = (ran: string[]): ToolDefinition =>
	govern(
		tool({
			description: "Publish a document to the public site.",
			inputSchema: jsonSchema<{ id: string }>({
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
			}),
			execute: async ({ id }) => {
				ran.push(id);
				return { published: id };
			},
		}),
		// A READ, deliberately: a write would park for approval on an autonomous run and hide
		// whichever decision these tests are actually about.
		{ access: "read" },
	);

const docsPlugin = (ran: string[]): EuroclawPlugin => ({
	id: "docs",
	tools: { admin: { publish: publishTool(ran) } },
});

describe("euroclaw__search — what is there, and what it takes", () => {
	it("returns the canonical path, the description and the input SCHEMA", async () => {
		const ran: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(search("publish a document"), seen),
			plugins: [docsPlugin(ran)],
		});

		expect((await claw.api.generate({ prompt: "go" })).status).toBe(
			"completed",
		);
		const result = JSON.parse(seen.results[0] ?? "{}") as {
			tools: { path: string; description: string; inputSchema: unknown }[];
		};
		// Enough to construct the call the model has to make next — and nothing else. The path is
		// the canonical id, because that is what `execute` addresses and what policy enumerates.
		expect(result.tools).toEqual([
			{
				path: "docs.admin.publish",
				description: "Publish a document to the public site.",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
			},
		]);
	});

	it("searches only the DISCOVERABLE half — an always-tool is already in the window", async () => {
		const ran: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(search("publish"), seen),
			// The host tool is `always` (its own door's default) and would match the query too.
			tools: { publishDoc: publishTool(ran) },
			plugins: [docsPlugin(ran)],
		});

		await claw.api.generate({ prompt: "go" });
		const result = JSON.parse(seen.results[0] ?? "{}") as {
			tools: { path: string }[];
		};
		expect(result.tools.map((t) => t.path)).toEqual(["docs.admin.publish"]);
		expect(seen.offered.sort()).toEqual([
			"euroclaw__execute",
			"euroclaw__search",
			"publishDoc",
		]);
	});
});

describe("euroclaw__execute — the floor decides on the TARGET", () => {
	it("a policy forbidding the TARGET path denies the routed call, and the audit says the target", async () => {
		const ran: string[] = [];
		const audit = createMemoryAudit();
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(
				viaExecute("docs.admin.publish", { id: "doc-1" }),
				seen,
			),
			audit,
			plugins: [
				docsPlugin(ran),
				cedar({
					// The TARGET's canonical id. Nothing here names `euroclaw.execute` — if the floor
					// decided on the meta-tool this policy could not reach the call at all, and the tool
					// would have run.
					policies: `forbid(principal, action == Action::"docs.admin.publish", resource);`,
				}),
			],
		});

		expect((await claw.api.generate({ prompt: "publish" })).status).toBe(
			"completed",
		);
		// Denied — the target never ran.
		expect(ran).toEqual([]);
		// …and the compliance record is the one someone grepping for `docs.admin.publish` finds. A log
		// full of "euroclaw.execute" would say only that the agent ran SOMETHING.
		const toolEntries = audit.entries().filter((e) => e.boundary === "tool");
		expect(toolEntries.map((e) => e.name)).toEqual(["docs.admin.publish"]);
		expect(toolEntries[0]?.status).toBe("denied");
	});

	it("permitting the meta-tool grants NOTHING — the target is still what gets decided", async () => {
		const ran: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(
				viaExecute("docs.admin.publish", { id: "doc-1" }),
				seen,
			),
			plugins: [
				docsPlugin(ran),
				cedar({
					// A permit for the router beside a forbid for the target. If "execute" were the
					// decided action this would be the hole: one permit unlocking everything behind it.
					policies: [
						`permit(principal, action == Action::"euroclaw.execute", resource);`,
						`forbid(principal, action == Action::"docs.admin.publish", resource);`,
					].join("\n"),
				}),
			],
		});

		await claw.api.generate({ prompt: "publish" });
		expect(ran).toEqual([]);
	});

	it("runs the target when policy permits it, with the target's own args", async () => {
		const ran: string[] = [];
		const audit = createMemoryAudit();
		const seen = { results: [] as string[], offered: [] as string[] };
		const effectIds: string[] = [];
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(
				viaExecute("docs.admin.publish", { id: "doc-1" }),
				seen,
			),
			audit,
			events: {
				emit: async (event) => {
					if (event.type === "tool.completed" && event.effectId) {
						effectIds.push(event.effectId);
					}
				},
			},
			plugins: [docsPlugin(ran)],
		});

		expect((await claw.api.generate({ prompt: "publish" })).status).toBe(
			"completed",
		);
		// The envelope was unwrapped: the tool got `{ id }`, not `{ path, args }`.
		expect(ran).toEqual(["doc-1"]);
		expect(audit.entries().find((e) => e.boundary === "tool")?.name).toBe(
			"docs.admin.publish",
		);
		// The effect ledger says the target too — an effect row naming the router would make replay
		// and compensation blind to what actually happened.
		const effectId = effectIds[0];
		if (effectId === undefined) throw new Error("expected an effect claim");
		expect((await claw.$context.effects?.get(effectId))?.toolName).toBe(
			"docs.admin.publish",
		);
	});

	it("a per-tool GATE on the target fires — routing is not a way past it", async () => {
		const ran: string[] = [];
		const gated: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.gated", { id: "doc-1" }), seen),
			plugins: [
				{
					id: "docs",
					tools: {
						gated: govern(
							tool({
								description: "A tool with its own gate.",
								inputSchema: jsonSchema<{ id: string }>({
									type: "object",
									properties: { id: { type: "string" } },
								}),
								execute: async () => {
									ran.push("gated");
									return {};
								},
							}),
							{
								access: "read",
								gate: (call) => {
									// The gate is keyed by PATH and matched on `call.name`: it sees the target.
									gated.push(call.name);
									return { decision: "deny", reason: "not today" };
								},
							},
						),
					},
				},
			],
		});

		await claw.api.generate({ prompt: "go" });
		expect(gated).toEqual(["docs.gated"]);
		expect(ran).toEqual([]);
	});

	it("an unknown target fails CLOSED — nothing runs, and no decision is invented", async () => {
		const ran: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.admin.purge"), seen),
			plugins: [docsPlugin(ran)],
		});

		await expect(claw.api.generate({ prompt: "purge" })).rejects.toThrow(
			/no executable tool "docs\.admin\.purge"/,
		);
		expect(ran).toEqual([]);
	});

	it("an envelope naming no target fails CLOSED on the meta-tool itself", async () => {
		const ran: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(
				{ name: "euroclaw__execute", input: JSON.stringify({ args: {} }) },
				seen,
			),
			plugins: [docsPlugin(ran)],
		});

		await expect(claw.api.generate({ prompt: "go" })).rejects.toThrow(
			/needs the canonical `path`/,
		);
		expect(ran).toEqual([]);
	});

	it("no stamped principal → a routed call fails CLOSED, like any other", async () => {
		const ran: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		// createClaw (not `owned`): nothing seeds `euroclaw__principal` and there is no identity
		// resolver, so the floor refuses to authorize a modeled action for nobody. Routing does not
		// change who is asking.
		const claw = createClaw({
			database: db,
			redaction: { redactor },
			model: callingModel(viaExecute("docs.admin.publish", { id: "d" }), seen),
			plugins: [docsPlugin(ran)],
		});

		await expect(claw.$context.runtime.generate("publish", {})).rejects.toThrow(
			/no stamped principal/,
		);
		expect(ran).toEqual([]);
	});
});

describe("presence — hiding a tool is UX, never enforcement", () => {
	it("a discoverable tool the model names DIRECTLY is still decided by the floor", async () => {
		const ran: string[] = [];
		const audit = createMemoryAudit();
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			// Never offered under this name — a model can emit a name it was never shown, and a
			// resumed run can carry a stale toolset. Hidden is not ungranted: the call resolves to
			// its path and the floor decides it, exactly as if it had been routed.
			model: callingModel({ name: "docs__admin__publish" }, seen),
			audit,
			plugins: [
				docsPlugin(ran),
				cedar({
					policies: `forbid(principal, action == Action::"docs.admin.publish", resource);`,
				}),
			],
		});

		await claw.api.generate({ prompt: "publish" });
		expect(ran).toEqual([]);
		expect(audit.entries().find((e) => e.boundary === "tool")?.name).toBe(
			"docs.admin.publish",
		);
	});
});
