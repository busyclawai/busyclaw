// `presence: "discoverable"` end to end: a tool that is NOT in the model's context window, found
// through `busyclaw__search` and run through `busyclaw__execute`.
//
// THE PROOF THIS FILE EXISTS FOR is the second describe. If the floor decided on "execute", one
// permit would unlock every discoverable tool at once — so the assertion is that a policy naming the
// TARGET's canonical path denies an execute-routed call, and that the compliance record says the
// target, not the meta-tool. Everything else here is the surface around that.

import type { BusyclawPlugin, ToolDefinition } from "@busyclaw/contracts";
import { createMemoryAudit } from "@busyclaw/core";
import { cedar } from "@busyclaw/policy-cedar";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import {
	durableRedactor,
	type MockModel,
	owned,
	type V2Model,
} from "./fixtures";

type WireCall = { name: string; input?: string };

const viaExecute = (
	path: string,
	args: Record<string, unknown> = {},
): WireCall => ({
	name: "busyclaw__execute",
	input: JSON.stringify({ path, args }),
});

const search = (query: string): WireCall => ({
	name: "busyclaw__search",
	input: JSON.stringify({ query }),
});

/** A model that plays its calls one per step, recording each RESULT it gets back, then answers.
 *  A list is how "search, then call what it disclosed" is expressed as one turn. */
function callingModel(
	script: WireCall | readonly WireCall[],
	seen: { results: string[]; offered: string[] },
): MockModel {
	const calls = Array.isArray(script)
		? (script as readonly WireCall[])
		: [script as WireCall];
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
			const call = calls[step];
			if (call !== undefined) {
				step++;
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: `c${step}`,
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

const docsPlugin = (ran: string[]) =>
	({
		id: "docs",
		tools: { admin: { publish: publishTool(ran) } },
	}) satisfies BusyclawPlugin;

describe("busyclaw__search — what is there, and what it takes", () => {
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
			tools: {
				path: string;
				description: string;
				inputSchema: unknown;
				authorization?: string;
			}[];
		};
		// Enough to construct the call the model has to make next — and nothing else. The path is
		// the canonical id, because that is what `execute` addresses and what policy enumerates.
		// Plus what the floor would say: this one is a read, and the floor runs reads.
		expect(result.tools).toEqual([
			{
				path: "docs.admin.publish",
				description: "Publish a document to the public site.",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
				authorization: "available",
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
			"busyclaw__execute",
			"busyclaw__search",
			"publishDoc",
		]);
	});
});

type Disclosed = {
	path: string;
	authorization?: string;
	annotations?: Record<string, string>;
};

const disclosed = (raw: string | undefined): Disclosed[] =>
	(JSON.parse(raw ?? "{}") as { tools?: Disclosed[] }).tools ?? [];

/** An argument-less WRITE: the floor forbids an unconfirmed autonomous write but WOULD permit it
 *  once confirmed, so the probe answers needs-approval — the escalation case. */
const deployTool = (ran: string[]): ToolDefinition =>
	govern(
		tool({
			description: "Deploy the docs site.",
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
			}),
			execute: async () => {
				ran.push("deploy");
				return { deployed: true };
			},
		}),
		{ access: "write" },
	);

const GUIDANCE =
	"Deploys are gated on a release manager — ask before you retry.";

/** The declaration is what lets an annotation leave the engine at all (the allowlist), and the
 *  AUDIENCE on it is what decides which reader gets it. Both are on the same rule here, which is how
 *  they are actually written: `@escalate` names who can unblock it, `@guidance` tells the agent what
 *  to do about it. */
const escalationPlugin = {
	id: "escalations-test",
	policyAnnotations: [
		{ key: "escalate" },
		{ key: "guidance", audience: "model" },
	],
	policies: [
		{
			name: "escalate:eng",
			mode: "enforce",
			plane: "tool",
			cedar: `@escalate("betterauth:team_eng")
@guidance("${GUIDANCE}")
permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };`,
		},
	],
} satisfies BusyclawPlugin;

describe("busyclaw__search — disclosing what the floor would say", () => {
	it("marks a usable tool available, and passes the parking one's guidance — but never the target", async () => {
		const ran: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(search("docs"), seen),
			plugins: [
				{
					id: "docs",
					tools: {
						admin: { publish: publishTool(ran), deploy: deployTool(ran) },
					},
				},
				escalationPlugin,
			],
		});

		expect((await claw.api.generate({ prompt: "go" })).status).toBe(
			"completed",
		);
		const tools = disclosed(seen.results[0]);
		expect(
			tools.map((t) => [t.path, t.authorization, t.annotations?.guidance]),
		).toEqual(
			expect.arrayContaining([
				["docs.admin.publish", "available", undefined],
				// The model-audience value rides through VERBATIM, straight from the rule that WOULD
				// permit it — written by the author for exactly this reader.
				["docs.admin.deploy", "needs-approval", GUIDANCE],
			]),
		);
		// A disclosure is a MODEL-facing door like any other, so the host's bag is not on it: the same
		// `escalate` that reaches the after-gate is absent here, under any key.
		expect(seen.results[0]).not.toContain("betterauth:team_eng");
	});

	it("asking is not doing: nothing is parked, and only the search itself is audited", async () => {
		const ran: string[] = [];
		const audit = createMemoryAudit();
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			audit,
			model: callingModel(search("docs"), seen),
			plugins: [
				{
					id: "docs",
					tools: {
						admin: { publish: publishTool(ran), deploy: deployTool(ran) },
					},
				},
				escalationPlugin,
			],
		});

		await claw.api.generate({ prompt: "go" });
		// The probe runs before-gates only — no tool, and no AFTER-gate, which is where the audit row
		// and the parked approval are written. A disclosure that parked an approval for every write it
		// described would be a decision, not a description.
		expect(await claw.$context.approvals?.list({ status: "pending" })).toEqual(
			[],
		);
		// …and the search call itself is still governed like any other tool call: one door, one row.
		expect(
			audit
				.entries()
				.filter((e) => e.boundary === "tool")
				.map((e) => e.name),
		).toEqual(["busyclaw.search"]);
		expect(ran).toEqual([]);
	});

	it("a deny the arguments could flip is `conditional`, and the real call goes through", async () => {
		// THE TRAP. The probe asks with NO arguments, and this rule reads one. Reported as a denial,
		// the model would write the tool off; reported as `conditional`, it tries — and the floor,
		// which is the only thing that decides, permits the call it actually makes.
		const shipped: string[] = [];
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			model: callingModel(
				[search("ship"), viaExecute("docs.ship", { env: "staging" })],
				seen,
			),
			plugins: [
				{
					id: "docs",
					tools: {
						ship: govern(
							tool({
								description: "Ship the docs site to an environment.",
								inputSchema: jsonSchema<{ env: string }>({
									type: "object",
									properties: { env: { type: "string" } },
									required: ["env"],
								}),
								execute: async ({ env }) => {
									shipped.push(env);
									return { shipped: env };
								},
							}),
							{
								access: "read",
								// A gate reading `call.args` is the arg-sensitive decision a CODE tool
								// actually has: the floor builds no Cedar `context.args` for host tools
								// (`actionInputsFromTools` leaves `args` undefined on purpose), so a
								// `when { context.args… }` rule there would error and be skipped — in the
								// probe and in the real call alike. Registered tools DO carry a projected
								// `context.args`, and that is where a Cedar arg-condition bites the same way.
								gate: (call) =>
									call.args.env === "staging"
										? { decision: "permit" }
										: { decision: "deny", reason: "environment not permitted" },
							},
						),
					},
				},
			],
		});

		expect((await claw.api.generate({ prompt: "go" })).status).toBe(
			"completed",
		);
		expect(
			disclosed(seen.results[0]).map((t) => [t.path, t.authorization]),
		).toEqual([["docs.ship", "conditional"]]);
		expect(shipped).toEqual(["staging"]);
	});

	it("a tool left OUT of the results is still decided by the floor when called anyway", async () => {
		// THE INVARIANT. `docs.purge` takes no arguments, so the probe's deny is exact and search omits
		// it — but omitting is UX, never enforcement. The model names it anyway (a stale page, a lucky
		// guess, a resumed run) and the FLOOR denies it: the disclosure was never what stopped it.
		const ran: string[] = [];
		const audit = createMemoryAudit();
		const seen = { results: [] as string[], offered: [] as string[] };
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			redaction: { redactor },
			audit,
			model: callingModel([search("purge"), viaExecute("docs.purge")], seen),
			plugins: [
				{
					id: "docs",
					tools: {
						purge: govern(
							tool({
								description: "Purge the docs cache.",
								inputSchema: jsonSchema<Record<string, never>>({
									type: "object",
									properties: {},
								}),
								execute: async () => {
									ran.push("purge");
									return { purged: true };
								},
							}),
							{ access: "read" },
						),
					},
				},
				cedar({
					policies: `forbid(principal, action == Action::"docs.purge", resource);`,
				}),
			],
		});

		expect((await claw.api.generate({ prompt: "go" })).status).toBe(
			"completed",
		);
		expect(disclosed(seen.results[0])).toEqual([]);
		expect(ran).toEqual([]);
		const toolEntries = audit.entries().filter((e) => e.boundary === "tool");
		expect(toolEntries.map((e) => [e.name, e.status])).toEqual([
			["busyclaw.search", "ok"],
			["docs.purge", "denied"],
		]);
	});
});

describe("busyclaw__execute — the floor decides on the TARGET", () => {
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
					// The TARGET's canonical id. Nothing here names `busyclaw.execute` — if the floor
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
		// full of "busyclaw.execute" would say only that the agent ran SOMETHING.
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
						`permit(principal, action == Action::"busyclaw.execute", resource);`,
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
				{ name: "busyclaw__execute", input: JSON.stringify({ args: {} }) },
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
		// createClaw (not `owned`): nothing seeds `busyclaw__principal` and there is no identity
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
