// Tool-dispatch glue the model loop depends on: reading the govern() stamp (a real trust
// boundary — the AI-SDK ToolSet type ERASES the euroclaw field, so the contracts schema validates
// what a host attached), registering per-tool gates on the governance core, and stripping
// governance/execute off a tool before it reaches the model.

import {
	type ToolGovernance,
	toolGovernance as toolGovernanceSchema,
	validationError,
} from "@euroclaw/contracts";
import type { Governance } from "@euroclaw/core";
import type { ToolSet } from "ai";
import { type } from "arktype";

/**
 * Read the governance stamp `govern()` attached to a tool. A malformed stamp (typo'd idempotency,
 * wrong risk value) must fail loud here, not fail OPEN downstream where a misspelled "none" would
 * silently make an effect auto-retryable.
 */
export function toolGovernance(
	tool: object,
	name: string,
): ToolGovernance | undefined {
	if (!("euroclaw" in tool) || tool.euroclaw === undefined) return undefined;
	const stamp = toolGovernanceSchema(tool.euroclaw);
	if (stamp instanceof type.errors) {
		throw validationError(
			`tool "${name}" carries an invalid governance stamp`,
			stamp.summary,
		);
	}
	return stamp;
}

export function registerToolGates(core: Governance, tools: ToolSet): void {
	for (const [name, tool] of Object.entries(tools)) {
		const gate = toolGovernance(tool, name)?.gate;
		if (gate) {
			core.registerGate({
				id: `tool:${name}`,
				matcher: (call) => call.name === name,
				handler: gate,
			});
		}
	}
}

export function modelFacingTools(tools: ToolSet): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, tool]) => {
			// The ToolSet type erases the `euroclaw` stamp, so widen just enough to strip it — the
			// rest of the tool keeps its type (the outer cast only bridges fromEntries' widening).
			const {
				euroclaw: _euroclaw,
				execute: _execute,
				...rest
			} = tool as ToolSet[string] & { euroclaw?: unknown };
			return [name, rest];
		}),
	) as ToolSet;
}
