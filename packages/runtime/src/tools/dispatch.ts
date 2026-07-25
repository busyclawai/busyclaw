// Tool-dispatch glue the model loop depends on: registering each descriptor's gate on the
// governance core, and DERIVING the model-facing AI-SDK ToolSet the provider is sent.
//
// There is no stamp to read back any more. Governance used to ride inside the AI-SDK `ToolSet`,
// which erases unknown fields, so the runtime re-validated it with arktype on EVERY call — a
// type-erased field laundered back into a trusted one. Descriptors carry governance as a typed
// field, so that reader is gone; arktype now runs only where governance genuinely arrives untyped
// (storage rows, spec extraction).

import type { ToolDefinition, ToolDefinitionSet } from "@euroclaw/contracts";
import type { Governance } from "@euroclaw/core";
import type { ToolSet } from "ai";

/** The one calling convention the chokepoint uses: model args, then the AI-SDK call options plus
 *  euroclaw's own `subInvoke` extension. Deliberately loose — the runtime, not the vendor, owns it. */
export type ToolExecutable = (input: unknown, options: unknown) => unknown;

/**
 * The executable behind a descriptor's invocation — BOTH tags carry one (a `binding` tool's is the
 * invoker the provider bound to its row). The descriptor types it as the widest possible function
 * so any vendor's signature is assignable; this is the single place that narrows it back to the
 * runtime's convention. `undefined` when what arrived is not callable at all.
 */
export function toolExecutor(tool: ToolDefinition): ToolExecutable | undefined {
	const execute = tool.invocation.execute;
	return typeof execute === "function"
		? (execute as ToolExecutable)
		: undefined;
}

export function registerToolGates(
	core: Governance,
	tools: ToolDefinitionSet,
): void {
	for (const [name, tool] of Object.entries(tools)) {
		const gate = tool.governance.gate;
		if (gate) {
			core.registerGate({
				id: `tool:${name}`,
				matcher: (call) => call.name === name,
				handler: gate,
			});
		}
	}
}

/**
 * The model-facing projection: descriptors → the AI-SDK `ToolSet` the provider is sent. An
 * ALLOWLIST, not a strip-list — whatever else a descriptor carries (an HTTP binding, the
 * executable, the governance facts) cannot reach the model by being forgotten here. The tools
 * carry no `execute`: the AI SDK only reports the calls, the governance chokepoint runs them.
 */
export function modelFacingTools(tools: ToolDefinitionSet): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, tool]) => [
			name,
			{
				...(tool.description !== undefined
					? { description: tool.description }
					: {}),
				inputSchema: tool.inputSchema,
			},
		]),
		// fromEntries widens to Record<string, {…}>; the entries above ARE a ToolSet's shape.
	) as ToolSet;
}
