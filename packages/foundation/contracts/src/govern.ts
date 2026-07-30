// The per-tool governance CONTRACT (a port). Generic and runtime-free: `govern` pairs a governance
// stamp with a tool-like object — it never runs a tool or imports a framework. Each adapter (the AI
// SDK claw, a future LangChain adapter, …) provides the IMPLEMENTATION: it reads the descriptor's
// first-class `governance` field and wires the gate into the pipeline. Contract here, impl there.
//
// The stamp's data shape is an arktype schema, not a plain type, because governance also arrives
// from places the compiler cannot check: a storage row, a spec extractor, an untyped host. That is
// where the schema runs. It no longer runs per CALL — the descriptor keeps governance as a typed
// field instead of a passenger inside a type-erasing framework type. A typo'd effect policy would
// fail OPEN (idempotency "nonee" ≠ "none" → the effect gets auto-retried), so the boundaries that
// do read untyped governance fail loud through this schema.

import { configurationError } from "@busyclaw/errors";
import { type } from "arktype";
import { effectCompensation } from "./effects";
import type {
	GateDecision,
	ToolCall,
	TurnContext,
} from "./governance/boundary";
import type {
	ToolDefinition,
	ToolExecute,
	ToolPresence,
} from "./tools/descriptor";

export const toolEffectPolicy = type({
	"kind?": "'internal' | 'external'",
	"idempotency?": "'none' | 'optional' | 'required'",
	// What durable effect tracking may persist for retries. Default: redacted;
	// idempotency "none" defaults to none.
	"output?": "'none' | 'redacted' | 'full'",
	"compensation?": effectCompensation,
	"risk?": "'low' | 'medium' | 'high'",
});
export type ToolEffectPolicy = typeof toolEffectPolicy.infer;

/** A before-gate scoped to one tool: permit / deny / needs-approval. The signature is
 *  TS-only (params/returns are uncheckable at runtime); governance validates the gate's
 *  RESULT (`gateDecision`) every time it runs. */
export type ToolGate = (
	call: ToolCall,
	ctx: TurnContext,
) => GateDecision | Promise<GateDecision>;

/** Governance attached to a single tool — the contract an adapter reads back. Besides the gate
 *  and effect policy, the stamp carries the authorization-model FACTS (`ActionDef` fields) for
 *  hand-authored tools — what the OpenAPI/MCP generators derive from specs, an author declares
 *  here. Facts, never posture: "may the agent do this" is policy, not a tool attribute. */
export const toolGovernance = type({
	// Runtime checks callable-ness; the precise signature is the TS-level ToolGate.
	"gate?": type("Function").as<ToolGate>(),
	"effect?": toolEffectPolicy,
	// This tool's execute receives a `subInvoke` for governed nested tool calls
	// (capability tools: sandboxes, delegate). Least-authority: absent = no invoker.
	"invoker?": "true",
	// ── authz-model facts (see src/authz/model.ts) ──
	// Does this tool mutate state? Absent = "write" in the model (fail-closed under seeded
	// policies). Named `access`, not `risk` — `effect.risk` is a different axis.
	"access?": "'read' | 'write'",
	// Action groups the model places this tool's action in (`action in Action::"<group>"`).
	"groups?": "string[]",
	// The resource entity type this tool acts on (Cedar `resource` type). Default "Tool".
	"resource?": "string",
	// WHERE this tool reaches, when the destination is an ARGUMENT rather than a fixed binding.
	//
	// A registered OpenAPI operation declares one server, so `context.server` is a property of which
	// action it is. A tool whose whole purpose is to reach somewhere the caller names — a governed
	// fetch, an HTTP tool, an MCP proxy — has a different destination per call, and an action-keyed
	// lookup cannot answer for it: it returns one origin for every call, or none. This names the
	// argument the origin is read out of, so the floor can stamp the SAME `context.server` fact for
	// both kinds and one egress policy governs them together.
	//
	// A FACT, like everything else here: it says where the tool goes, never who may send it there.
	// And it is a fact about the TOOL, declared by whoever wrote it — the value still arrives as a
	// call argument, but which argument carries a destination is not the caller's to decide.
	"destination?": { arg: "string" },
	// Force an audit record even when the action's verb isn't otherwise audited.
	"audit?": "boolean",
});
export type ToolGovernance = typeof toolGovernance.infer;

/**
 * ADOPT a tool you did not author: `govern(tool, { gate })` reads its model-facing definition and
 * pairs it with governance, producing the canonical {@link ToolDefinition}. Structural, never
 * framework-coupled — this names the four fields every vendor's tool has and nothing else, so an
 * AI-SDK tool, an MCP tool, and a hand-written object all adopt identically.
 *
 * Vendor-EXOTIC fields (streaming hooks, provider-defined tool markers) are NOT carried across: a
 * descriptor is vendor-neutral, and a passthrough for them has no consumer yet.
 *
 * A STATIC description is mandatory — it is the tool's only interface to the model, and catalog
 * search has nothing else to match on. The vendor's own type cannot promise one (the AI SDK marks
 * it optional and allows a per-call description FUNCTION), so this is the boundary that enforces it:
 * fail loud here rather than ship a tool the model cannot understand. Restate it explicitly
 * (`govern({ ...vendorTool, description }, …)`) when the vendor computes its own.
 *
 * `presence` rides in `options` and is left ABSENT when unstated — the door the tool is handed to
 * then applies its own default (host `tools` → `always`, `plugin.tools` → `discoverable`). Stating a
 * default here would silently make one of those two doors wrong.
 */
export function govern<InputSchema, Execute extends ToolExecute>(
	tool: {
		description?: string | ((...args: never[]) => string);
		inputSchema: InputSchema;
		outputSchema?: unknown;
		execute: Execute;
	},
	governance: ToolGovernance,
	options?: { presence?: ToolPresence },
): ToolDefinition<InputSchema, { kind: "local"; execute: Execute }> {
	if (typeof tool.description !== "string" || tool.description === "") {
		throw configurationError(
			"a governed tool needs a static description — the model has no other way to know what it does",
		);
	}
	return {
		description: tool.description,
		...(tool.outputSchema !== undefined
			? { outputSchema: tool.outputSchema }
			: {}),
		...(options?.presence !== undefined ? { presence: options.presence } : {}),
		inputSchema: tool.inputSchema,
		governance,
		invocation: { kind: "local", execute: tool.execute },
	};
}
