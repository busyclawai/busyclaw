// The host-facing half: `claw.api.agents.spawn` and `claw.api.agents.tree`.
//
// Same two operations the model gets, reached by a person or a script instead of by a turn. They are
// not a thinner wrapper over the capability — they differ in exactly one way that matters, and it is
// the reason this file exists rather than a re-export.
//
// THE CAPABILITY TAKES NO PARENT; THE DOOR MUST. A stamped tool's parent is the run it is executing
// inside, pinned by the runtime, unforgeable. A host caller has no run in flight, so it names one —
// and a named parent is caller input. That input is used for exactly two things: authorizing the
// call, and computing the child's depth and root. It never names the child's identity: the principal
// is stamped from the caller and from nothing else, so the copy-never-name property survives being
// given an input parameter.

import type { CapabilityContext, ClawApiCaller } from "@busyclaw/contracts";
import { endpoints, route, stateError } from "@busyclaw/contracts";
import { type } from "arktype";
import {
	type AgentCapability,
	createAgentCapability,
	type SpawnEngine,
	type SpawnLimits,
	type SpawnThreads,
} from "./capability";
import type { SubagentStore } from "./store";

/** The resource kind the doors anchor on. A subtree question is a question about a RUN. */
const RUN_KIND = "run";

const spawnInput = type({
	parentRunId: "string",
	alias: "string",
	prompt: "string",
}).onUndeclaredKey("reject");

const treeInput = type({ rootRunId: "string" }).onUndeclaredKey("reject");

// `fromRunId`, not a principal: this door speaks AS a run in the tree, and the alias it addresses is
// resolved in that run's own address book. A caller naming a run they do not manage is refused by the
// PEP before the address book is ever consulted.
const sendInput = type({
	fromRunId: "string",
	to: "string",
	message: "string",
}).onUndeclaredKey("reject");

export type AgentTreeNode = {
	childRunId: string;
	parentRunId: string;
	alias: string;
	depth: number;
	status: string;
	/**
	 * Where this child's work is written — the door onto its answer.
	 *
	 * DERIVED from the run, not stored: `childThreadId` is deterministic, so recording it on the edge
	 * would be a second copy of a fact one function already computes, and the two could disagree only
	 * by being wrong. Absent when the child had no claw to open a thread in, which is the same shape
	 * as any claw-less run: it ran, and nothing kept a transcript.
	 *
	 * Read it with `listMessages({ threadId, runId })` — the transcript door, which already gates,
	 * audits and `view`-guards content. A subagent's answer deliberately has no door of its own.
	 */
	threadId?: string;
};

export function buildAgentsApi(input: {
	engine: () => SpawnEngine;
	threads: () => SpawnThreads;
	store: () => SubagentStore;
	limits: SpawnLimits;
	joinTimeoutMs: number;
	now: () => string;
}) {
	const capabilityFor = (
		parentRunId: string,
		caller: ClawApiCaller | undefined,
	): AgentCapability => {
		const principal = caller?.principal;
		// The PEP has already required `manage` on the parent run, so an unauthenticated call cannot
		// reach here under enforce. Refused anyway rather than defaulted: a child whose principal was
		// invented is a child the floor would refuse at its first tool call, and it would read as a
		// policy bug rather than a missing caller.
		if (principal === undefined) {
			throw stateError("spawning needs an authenticated caller", {
				parentRunId,
			});
		}
		const ctx: CapabilityContext = {
			runId: parentRunId,
			principal,
			// No loop, so no step. The child id is keyed on `(parentRunId, alias)`, which is why this
			// costs nothing — a host spawn and a model spawn naming the same alias under the same
			// parent are the same child, which is the correct answer to both.
			step: undefined,
		};
		return createAgentCapability({
			ctx,
			engine: input.engine(),
			threads: input.threads(),
			store: input.store(),
			limits: input.limits,
			// Carried for shape, unreachable in practice: `awaitChildren` refuses a context with no
			// `requestAwait`, and there is no loop behind an api call to park.
			joinTimeoutMs: input.joinTimeoutMs,
			now: input.now,
		});
	};

	return endpoints({
		spawn: route
			.input(spawnInput)
			// MANAGE ON THE PARENT RUN. You may graft a child onto a run you already manage, and onto
			// no other — which is what stops a caller pointing a spawn at somebody else's run to have
			// a child created inside their claw.
			.authz("manage", ({ parentRunId }: { parentRunId: string }) => ({
				kind: RUN_KIND,
				id: parentRunId,
			}))
			.handler(
				async (
					args: { parentRunId: string; alias: string; prompt: string },
					caller?: ClawApiCaller,
				) =>
					capabilityFor(args.parentRunId, caller).spawnChild({
						alias: args.alias,
						prompt: args.prompt,
					}),
			),
		tree: route
			.input(treeInput)
			// READ ON THE ROOT RUN — the same level `listMessages` uses for a thread. Seeing which
			// children a run has is a read of that run, not of each child in turn.
			.authz("read", ({ rootRunId }: { rootRunId: string }) => ({
				kind: RUN_KIND,
				id: rootRunId,
			}))
			.handler(async (args: { rootRunId: string }) => {
				const edges = await input.store().tree(args.rootRunId);
				const engine = input.engine();
				const nodes: AgentTreeNode[] = [];
				for (const edge of edges) {
					// The RUN's status, read from the run. Mirroring it onto the edge would make the edge
					// a second place one fact lives, and the two would disagree exactly when it mattered.
					//
					// Read WITHOUT a per-child decision, and deliberately: the PEP has already required
					// `read` on the ROOT, which is this door's anchor. Re-deciding each child would
					// authorize a subtree read as N separate reads and answer a different question —
					// and a child a caller may not read individually would silently vanish from a tree
					// they are entitled to see whole.
					const run = await engine.runs?.get(edge.id);
					// The thread exists only if the child was recorded, which needs a claw. Asked of the
					// RUN rather than assumed from the derivation, so a claw-less child reports no
					// thread instead of an id pointing at a row nobody wrote.
					const threadId = run?.threadId;
					nodes.push({
						childRunId: edge.id,
						parentRunId: edge.parentRunId,
						alias: edge.alias,
						depth: edge.depth,
						...(threadId !== undefined ? { threadId } : {}),
						status: run?.status ?? "unknown",
					});
				}
				return { nodes };
			}),
		send: route
			.input(sendInput)
			// MANAGE ON THE SENDER, and the sender is the run the message comes FROM. A host steering a
			// subagent is speaking as the parent it manages, so the gate is on that run — not on the
			// child, which the caller may well not manage directly, and not on the pair, which would
			// make "who is talking" a caller-chosen fact.
			.authz("manage", ({ fromRunId }: { fromRunId: string }) => ({
				kind: RUN_KIND,
				id: fromRunId,
			}))
			.handler(
				async (
					args: { fromRunId: string; to: string; message: string },
					caller?: ClawApiCaller,
				) =>
					capabilityFor(args.fromRunId, caller).send({
						to: args.to,
						message: args.message,
					}),
			),
		cancelTree: route
			.input(treeInput)
			// MANAGE ON THE ROOT, like `spawn` and unlike `tree`. Stopping work is not reading it, and
			// the anchor is the root for the same reason the read's is: a subtree is one thing. Deciding
			// per child would let a caller cancel the half of a tree they happen to manage and leave the
			// rest running against a parent that will never collect it.
			.authz("manage", ({ rootRunId }: { rootRunId: string }) => ({
				kind: RUN_KIND,
				id: rootRunId,
			}))
			.handler(async (args: { rootRunId: string }, caller?: ClawApiCaller) => {
				const store = input.store();
				const engine = input.engine();
				const stamp = input.now();
				// THE ROOT TOO, not just its descendants. `tree` returns edges, and the root has none —
				// it is somebody's parent, not somebody's child. Cancelling every child and leaving the
				// run that started them going is the shape of this that looks right and is not.
				const edges = await store.tree(args.rootRunId);
				const runIds = [args.rootRunId, ...edges.map((edge) => edge.id)];

				let cancelled = 0;
				for (const runId of runIds) {
					// COOPERATIVE. `controlRun` latches the intent; a run with nothing in flight settles
					// synchronously and a running one stops at its next control point. `accepted: false`
					// means it had already finished, which is not a failure — it is the common case for
					// the children that did their job before anyone asked.
					const result = await engine.controlRun?.({
						runId,
						intent: "stop",
						...(caller?.principal !== undefined
							? { requestedBy: caller.principal }
							: {}),
						reason: `subtree of ${args.rootRunId} cancelled`,
					});
					if (result?.accepted === true) cancelled += 1;
				}

				// AND THE BARRIERS THEY WERE WAITING ON. A cancelled parent still owns an open join, and
				// nothing else will ever close it: its children are stopping, so no arrival meets the
				// threshold, and the reconciler would keep examining it every tick until the deadline
				// finally timed it out — then try to wake a run that is already terminal.
				let joins = 0;
				for (const runId of runIds) {
					for (const join of await store.openJoinsForOwner(runId)) {
						if (
							(await store.settleJoin({
								joinId: join.id,
								to: "cancelled",
								now: stamp,
							})) !== null
						) {
							joins += 1;
						}
					}
				}
				return { runs: runIds.length, cancelled, joins };
			}),
	});
}
