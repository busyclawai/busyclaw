// The canonical tool DESCRIPTOR — the single shape "a tool" has in busyclaw, whatever produced it:
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

/** The canonical path separator — the same one the catalog splits an address on to derive its tree. */
const PATH_SEPARATOR = ".";
/** The model-facing name separator. Providers accept `[A-Za-z0-9_-]` only, so the dotted path is
 *  projected onto `__` — the same reserved-namespace marker busyclaw's context keys use. */
const NAME_SEPARATOR = "__";

/** Whether a tool sits in the model's context window from the first step (`always`) or is reached
 *  through discovery (`discoverable`). CONTEXT-WINDOW policy, NEVER an access decision: a model can
 *  emit a name it was never shown and a resumed run can carry a stale toolset, so the floor still
 *  decides at call time — a hidden tool is not an ungranted one. */
export type ToolPresence = "always" | "discoverable";

/** The reserved namespace busyclaw's own tools live in — the discovery meta-tools root here, so
 *  their paths (`busyclaw.search`) project onto the `busyclaw__` prefix the context keys already
 *  reserve. A host or plugin tool landing on one of these paths fails loud where they are minted. */
export const BUSYCLAW_TOOL_NAMESPACE = "busyclaw";

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
	/** Absent means the AUTHOR did not say, and the door the tool arrives through decides: a host's
	 *  hand-curated `tools` are `always` (a list written deliberately, one tool at a time), a
	 *  plugin's are `discoverable` (a plugin can ship fifty at zero context cost). Two defaults,
	 *  because the intent behind the two surfaces is genuinely different — stating it here would
	 *  make one of them a lie. */
	presence?: ToolPresence;
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
	/**
	 * The content hash of a DATA-BACKED tool — the version of the row this descriptor was built from.
	 *
	 * Present only for tools that exist as data (a registered OpenAPI operation), because only those
	 * can change underneath a pending approval: the address survives a re-registration while the path,
	 * schema and governance behind it do not. An approval records the version it was granted against
	 * and a resume refuses a mismatch.
	 *
	 * Absent for a code tool. A host closure has no version to take, and inventing one — hashing a
	 * function, say — would report drift it cannot actually see.
	 */
	contentVersion?: string;
};

/** A descriptor before it has an address — what an authoring helper (`tool()`, `govern()`) returns.
 *  The record key it is placed under supplies the `path`; a nested record is flattened into that key
 *  by the addressing pass ({@link flattenToolTree}) first. A definition never carries its own path:
 *  one id, one place to read it. */
export type ToolDefinition<
	InputSchema = unknown,
	Invocation extends ToolInvocation = ToolInvocation,
> = Omit<ToolDescriptor<InputSchema, Invocation>, "path">;

/** What the authoring surfaces speak (`RuntimeConfig.tools`, a run's resolved tools, a plugin's
 *  assembled tools): PATH → definition. The key is the canonical id — the Cedar action, the catalog
 *  address, what dispatch looks up, what the audit records. The model-facing NAME is derived from it
 *  ({@link toolModelName}) at the provider edge and nowhere else. */
export type ToolDefinitionSet = Record<string, ToolDefinition>;

/** Tool declarations, optionally GROUPED: a nested record is a group whose key becomes a path
 *  segment — the same shape `endpoints()` gives api namespaces, so there is one nesting convention
 *  across the plugin surface rather than two. */
export type ToolTree = {
	readonly [name: string]: ToolDefinition | ToolTree;
};

/** One addressed tool: its canonical dotted `path`, the model-facing `name` derived from it, and the
 *  definition that was addressed. */
export type AddressedTool = {
	name: string;
	path: string;
	definition: ToolDefinition;
};

/**
 * The model-facing NAME of a path — the derived projection, never the canonical id. Providers reject
 * dots in a tool name, so `docs.admin.publish` is offered as `docs__admin__publish`. The path is what
 * policy and grants enumerate; the name is only what the wire accepts, and it exists nowhere inside
 * the runtime — the run loop translates it back at ingress.
 *
 * One-way ON ITS OWN: `docs__admin__publish` could equally be a flat tool literally named that, so
 * reversing it means indexing the set that was actually offered, never splitting on `__`. Two paths
 * that project onto one name is a collision the assembly fails loud on.
 */
export function toolModelName(path: string): string {
	return path.split(PATH_SEPARATOR).join(NAME_SEPARATOR);
}

// A group can legally hold a member NAMED "invocation" — it would itself be a definition or a group,
// so its `kind` is not a string. Only the invocation TAG discriminates, the same total ruling
// `endpoints()` makes on a callable `handler`.
function isToolDefinition(
	value: ToolDefinition | ToolTree,
): value is ToolDefinition {
	const invocation = (value as { invocation?: { kind?: unknown } }).invocation;
	return typeof invocation?.kind === "string";
}

/**
 * Address a tree of definitions under `root` (a plugin's id): `{ search, admin: { publish } }` on
 * `docs` → `docs.search` and `docs.admin.publish`. The one place nesting becomes a path.
 *
 * Rooting is what keeps a plugin inside its own namespace — it cannot address a tool anywhere else,
 * so plugin-vs-plugin collisions are structural rather than a matter of naming discipline.
 */
export function flattenToolTree(root: string, tree: ToolTree): AddressedTool[] {
	const addressed: AddressedTool[] = [];
	const walk = (node: ToolTree, segments: readonly string[]): void => {
		for (const [key, value] of Object.entries(node)) {
			const next = [...segments, key];
			if (isToolDefinition(value)) {
				const path = next.join(PATH_SEPARATOR);
				addressed.push({
					name: toolModelName(path),
					path,
					definition: value,
				});
				continue;
			}
			walk(value, next);
		}
	};
	walk(tree, [root]);
	return addressed;
}

/** Lift a set into descriptors — the key IS the path, so this only makes the canonical id explicit
 *  on the shape (`ToolDescriptor` requires it; `ToolDefinition` deliberately cannot carry it). */
export function toolDescriptors(tools: ToolDefinitionSet): ToolDescriptor[] {
	return Object.entries(tools).map(([path, definition]) => ({
		...definition,
		path,
	}));
}
