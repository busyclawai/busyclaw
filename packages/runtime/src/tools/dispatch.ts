// Tool-dispatch glue the model loop depends on: registering each descriptor's gate on the
// governance core, and DERIVING the model-facing AI-SDK ToolSet the provider is sent — together
// with the inverse that turns a call's wire name back into the canonical path.
//
// There is no stamp to read back any more. Governance used to ride inside the AI-SDK `ToolSet`,
// which erases unknown fields, so the runtime re-validated it with arktype on EVERY call — a
// type-erased field laundered back into a trusted one. Descriptors carry governance as a typed
// field, so that reader is gone; arktype now runs only where governance genuinely arrives untyped
// (storage rows, spec extraction).

import type { ToolDefinition, ToolDefinitionSet } from "@euroclaw/contracts";
import { configurationError, toolModelName } from "@euroclaw/contracts";
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

/** A per-tool gate is keyed by the tool's PATH, which is what a call carries by the time it reaches
 *  the chokepoint — the loop translated the wire name away at ingress. */
export function registerToolGates(
	core: Governance,
	tools: ToolDefinitionSet,
): void {
	for (const [path, tool] of Object.entries(tools)) {
		const gate = tool.governance.gate;
		if (gate) {
			core.registerGate({
				id: `tool:${path}`,
				matcher: (call) => call.name === path,
				handler: gate,
			});
		}
	}
}

/** The two directions of the provider edge, built together (see {@link modelToolProjection}). */
export type ModelToolProjection = {
	/** What the provider is sent — keyed by the model-facing WIRE name. */
	readonly tools: ToolSet;
	/** wire name → canonical path: the ingress translation the run loop applies to every call. */
	readonly pathOf: (modelName: string) => string;
};

/**
 * The provider edge, both ways, from ONE pass over the descriptors — so the names a run offers and
 * the names it can resolve back can never drift apart.
 *
 * OUTBOUND, `tools` is an ALLOWLIST (description + inputSchema), not a strip-list: whatever else a
 * descriptor carries — an HTTP binding, the executable, the governance facts — cannot reach the
 * model by being forgotten here. They carry no `execute` either; the AI SDK only reports the calls,
 * the governance chokepoint runs them. Keys are the flattened wire names, because providers reject
 * dots in a tool name.
 *
 * INBOUND, `pathOf` is the inverse, and it has to be an INDEX: `docs__admin__publish` could equally
 * be a flat tool named exactly that, so splitting on `__` would guess. A name nothing offered passes
 * through unchanged — an unmodeled call stays unmodeled, which is the pre-existing skip at the
 * floor's matcher, never a permit.
 *
 * Two paths landing on one name FAIL LOUD here, because this is where the loss would happen: one of
 * them would simply not be offered, while the model calling that name would reach the other. Loud
 * because the set reaching here is CODE (the host's tools, plus the plugins' — assembled at
 * construction); a per-run registration is data a host does not control, so the merge upstream
 * skips-and-warns before ever building a projection.
 */
export function modelToolProjection(
	tools: ToolDefinitionSet,
): ModelToolProjection {
	const pathByModelName = new Map<string, string>();
	const projected: Record<string, unknown> = {};
	for (const [path, tool] of Object.entries(tools)) {
		const modelName = toolModelName(path);
		const owner = pathByModelName.get(modelName);
		if (owner !== undefined) {
			throw configurationError("duplicate model-facing tool name", {
				name: modelName,
				paths: [owner, path],
			});
		}
		pathByModelName.set(modelName, path);
		projected[modelName] = {
			...(tool.description !== undefined
				? { description: tool.description }
				: {}),
			inputSchema: tool.inputSchema,
		};
	}
	return {
		// The entries above ARE a ToolSet's shape; the record type only widened building them.
		tools: projected as ToolSet,
		pathOf: (modelName) => pathByModelName.get(modelName) ?? modelName,
	};
}
