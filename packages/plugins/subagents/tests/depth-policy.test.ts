// The chain, end to end: an `agent_edge` row becomes a Cedar fact becomes a denial.
//
// This is the security claim the whole fact-resolver seam exists for. A child runs as its parent —
// authority is COPIED, so `context.principal` is the same string — in the same claw, with the same
// tools, under the same policies. Before this, a deployment could not express "the agent may send
// email; the subagents it spawns may not", because nothing in the policy context distinguished them.

import { userPrincipal } from "@busyclaw/contracts";
import { govern } from "@busyclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { memoryAdapter } from "@busyclaw/storage-core";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { createClaw } from "busyclaw";
import { describe, expect, it } from "vitest";
import { subagents } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const alice = userPrincipal("alice");

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/** Parent: spawn, then probe. Child: probe. Both under one model, as they are one claw. */
function script(): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const text = JSON.stringify(options.prompt);
			const isParent = text.includes("BE A PARENT");
			const probed = text.includes("probe-call");
			const spawned = text.includes("childRunId");
			const call = (name: string, id: string, input: string) => ({
				content: [
					{ type: "tool-call" as const, toolCallId: id, toolName: name, input },
				],
				finishReason: { unified: "tool-calls" as const, raw: undefined },
				usage,
				warnings: [],
			});
			if (isParent && !spawned) {
				return call(
					"subagents__agent__spawn",
					"call-spawn",
					JSON.stringify({ alias: "helper", prompt: "probe please" }),
				);
			}
			if (!probed) return call("probe", "probe-call", "{}");
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

/**
 * ONE RULE: a subagent may not probe. Everything else about the two runs is identical — same
 * principal, same claw, same tool, same floor — so this is the only thing that can tell them apart.
 */
const depthPolicy = {
	id: "test:depth",
	policies: [
		{
			name: "test:subagents-may-not-probe",
			cedar: `forbid(principal, action == Action::"probe", resource) when { context.facts.contains("subagents.agentDepth") };`,
			mode: "enforce" as const,
			plane: "tool" as const,
		},
	],
};

function harness() {
	const adapter = memoryAdapter();
	const probed: string[] = [];
	// TOOL-LEVEL OUTCOMES live on the runtime's event stream, not in `run_event` — the engine's table
	// records execution state (started/completed), and a per-call decision is observability.
	const decisions: { type: string; runId?: string }[] = [];
	const stamped: { runId: string; facts: unknown }[] = [];
	const claw = createClaw({
		database: adapter,
		model: script(),
		cronHandler: { secret: "s" },
		engine: sqlEngine({
			store: createSqlEngineStore(adapter),
			workerId: "w1",
			cron: false,
		}),
		redaction: { posture: "raw" },
		tools: {
			probe: govern(
				tool({
					description: "A governed READ — see the note on `access` below.",
					inputSchema: jsonSchema({ type: "object", properties: {} }),
					execute: async () => {
						probed.push("ok");
						return { ok: true };
					},
				}),
				// READ, and this is load-bearing rather than incidental. As a WRITE it was denied for the
				// child by `floor:unconfirmed-autonomous-write-forbidden` — a spawned child is
				// `autonomous` while a `sendMessage` parent is `interactive` — so the test passed for a
				// reason that had nothing to do with the fact under test, and went on passing with the
				// fact bag emptied. A read is permitted for both by `floor:reads-run`, which leaves the
				// depth fact as the ONLY thing that can separate them.
				{ access: "read" },
			),
		},
		plugins: [
			subagents(),
			depthPolicy,
			{
				id: "test:facts-probe",
				// Reads the stamped context DIRECTLY, because the "always present, even when empty"
				// property cannot be seen through a policy: a `when { context.facts has … }` guard
				// answers the same whether the base is absent (error → policy skipped) or present and
				// empty (guard false). Both leave the rule unapplied, so only the context itself says
				// which happened.
				gates: [
					{
						id: "test:facts-probe",
						matcher: () => true,
						handler: (_call: unknown, ctx: Record<string, unknown>) => {
							stamped.push({
								runId: String(ctx["busyclaw__runId"] ?? ""),
								facts: ctx["busyclaw__facts"],
							});
							return { decision: "permit" as const };
						},
					},
				],
			},
			{
				id: "test:watch",
				eventSinks: [
					{
						emit: (event: { type: string; runId?: string }) => {
							if (event.type.startsWith("tool.")) {
								decisions.push({
									type: event.type,
									...(event.runId !== undefined ? { runId: event.runId } : {}),
								});
							}
						},
					},
				],
			},
			{
				id: "test:permit-spawn",
				policies: [
					{
						name: "test:permit-spawn",
						cedar: `permit(principal, action == Action::"subagents.agent.spawn", resource);`,
						mode: "enforce" as const,
						plane: "tool" as const,
					},
				],
			},
		],
	} as Parameters<typeof createClaw>[0]);

	const inner = claw as unknown as {
		api: {
			createClaw: (
				i: { id: string; name: string },
				c: { principal: typeof alice },
			) => Promise<{ id: string }>;
			createThread: (
				i: { id: string; clawId: string },
				c: { principal: typeof alice },
			) => Promise<{ id: string }>;
			sendMessage: (
				i: { threadId: string; clawId: string; message: string },
				c: { principal: typeof alice },
			) => Promise<{ runId: string }>;
			listRunEvents: (
				i: { runId: string },
				c: { principal: typeof alice },
			) => Promise<{ type: string; payload?: Record<string, unknown> }[]>;
			agents: {
				tree: (
					i: { rootRunId: string },
					c: { principal: typeof alice },
				) => Promise<{ nodes: { childRunId: string }[] }>;
			};
		};
		$context: { engine?: { work?: () => Promise<{ status?: string }> } };
	};

	return {
		claw: inner,
		probed,
		decisions,
		stamped,
		drain: async () => {
			for (let i = 0; i < 20; i += 1) {
				const r = await inner.$context.engine?.work?.();
				if (r === undefined || r.status === "idle") return;
			}
		},
	};
}

/** What the floor decided about `probe` for one run. */
const probeOutcome = (
	h: ReturnType<typeof harness>,
	runId: string,
): string | undefined =>
	h.decisions.find(
		(d) => d.runId === runId && (d.type === "tool.completed" || d.type === "tool.denied"),
	)?.type;

describe("a policy can forbid a subagent what it permits its parent", () => {
	it("denies the child's call and allows the parent's, on one principal", async () => {
		const h = harness();
		await h.claw.api.createClaw(
			{ id: "claw-1", name: "P" },
			{ principal: alice },
		);
		await h.claw.api.createThread(
			{ id: "thread-1", clawId: "claw-1" },
			{ principal: alice },
		);
		const sent = await h.claw.api.sendMessage(
			{ threadId: "thread-1", clawId: "claw-1", message: "BE A PARENT" },
			{ principal: alice },
		);
		await h.drain();

		const { nodes } = await h.claw.api.agents.tree(
			{ rootRunId: sent.runId },
			{ principal: alice },
		);
		const child = nodes[0]?.childRunId;
		if (child === undefined) throw new Error("no child was spawned");

		// SAME PRINCIPAL, SAME TOOL, SAME CLAW — and opposite answers. That is the entire point: the
		// only thing separating them is a row in a plugin's table, surfaced as a fact.
		expect(probeOutcome(h, sent.runId)).toBe("tool.completed");
		expect(probeOutcome(h, child)).toBe("tool.denied");
		// And the tool really only ran once, for the parent — the denial is a refusal, not a label
		// applied after the fact.
		expect(h.probed).toEqual(["ok"]);
	});
});

describe("the fact bag is stamped even when nothing contributed one", () => {
	it("gives a run with no plugin facts an EMPTY bag, not an absent one", async () => {
		// THE FAIL-OPEN HAZARD, and the reason this is asserted on the context rather than through a
		// policy. cedar-wasm ERRORS on an absent base, and an erroring policy is SKIPPED rather than
		// failed — so a `forbid` guarded on `context.facts has …` silently stops applying to every run
		// that contributed no facts. Through a policy the two are indistinguishable: absent (error →
		// skipped) and present-but-empty (guard false) both leave the rule unapplied. Only the stamped
		// context says which one happened. This tree has been bitten by exactly this twice, on `clawId`.
		const h = harness();
		await h.claw.api.createClaw(
			{ id: "claw-1", name: "P" },
			{ principal: alice },
		);
		await h.claw.api.createThread(
			{ id: "thread-1", clawId: "claw-1" },
			{ principal: alice },
		);
		const sent = await h.claw.api.sendMessage(
			{ threadId: "thread-1", clawId: "claw-1", message: "BE A PARENT" },
			{ principal: alice },
		);
		await h.drain();

		// The parent is nobody's child, so subagents offers nothing for it.
		const parent = h.stamped.find((entry) => entry.runId === sent.runId);
		expect(parent?.facts).toEqual([]);

		// And the child's bag carries the fact, namespaced by the plugin that answered.
		const { nodes } = await h.claw.api.agents.tree(
			{ rootRunId: sent.runId },
			{ principal: alice },
		);
		const child = h.stamped.find(
			(entry) => entry.runId === nodes[0]?.childRunId,
		);
		// TWO TAGS PER FACT: the bare key answers "is this a subagent at all" — which is the question a
		// policy asks when it does not already know the depth — and the valued one answers "which".
		expect(child?.facts).toEqual([
			"subagents.agentDepth",
			"subagents.agentDepth:1",
			"subagents.agentRoot",
			`subagents.agentRoot:${sent.runId}`,
		]);
	});
});
