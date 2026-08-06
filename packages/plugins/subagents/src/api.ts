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
	type SpawnClawLike,
	type SpawnLimits,
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

export type AgentTreeNode = {
	childRunId: string;
	parentRunId: string;
	alias: string;
	depth: number;
	status: string;
};

export function buildAgentsApi(input: {
	claw: () => SpawnClawLike;
	store: () => SubagentStore;
	limits: SpawnLimits;
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
			// IDENTITY, and that is not a shortcut. `translate` moves a value out of one run's
			// redaction container into another's; a host-supplied prompt was never in a container, so
			// there is nothing to move and rehydrating it would look up placeholders it does not have.
			// Tokenizing it into the child's container is the run door's own business, not this
			// crossing's.
			translate: async (value) => value,
		};
		return createAgentCapability({
			ctx,
			claw: input.claw(),
			store: input.store(),
			limits: input.limits,
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
			.handler(async (args: { rootRunId: string }, caller?: ClawApiCaller) => {
				const edges = await input.store().tree(args.rootRunId);
				const claw = input.claw();
				const nodes: AgentTreeNode[] = [];
				for (const edge of edges) {
					// The RUN's status, read from the run. Mirroring it onto the edge would make the edge
					// a second place one fact lives, and the two would disagree exactly when it mattered.
					const run = await claw.api.getRun(
						{ id: edge.id },
						caller?.principal !== undefined
							? { principal: caller.principal }
							: undefined,
					);
					nodes.push({
						childRunId: edge.id,
						parentRunId: edge.parentRunId,
						alias: edge.alias,
						depth: edge.depth,
						status: run?.status ?? "unknown",
					});
				}
				return { nodes };
			}),
	});
}
