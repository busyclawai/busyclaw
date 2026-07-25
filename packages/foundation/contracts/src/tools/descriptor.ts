// The canonical tool DESCRIPTOR — the single shape "a tool" has in euroclaw, whatever produced it:
// a host's `tool()`, an adopted vendor tool (`govern()`), or a stored registry row. Two properties
// earn it its keep.
//
// GOVERNANCE IS FIRST-CLASS, not a passenger inside a framework type. The AI-SDK `ToolSet` erases
// every field it doesn't know, which is why the runtime used to re-validate the stamp with arktype
// on EVERY call — laundering a type-erased field back into a trusted one. With governance in the
// type, the model-facing `ToolSet` becomes a derived PROJECTION and the framework type stops being
// load-bearing for trust; arktype stays at the two REAL boundaries (a host hands us a descriptor,
// storage loads a row).
//
// INVOCATION IS TAGGED, because it names a line SSOT cannot erase. A `binding` is declarative data:
// it survives a restart as a row, and what it reaches on the network is describable (and therefore
// floorable). A `local` closure is opaque in-process code that can `fetch()` anywhere and cannot be
// stored at all. The honest boundary is tools-defined-in-code vs tools-registered-as-data, so the
// descriptor NAMES it rather than pretending every tool is data.
//
// Vendor-neutral by construction — contracts never imports `ai`, so the schema and the executable
// ride as type parameters each adapter narrows.

import type { ToolGovernance } from "../govern";

/** Whether a tool sits in the model's context window from the first step (`always`) or is reached
 *  through discovery (`discoverable`). CONTEXT-WINDOW policy, NEVER an access decision: a model can
 *  emit a name it was never shown and a resumed run can carry a stale toolset, so the floor still
 *  decides at call time — a hidden tool is not an ungranted one. */
export type ToolPresence = "always" | "discoverable";

/** The widest function type: every vendor's execute signature is assignable to it (its parameters
 *  are `never`), and the runtime owns the calling convention — it injects capabilities like
 *  `subInvoke` through its own blessed seam, so the descriptor deliberately types neither. */
export type ToolExecute = (...args: never[]) => unknown;

/**
 * How a tool is actually run. The tag is the line SSOT cannot erase (see the module header).
 *
 * A `binding` still carries an executor today because the row → executable step happens where the
 * per-run credentials and turn context live (the registered-tool provider). What matters is that
 * the DECLARATIVE binding rides along in the descriptor instead of vanishing into a closure — the
 * egress slice is what moves the execution itself behind the tag.
 */
export type ToolInvocation<
	Binding = unknown,
	Execute extends ToolExecute = ToolExecute,
> =
	| {
			kind: "binding";
			/** The source format that owns the binding's shape ("openapi"). */
			provider: string;
			/** Declarative invocation data — storable as a row, describable to the egress floor. */
			binding: Binding;
			/** The provider's executor, bound to this binding. */
			execute: Execute;
	  }
	| {
			kind: "local";
			/** An in-process closure. Un-storable, and its outbound reach is undescribed. */
			execute: Execute;
	  };

/** The canonical descriptor. Everything else about a tool — the AI-SDK `ToolSet` the model sees,
 *  the authz action, the catalog entry — is DERIVED from this, never the other way round. */
export type ToolDescriptor<
	InputSchema = unknown,
	Invocation extends ToolInvocation = ToolInvocation,
> = {
	/** The canonical id — `docs.admin.publish`. The model-facing NAME is a derived, flattened
	 *  projection of it (providers reject dots), and grants enumerate paths explicitly: a `docs.*`
	 *  prefix grant would silently widen the day someone merges a tool under it. */
	path: string;
	description?: string;
	presence: ToolPresence;
	/** Stated ONCE and read three ways: the JSON Schema the provider sees, the runtime validator,
	 *  and the authz projection. */
	inputSchema: InputSchema;
	/** The declared response shape. Enforcement is ASYMMETRIC across the tag — a `local` tool's
	 *  output is our own trusted code (typing and docs, never validated, the same ruling
	 *  `endpoints()` output already carries), a `binding` tool's is a third-party response flowing
	 *  straight into the context window, which is a real boundary. Neither is wired yet: the
	 *  shaping pass belongs with the binding-output slice. */
	outputSchema?: unknown;
	/** FACTS about the tool — does it write, what does it act on, what does it cost to undo. Never
	 *  posture: "may this agent do this" is policy, decided against these facts. */
	governance: ToolGovernance;
	invocation: Invocation;
};

/** A descriptor before it has an address — what an authoring helper (`tool()`, `govern()`) returns.
 *  The record key it is placed under supplies the `path`: flat today (key === path); nested records
 *  flatten into dotted paths when plugins ship tools. */
export type ToolDefinition<
	InputSchema = unknown,
	Invocation extends ToolInvocation = ToolInvocation,
> = Omit<ToolDescriptor<InputSchema, Invocation>, "path">;

/** What the authoring surfaces speak (`RuntimeConfig.tools`, a run's resolved tools): name → definition. */
export type ToolDefinitionSet = Record<string, ToolDefinition>;

/** Address a set of definitions — the one place a key becomes a `path`. Flat today; the nested-record
 *  flattening (`{ admin: { publish } }` → `admin.publish`) plugs in HERE when plugins ship tools. */
export function toolDescriptors(tools: ToolDefinitionSet): ToolDescriptor[] {
	return Object.entries(tools).map(([name, definition]) => ({
		...definition,
		path: name,
	}));
}
