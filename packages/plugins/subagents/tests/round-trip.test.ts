// The whole feature, once, through the real machinery.
//
// Every other test in this package drives one piece. This one starts a parent that spawns, waits,
// parks for real — through the runtime loop, the `awaiting` result, the worker branch that enqueues
// NOTHING — and then checks that something brings it back and that it comes back exactly once.
//
// It is the test that would have caught a half-built join: `agent.await` producing parks that nothing
// can wake is a run that never ends, and no unit test of a store method can see that.

import { userPrincipal } from "@busyclaw/contracts";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { entityAdapter, memoryAdapter } from "@busyclaw/storage-core";
import type { wrapLanguageModel } from "ai";
import { createClaw } from "busyclaw";
import { describe, expect, it } from "vitest";
import {
	agentJoinId,
	agentWaitId,
	createSubagentStore,
	subagentModels,
	subagents,
} from "../src/index";

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

/**
 * A parent that spawns one child, waits for it, and reports.
 *
 * The child runs the SAME model — it just has no children of its own, so it falls through to the
 * text branch immediately. One model, two roles, because the child is a real run on the same claw.
 */
function parentModel(offered?: string[]): V2Model {
	const seen: string[] = [];
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			if (offered !== undefined && offered.length === 0) {
				offered.push(
					...((options.tools ?? []) as { name: string }[]).map((t) => t.name),
				);
			}
			const text = JSON.stringify(options.prompt);
			const isParent = text.includes("BE A PARENT");
			if (!isParent) {
				return {
					content: [{ type: "text", text: "the child's answer" }],
					finishReason: { unified: "stop", raw: undefined },
					usage,
					warnings: [],
				};
			}
			// The parent's script: spawn, then await, then speak. Keyed on what the transcript already
			// holds rather than a call counter, because the transcript is what survives a park and a
			// counter in this closure does not.
			const spawned = text.includes("childRunId");
			const settled = text.includes("the child's answer");
			if (!spawned) {
				seen.push("spawn");
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "call-spawn",
							toolName: "subagents__agent__spawn",
							input: JSON.stringify({ alias: "helper", prompt: "do a thing" }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			if (!settled) {
				seen.push("await");
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: `call-await-${seen.length}`,
							toolName: "subagents__agent__await",
							input: "{}",
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "the parent is done" }],
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
 * The floor classes `agent.spawn` as a write and parks it for confirmation, which is correct and is
 * not what this suite is about. Permitted loudly here rather than relabelled `read` at the tool — a
 * spawn genuinely creates a run, and stamping it a read would hide the same hole one layer up.
 */
const permitsWrites = {
	id: "test:permit-writes",
	policies: [
		{
			name: "test:permit-writes",
			cedar: `permit(principal, action in Action::"writes", resource);`,
			mode: "enforce" as const,
			plane: "tool" as const,
		},
	],
};

function harness(offered?: string[]) {
	const adapter = memoryAdapter();
	const plugin = subagents({ joinTimeoutMs: 60_000 });
	let runtimeHalf:
		| { cron?: readonly { handler: (ctx: never) => unknown }[] }
		| undefined;
	const observed = {
		...plugin,
		configure(context: Parameters<NonNullable<typeof plugin.configure>>[0]) {
			const half = plugin.configure?.(context);
			runtimeHalf = half as typeof runtimeHalf;
			return half;
		},
	};
	const claw = createClaw({
		database: adapter,
		model: parentModel(offered),
		cronHandler: { secret: "test-cron-secret" },
		engine: sqlEngine({
			store: createSqlEngineStore(adapter),
			workerId: "w1",
			cron: false,
		}),
		redaction: { posture: "raw" },
		plugins: [observed, permitsWrites],
	} as Parameters<typeof createClaw>[0]);

	const inner = claw as unknown as {
		api: {
			createClaw: (
				i: { id: string; name: string },
				c: { principal: typeof alice },
			) => Promise<{ id: string }>;
			getRun: (
				i: { id: string },
				c: { principal: typeof alice },
			) => Promise<{ status: string } | null>;
			createThread: (
				i: { id: string; clawId: string },
				c: { principal: typeof alice },
			) => Promise<{ id: string }>;
			sendMessage: (
				i: { threadId: string; clawId: string; message: string },
				c: { principal: typeof alice },
			) => Promise<{ driven: boolean; runId: string; result?: { status: string } }>;
		};
		$context: {
			engine?: {
				startRun: (i: {
					prompt: string;
					clawId: string;
					run: { principal: typeof alice };
				}) => Promise<{ id: string }>;
				work?: () => Promise<{ status?: string }>;
			};
		};
	};

	return {
		claw: inner,
		store: createSubagentStore(entityAdapter(adapter, subagentModels)),
		runCron: async () => {
			const entry = runtimeHalf?.cron?.[0];
			if (entry === undefined) throw new Error("no reconciler registered");
			return entry.handler({} as never) as Promise<{ data?: unknown }>;
		},
		/** Drive the queue to a standstill — a parked run leaves nothing behind, which is the point. */
		drain: async (rounds = 20) => {
			for (let i = 0; i < rounds; i += 1) {
				const result = await inner.$context.engine?.work?.();
				if (result === undefined || result.status === "idle") return i;
			}
			return rounds;
		},
	};
}

describe("a parent waits for a child, for real", () => {
	it("parks with nothing queued, and the reconciler brings it back exactly once", async () => {
		const h = harness();
		await h.claw.api.createClaw({ id: "claw-1", name: "P" }, { principal: alice });
		await h.claw.api.createThread(
			{ id: "thread-1", clawId: "claw-1" },
			{ principal: alice },
		);
		// THROUGH THE CHAT DOOR, not `engine.startRun`, and that is load-bearing rather than incidental:
		// the floor forbids an unconfirmed write unless the run is `interactive`, and only an entry point
		// with a person behind it stamps that. A worker-started run spawning a child would park on an
		// approval, which is the floor working.
		const sent = await h.claw.api.sendMessage(
			{ threadId: "thread-1", clawId: "claw-1", message: "BE A PARENT" },
			{ principal: alice },
		);
		const parent = { id: sent.runId };

		// THE PARK, observed where it happens. `sendMessage` drives the turn inline, so its result IS
		// the loop's — and `awaiting` is the fifth stop: the run is alive and NOTHING is scheduled to
		// look at it. Asserted here rather than by reading the run row later, because the sink wakes it
		// within the same drain and a row read afterwards is a race with the mechanism under test.
		expect(sent.result?.status).toBe("awaiting");
		const parked = await h.claw.api.getRun(
			{ id: parent.id },
			{ principal: alice },
		);
		expect(parked?.status).toBe("waiting");

		// The barrier exists and is still open — the child has not run yet, because the parent held the
		// only worker until it parked.
		const waitId = agentWaitId({ runId: parent.id, step: 1 });
		const joinId = agentJoinId(parent.id, waitId);
		expect((await h.store.join(joinId))?.status).toBe("waiting");
		expect(await h.store.countArrivals(joinId)).toBe(0);

		// THE WAKE. Draining runs the child; the sink hears `run.completed`, records the arrival, meets
		// the threshold, and resumes the parent from its checkpoint.
		await h.drain();

		const finished = await h.claw.api.getRun(
			{ id: parent.id },
			{ principal: alice },
		);
		expect(finished?.status).toBe("completed");
		expect((await h.store.join(joinId))?.status).toBe("fired");
		expect((await h.store.wait(waitId))?.status).toBe("fired");

		// EXACTLY ONCE. The resume task id is derived from the checkpoint, so a second waker's enqueue
		// loses at the database — and a reconciler pass over a settled barrier finds nothing to do.
		const report = (await h.runCron()).data as { fired: number; examined: number };
		expect(report).toMatchObject({ examined: 0, fired: 0 });
	});
});

describe("which of the three tools reaches the context window", () => {
	it("offers spawn and await by name, and leaves status to discovery", async () => {
		// PRESENCE IS CONTEXT-WINDOW POLICY, and the two that opt in do so for different reasons.
		// `spawn`, because nobody searches a catalog for a capability they do not know exists — left
		// discoverable it ships a feature most deployments never see used. `await`, because a resumed
		// parent comes back to a transcript holding its own earlier call and repeating it is the obvious
		// move: discoverable, that emits a name the provider rejects outright.
		const offered: string[] = [];
		const h = harness(offered);
		await h.claw.api.createClaw(
			{ id: "claw-1", name: "P" },
			{ principal: alice },
		);
		await h.claw.api.createThread(
			{ id: "thread-1", clawId: "claw-1" },
			{ principal: alice },
		);
		await h.claw.api.sendMessage(
			{ threadId: "thread-1", clawId: "claw-1", message: "BE A PARENT" },
			{ principal: alice },
		);

		expect(offered).toContain("subagents__agent__spawn");
		expect(offered).toContain("subagents__agent__await");
		// Meaningful only to a run that already spawned — which has the namespace in its own
		// transcript and can search precisely.
		expect(offered).not.toContain("subagents__agent__status");
		// And the discovery route is still there for it.
		expect(offered).toContain("busyclaw__search");
	});
});

describe("a message to a parked peer", () => {
	it("brings it back, because nothing else ever will", async () => {
		// A run parked `awaiting` has NO due row — no drain will find it again — so a message to it
		// would sit undelivered until its barrier's deadline. That is also the deadlock: a child needing
		// something from a parent parked on that very child, with both sides waiting on the other.
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
		expect(sent.result?.status).toBe("awaiting");
		const parent = sent.runId;
		expect(
			(await h.claw.api.getRun({ id: parent }, { principal: alice }))?.status,
		).toBe("waiting");

		// The child speaks upward while the parent is parked ON IT.
		const agents = (
			h.claw as unknown as {
				api: {
					agents: {
						tree: (
							i: { rootRunId: string },
							c: { principal: typeof alice },
						) => Promise<{ nodes: { childRunId: string }[] }>;
						send: (
							i: { fromRunId: string; to: string; message: string },
							c: { principal: typeof alice },
						) => Promise<{ delivered: boolean; woke?: boolean }>;
					};
				};
			}
		).api.agents;
		const { nodes } = await agents.tree(
			{ rootRunId: parent },
			{ principal: alice },
		);
		const child = nodes[0]?.childRunId;
		if (child === undefined) throw new Error("no child");

		const delivered = await agents.send(
			{ fromRunId: child, to: "parent", message: "I need a decision" },
			{ principal: alice },
		);

		expect(delivered).toMatchObject({ delivered: true, woke: true });

		// THE RUN IS BACK ON THE QUEUE, which is the claim — and it is asserted by draining rather than
		// by reading the status, because `resumeRun` enqueues the task and leaves the row `waiting`
		// until a worker claims it. A parked run and a woken-but-unclaimed one read the same; what
		// tells them apart is that one has work waiting for it and the other has nothing at all.
		expect(await h.drain()).toBeGreaterThan(0);
		expect(
			(await h.claw.api.getRun({ id: parent }, { principal: alice }))?.status,
		).not.toBe("waiting");
	});
});
