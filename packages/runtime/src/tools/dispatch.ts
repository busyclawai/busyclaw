// Tool-dispatch glue the model loop depends on: registering each descriptor's gate on the
// governance core, and DERIVING the model-facing AI-SDK ToolSet the provider is sent — together
// with the inverse that turns a call's wire name back into the canonical path.
//
// There is no stamp to read back any more. Governance used to ride inside the AI-SDK `ToolSet`,
// which erases unknown fields, so the runtime re-validated it with arktype on EVERY call — a
// type-erased field laundered back into a trusted one. Descriptors carry governance as a typed
// field, so that reader is gone; arktype now runs only where governance genuinely arrives untyped
// (storage rows, spec extraction).

import type { ToolDefinition, ToolDefinitionSet } from "@busyclaw/contracts";
import {
	configurationError,
	stateError,
	toolModelName,
} from "@busyclaw/contracts";
import type { Governance } from "@busyclaw/core";
import type { ToolSet } from "ai";
import { EXECUTE_TOOL_PATH, readExecuteEnvelope } from "./discovery";

/** The one calling convention the chokepoint uses: model args, then the AI-SDK call options plus
 *  busyclaw's own `subInvoke` extension. Deliberately loose — the runtime, not the vendor, owns it. */
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

/** A tool call as everything past the provider edge speaks it: the canonical path, and the args the
 *  target itself receives. */
export type ResolvedToolCall = {
	path: string;
	args: unknown;
};

/** The two directions of the provider edge, built together (see {@link modelToolProjection}). */
export type ModelToolProjection = {
	/** What the provider is sent — keyed by the model-facing WIRE name. */
	readonly tools: ToolSet;
	/** The ingress translation the run loop applies to every call: whatever wire encoding the call
	 *  arrived in → the canonical path plus the target's own args. */
	readonly resolveCall: (call: {
		name: string;
		input: unknown;
	}) => ResolvedToolCall;
	/** Does this run have a tool at that canonical path? Includes the DISCOVERABLE half — hiding a
	 *  tool from the context window is UX, and must never become the reason a call it can legitimately
	 *  reach reads as nonexistent. The loop asks before the gate, so "no such tool" stays a distinct
	 *  answer from "not permitted". */
	readonly hasPath: (path: string) => boolean;
};

/**
 * The provider edge, both ways, from ONE pass over the descriptors — so the names a run offers and
 * the names it can resolve back can never drift apart.
 *
 * OUTBOUND, `tools` is an ALLOWLIST (description + inputSchema), not a strip-list: whatever else a
 * descriptor carries — an HTTP binding, the executable, the governance facts — cannot reach the
 * model by being forgotten here. They carry no `execute` either; the AI SDK only reports the calls,
 * the governance chokepoint runs them. Keys are the flattened wire names, because providers reject
 * dots in a tool name. A `discoverable` tool is left OUT of the offered set — that is the whole of
 * what presence does — but it is still INDEXED below, because hiding a tool from the context window
 * is UX and must never become the reason a call cannot be resolved and decided.
 *
 * INBOUND, `resolveCall` is the inverse, and it has to be an INDEX: `docs__admin__publish` could
 * equally be a flat tool named exactly that, so splitting on `__` would guess. A name nothing
 * declared passes through unchanged — an unmodeled call stays unmodeled, which is the pre-existing
 * skip at the floor's matcher, never a permit. It also unwraps the `execute` meta-tool, which is a
 * second wire ENCODING of a call rather than a tool: past this line the loop cannot tell a routed
 * call from a direct one, which is exactly why the floor decides on the target (see discovery.ts).
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
		if (tool.presence === "discoverable") continue;
		projected[modelName] = {
			...(tool.description !== undefined
				? { description: tool.description }
				: {}),
			inputSchema: tool.inputSchema,
		};
	}
	const paths = new Set(Object.keys(tools));
	return {
		// The entries above ARE a ToolSet's shape; the record type only widened building them.
		tools: projected as ToolSet,
		hasPath: (path) => paths.has(path),
		resolveCall: (call) => {
			const path = pathByModelName.get(call.name) ?? call.name;
			// Unwrapping happens only when THIS run's set actually contains the meta-tool — the same
			// index everything else resolves through, not a special-cased wire name. A run that never
			// minted it resolves `busyclaw__execute` to nothing, and the call fails closed at dispatch
			// like any other name nobody declared.
			if (path !== EXECUTE_TOOL_PATH) return { path, args: call.input };
			// An envelope that names no usable target is a broken ENCODING, not a call — so it is
			// refused here rather than passed on as a call to the meta-tool. It used to be passed on,
			// relying on the meta-tool's own executable to throw; that worked only while the floor
			// skipped unmodeled actions, because otherwise the gate reaches `busyclaw.execute` first
			// and answers a question this file exists to make sure is never asked. Refusing at the
			// ingress keeps `execute` out of every decision, and keeps the diagnostic — "you named no
			// target" is a different fact from "you may not do that", and the model needs the first.
			const envelope = readExecuteEnvelope(call.input);
			if (envelope === null) {
				throw stateError(
					`${EXECUTE_TOOL_PATH} needs the canonical \`path\` of a tool available in this run`,
					{ toolName: EXECUTE_TOOL_PATH },
				);
			}
			return envelope;
		},
	};
}
