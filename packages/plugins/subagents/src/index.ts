// subagents() — a run spawns child runs.
//
// One line of host wiring. The plugin owns two tables, registers one capability, and contributes two
// model-facing tools. Everything that decides anything is either a database row or the governance
// floor; nothing here holds authority of its own.

import type { BusyclawPlugin, CapabilityContext } from "@busyclaw/contracts";
import { configurationError, govern } from "@busyclaw/contracts";
import { jsonSchema, tool } from "ai";
import {
	type AgentCapability,
	createAgentCapability,
	type SpawnClawLike,
} from "./capability";
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
};

export type { AgentCapability, AgentChildStatus } from "./capability";
export {
	agentEdgeEntity,
	agentEdgeFields,
	agentLinkEntity,
	agentLinkFields,
	agentLinkId,
	childRunId,
	PARENT_ALIAS,
	subagentModels,
} from "./schema";
export type { AgentEdge, SubagentStore } from "./store";
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

export function subagents(config: SubagentsConfig = {}): BusyclawPlugin {
	const limits = {
		maxDepth: config.maxDepth ?? 3,
		maxChildren: config.maxChildren ?? 8,
	};
	// Filled by `configure`, read at CALL time. This is the binding the static-registration rule
	// exists for: the capability needs the assembled claw, which is being built around this plugin.
	let wired: { claw: () => SpawnClawLike; store: SubagentStore } | undefined;
	const now = () => new Date().toISOString();

	const capability = (ctx: CapabilityContext): AgentCapability => {
		if (wired === undefined) {
			throw configurationError("subagents() is not wired to a claw yet", {
				reason:
					"the plugin needs a database — `configure` never ran, so there is nowhere to record an edge",
			});
		}
		return createAgentCapability({
			ctx,
			claw: wired.claw(),
			store: wired.store,
			limits,
			now,
		});
	};

	return {
		id: "subagents",
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
					{ capability: AGENT_CAPABILITY, access: "read" },
				),
			},
		},
		configure(context) {
			const adapter = context.adapter;
			if (adapter === undefined) {
				throw configurationError("subagents() requires a database", {
					reason: "a child's edge is a row; there is nowhere to write one",
				});
			}
			const resolveClaw = context.claw;
			if (resolveClaw === undefined) {
				throw configurationError("subagents() needs the assembled claw", {
					reason:
						"a child is started through the governed api, not the engine — an engine start accepts a principal freely and runs no product-api decision",
				});
			}
			// THE THUNK IS STORED, NOT CALLED. Calling it here would read a claw that does not exist
			// yet; the capability calls it per tool call, long after assembly finished.
			wired = {
				claw: () => resolveClaw() as SpawnClawLike,
				store: createSubagentStore(adapter),
			};
			return undefined;
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
