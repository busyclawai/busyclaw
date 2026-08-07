// subagents() — a run spawns child runs, and can stop to wait for them.
//
// One line of host wiring. The plugin owns five tables, registers one capability, and contributes
// three model-facing tools. Everything that decides anything is either a database row or the
// governance floor; nothing here holds authority of its own.
//
// It reaches OUTWARD in exactly two places, and both are scheduled rather than called: an event sink
// that hears a child end, and a cron reconciler that goes and asks. Neither is optional — see
// `$HasCron` — because the fast one cannot see a failure and the slow one is the only thing that can.

import type {
	BusyclawCronContext,
	BusyclawPlugin,
	BusyclawPluginConfigureContext,
	CapabilityContext,
} from "@busyclaw/contracts";
import { configurationError, govern } from "@busyclaw/contracts";
import { jsonSchema, tool } from "ai";
import { buildAgentsApi } from "./api";
import {
	type AgentCapability,
	createAgentCapability,
	type SpawnEngine,
	type SpawnMessages,
	type SpawnThreads,
} from "./capability";
import type { JoinCheckpoints, JoinEngine } from "./join";
import { onRunEvent, reconcileJoins } from "./reconcile";
import { subagentModels } from "./schema";
import { createSubagentStore, type SubagentStore } from "./store";

export type SubagentsConfig = {
	/**
	 * How deep a tree may go. The refusal lives in the capability, where it is LEGIBLE to the model —
	 * a policy fact would be the stronger cap, but there is no channel today by which a child's depth
	 * reaches the runtime, so promising one here would be a lie.
	 */
	maxDepth?: number;
	/** How many children one run may have. Counted over edge rows, so it holds across processes. */
	maxChildren?: number;
	/**
	 * How long a parent may stay parked on its children before the reconciler wakes it with whatever
	 * landed. Default 15 minutes.
	 *
	 * There is no "no deadline" — the schema makes one required. A crashed child dead-letters without
	 * writing an arrival, so a parent with no deadline is a run that never ends, and that is this
	 * architecture's default failure rather than an unlucky case.
	 */
	joinTimeoutMs?: number;
	/**
	 * How many barriers one reconciler pass examines. Default 100.
	 *
	 * A bound rather than "all of them", because this runs on a cron tick that something is waiting
	 * for. Whatever is left waits for the next pass, which is the same latency the deadline already
	 * promises.
	 */
	reconcileBatch?: number;
};

export type { AgentTreeNode } from "./api";
export type {
	AgentAwaitResult,
	AgentCapability,
	AgentChildResult,
	AgentChildStatus,
} from "./capability";
export type { JoinCheckpoints, JoinEngine } from "./join";
export { arrivalOutcome, settleIfMet } from "./join";
export type { ReconcileReport } from "./reconcile";
export { onRunEvent, reconcileJoins } from "./reconcile";
export {
	agentArrivalId,
	agentEdgeEntity,
	agentEdgeFields,
	agentJoinArrivalEntity,
	agentJoinEntity,
	agentJoinId,
	agentLinkEntity,
	agentLinkFields,
	agentLinkId,
	agentWaitEntity,
	agentWaitId,
	childRunId,
	PARENT_ALIAS,
	subagentModels,
} from "./schema";
export type {
	AgentArrival,
	AgentEdge,
	AgentJoin,
	AgentWait,
	SubagentStore,
} from "./store";
export { createSubagentStore } from "./store";

/** The name the stamped tools ask for, and the name the plugin registers under. */
export const AGENT_CAPABILITY = "agent";

const spawnInput = jsonSchema<{ alias: string; prompt: string }>({
	type: "object",
	properties: {
		alias: {
			type: "string",
			description:
				"Your local name for this child — how you will refer to it later. Must be unique among your children.",
		},
		prompt: {
			type: "string",
			description:
				"What the child should do. It starts with this and nothing else.",
		},
	},
	required: ["alias", "prompt"],
});

const awaitInput = jsonSchema<{ aliases?: string[]; mode?: "all" | "any" }>({
	type: "object",
	properties: {
		aliases: {
			type: "array",
			items: { type: "string" },
			description:
				"Which of your subagents to wait for, by the aliases you gave them. Omit to wait for all of them.",
		},
		mode: {
			type: "string",
			enum: ["all", "any"],
			description:
				"`all` (the default) comes back when every one has finished; `any` comes back as soon as the first does.",
		},
	},
});

const sendInput = jsonSchema<{ to: string; message: string }>({
	type: "object",
	properties: {
		to: {
			type: "string",
			description:
				"Who to speak to, by the alias you know them by. Use `parent` for whoever started you.",
		},
		message: {
			type: "string",
			description: "What to say. They read it at their next step.",
		},
	},
	required: ["to", "message"],
});

// ANNOTATED `BusyclawPlugin<"has-cron">`, not the bare `BusyclawPlugin` this used to say. The bare
// one widens the phantom to the whole flag union, and the phantom is the entire mechanism by which a
// host is made to supply a `cronHandler` — under the wide annotation the requirement is a comment.
// (Inferring the return type would carry it too, but the inferred type cannot be named without
// reaching into the AI SDK's internals, so it has to be written down.)
export function subagents(
	config: SubagentsConfig = {},
): BusyclawPlugin<"has-cron"> {
	const limits = {
		maxDepth: config.maxDepth ?? 3,
		maxChildren: config.maxChildren ?? 8,
	};
	const joinTimeoutMs = config.joinTimeoutMs ?? 15 * 60 * 1000;
	const reconcileBatch = config.reconcileBatch ?? 100;
	// Filled by `configure`, read at CALL time. This is the binding the static-registration rule
	// exists for: the capability needs the assembled claw, which is being built around this plugin.
	let wired:
		| {
				engine: () => SpawnEngine & JoinEngine;
				threads: SpawnThreads;
				messages?: SpawnMessages;
				checkpoints?: JoinCheckpoints;
				store: SubagentStore;
		  }
		| undefined;
	const now = () => new Date().toISOString();

	const requireWired = () => {
		if (wired === undefined) {
			throw configurationError("subagents() is not wired to a claw yet", {
				reason:
					"the plugin needs a database — `configure` never ran, so there is nowhere to record an edge",
			});
		}
		return wired;
	};

	const capability = (ctx: CapabilityContext): AgentCapability => {
		const bound = requireWired();
		return createAgentCapability({
			ctx,
			engine: bound.engine(),
			threads: bound.threads,
			...(bound.messages !== undefined ? { messages: bound.messages } : {}),
			store: bound.store,
			limits,
			joinTimeoutMs,
			now,
		});
	};

	return {
		id: "subagents",
		// A parent that waits needs something that runs later. The event sink covers the endings the
		// runtime announces, and a child that CRASHED announces none of them — it returns through the
		// worker's catch, and the two dead-letter paths emit nothing at all. So without a scheduled
		// reconciler a parent parked on a dead child waits out its whole deadline, and a deployment that
		// never ticks leaves it parked for good. Declared rather than documented: the host is made to
		// supply a `cronHandler` at compile time.
		$HasCron: "has-cron",
		$RequiresDatabase: true,
		schema: subagentModels,
		// STATIC, read before `configure`. See the field's own doc: the factory closes over `wired`,
		// which `configure` assigns, and the runtime calls it per tool call — by which time it is set.
		capabilities: { [AGENT_CAPABILITY]: capability },
		tools: {
			agent: {
				spawn: govern(
					tool({
						description:
							"Start a subagent: another agent run that works alongside you on its own. It has your permissions and your tools. Give it a short alias you will use to refer to it, and everything it needs to know — it cannot see your conversation.",
						inputSchema: spawnInput,
						execute: async (args, options) => {
							const agent = capabilityFrom(options);
							return agent.spawnChild(
								args as { alias: string; prompt: string },
							);
						},
					}),
					// Not `invoker`. That bit gates arbitrary governed tool invocation as well, and "may
					// create a subordinate" is a different permission from "may call anything directly".
					{ capability: AGENT_CAPABILITY },
					// PRESENT, against the plugin default. Delegating is a strategic choice a model makes
					// when it notices work that splits — and nobody searches a catalog for a capability
					// they do not know exists. Left discoverable, this ships a feature most deployments
					// would never see used, which is a worse trade than one tool's context.
					{ presence: "always" },
				),
				status: govern(
					tool({
						description:
							"List the subagents you started and whether each has finished.",
						inputSchema: jsonSchema({ type: "object", properties: {} }),
						execute: async (_args, options) => ({
							children: await capabilityFrom(options).status(),
						}),
					}),
					// DISCOVERABLE, the plugin default, and the only one of the three left there. It is
					// meaningful solely to a run that already spawned something — which is a run that has
					// the namespace in its own transcript and can search precisely. The two that carry the
					// context cost are the two a model cannot get to any other way.
					{ capability: AGENT_CAPABILITY, access: "read" },
				),
				await: govern(
					tool({
						description:
							"Wait for subagents you started to finish, and read what they answered. If they are not done, your turn STOPS here and resumes automatically once they are — so call this and say nothing after it. When you come back, call it again to collect the answers.",
						inputSchema: awaitInput,
						execute: async (args, options) =>
							capabilityFrom(options).awaitChildren(
								args as { aliases?: string[]; mode?: "all" | "any" },
							),
					}),
					// READ. Waiting for a child and creating one are different permissions, and the
					// dangerous one is `spawn`: this reads results from runs the caller already parents.
					{ capability: AGENT_CAPABILITY, access: "read" },
					// PRESENT, and this one is a correctness argument rather than a discovery one. Its whole
					// contract is "call me again when you come back", and a resumed parent comes back to a
					// transcript containing its own earlier `await` call — so repeating it is the obvious
					// move. Discoverable, that emits a name the provider rejects as an unavailable tool, and
					// the model has to work out for itself that the route is now `busyclaw__execute`.
					{ presence: "always" },
				),
				send: govern(
					tool({
						description:
							"Send a message to an agent you know: a subagent you started, or `parent` for whoever started you. They read it at their next step. Use it to steer work already under way, to answer a question, or to report back without waiting to finish.",
						inputSchema: sendInput,
						execute: async (args, options) =>
							capabilityFrom(options).send(
								args as { to: string; message: string },
							),
					}),
					// READ, like `await`. Speaking to a peer you were introduced to creates nothing, and
					// the address book is what bounds it: an alias you were never given resolves to
					// nothing, whatever the floor says.
					{ capability: AGENT_CAPABILITY, access: "read" },
					// PRESENT. A child cannot ask its parent a question it has to go searching for first,
					// and the parent is the one peer EVERY child has — this is the tool that makes the
					// relationship two-way rather than fire-and-forget.
					{ presence: "always" },
				),
			},
		},
		/**
		 * WHAT MAKES A CHILD A CHILD, told to the policy engine.
		 *
		 * A subagent is otherwise indistinguishable from its parent at the floor: authority is COPIED,
		 * so the principal is the same string; it runs in the same claw with the same tools. The only
		 * thing that says "this is a subordinate" is an `agent_edge` row, and the runtime cannot read
		 * plugin tables. So `forbid(... ) when { a subagent }` was simply unwriteable.
		 *
		 * READ FROM THE EDGE, which is the point. The obvious alternative is to carry depth on the run's
		 * `ctx` or its task payload — but those are channels a caller writes, and a fact the caller can
		 * set is not a control: a child would claim depth 0 and the rule would evaporate. The edge is
		 * written by this plugin, keyed on the child's own run id, and nothing outside can forge one.
		 *
		 * ABSENT, not zero, for a run that is nobody's child. A policy guards on
		 * `context.facts has "subagents.agentDepth"` and that reads as "is this a subagent at all" —
		 * where a defaulted 0 would make every run in the deployment look like one.
		 */
		runFacts: async ({
			runId,
		}): Promise<Record<string, string | number | boolean>> => {
			const edge = await requireWired().store.edge(runId);
			if (edge === null) return {};
			return {
				agentDepth: edge.depth,
				// The subtree this run belongs to, so a policy can scope a rule to one delegation rather
				// than to subagents in general.
				agentRoot: edge.rootRunId,
			};
		},
		// STATIC, like the capability map and for the same reason: sinks are read off the raw plugin
		// before `configure` runs. It closes over `wired`, which `configure` fills — and it is only ever
		// called at runtime, by which time it is set.
		eventSinks: [
			{
				emit: async (event: { type: string; runId?: string }) => {
					// A claw with no database never wired this plugin, so there is nothing to record into
					// and nothing to wake. Silent rather than loud: a sink that throws is warned and
					// dropped, and this one would do it on every event of every run.
					if (wired === undefined) return;
					await onRunEvent({
						store: wired.store,
						engine: wired.engine(),
						...(wired.checkpoints !== undefined
							? { checkpoints: wired.checkpoints }
							: {}),
						event: event as { type: string; runId?: string },
						now: now(),
					});
				},
			},
		],
		api: () =>
			({
				agents: buildAgentsApi({
					engine: () => requireWired().engine(),
					threads: () => requireWired().threads,
					store: () => requireWired().store,
					limits,
					joinTimeoutMs,
					now,
				}),
			}) as never,
		configure(context: BusyclawPluginConfigureContext) {
			const adapter = context.adapter;
			if (adapter === undefined) {
				throw configurationError("subagents() requires a database", {
					reason: "a child's edge is a row; there is nowhere to write one",
				});
			}
			const resolveEngine = context.engine;
			if (resolveEngine === undefined) {
				throw configurationError("subagents() requires an engine", {
					reason:
						"a child is a durable run; a claw with no engine has nowhere to put one",
				});
			}
			// THE THUNK IS STORED, NOT CALLED. The handle does not exist yet — the runtime is built
			// from these plugins and the engine from that runtime — so this resolves at spawn time,
			// long after assembly finished.
			const threads = context.clawsStore?.threads;
			if (threads === undefined) {
				throw configurationError("subagents() requires a claws store", {
					reason:
						"a child gets its own thread so its answer is readable; without one there is nowhere to open it",
				});
			}
			wired = {
				engine: () => resolveEngine() as SpawnEngine & JoinEngine,
				threads: threads as SpawnThreads,
				// OPTIONAL, both of them, and they degrade to different things. Without `messages` a join
				// returns outcomes but no text; without `checkpoints` a wait that the sink never armed
				// cannot be woken by the reconciler either, because neither knows where the parent parked.
				...(context.clawsStore?.messages !== undefined
					? { messages: context.clawsStore.messages as SpawnMessages }
					: {}),
				...(context.clawsStore?.checkpoints !== undefined
					? { checkpoints: context.clawsStore.checkpoints as JoinCheckpoints }
					: {}),
				store: createSubagentStore(adapter),
			};
			return {
				// THE AUTHORITATIVE PASS. Registered here rather than statically because it is the runtime
				// half — and it must run, on some schedule, on any deployment where a parent can wait: it
				// is the only thing that ever learns a child failed.
				cron: [
					{
						id: "subagents.reconcile",
						handler: async (ctx: BusyclawCronContext) => {
							const bound = requireWired();
							const report = await reconcileJoins({
								store: bound.store,
								engine: bound.engine(),
								...(bound.checkpoints !== undefined
									? { checkpoints: bound.checkpoints }
									: {}),
								limit: ctx.limit ?? reconcileBatch,
								now: now(),
							});
							return {
								processed: report.examined,
								// `limit` says "there was more waiting" — the caller's cue to tick again rather
								// than wait a whole interval. A full batch that reported `processed` would look
								// identical to a quiet one that happened to fill.
								status:
									report.deferred > 0
										? "limit"
										: report.examined === 0
											? "idle"
											: "processed",
								data: report,
							};
						},
					},
				],
			};
		},
	};
}

/** Read the capability the runtime injected, or say plainly that it did not. */
function capabilityFrom(options: unknown): AgentCapability {
	const injected = (options as Record<string, unknown> | undefined)?.[
		AGENT_CAPABILITY
	];
	if (injected === undefined) {
		throw configurationError(
			"the agent capability was not injected into this tool",
			{
				reason: "the tool's `capability` stamp and the plugin's name disagree",
			},
		);
	}
	return injected as AgentCapability;
}
