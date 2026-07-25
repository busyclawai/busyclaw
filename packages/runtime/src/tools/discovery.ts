// `presence: "discoverable"`, made real: a tool that is NOT in the model's toolset, reached instead
// through two meta-tools in the reserved `euroclaw__` namespace — `search` (what is there, and what
// does it take) and `execute` (run the one you found, by its canonical path).
//
// DELIBERATELY NOT per-step toolset re-resolution. The alternative design is search-THEN-LOAD: a
// found tool joins the offered toolset and the model calls it directly the next step. That needs the
// toolset to change BETWEEN steps, which is a run-loop change, and it buys one thing — the provider
// validating the args against the target's own schema. Call-by-path keeps the toolset static: the
// run offers always-tools plus these two, start to finish. Search hands back the input schema so the
// model can still construct a correct call; the cost is that the provider edge cannot check it.
//
// THE CONSTRAINT THIS FILE EXISTS TO SATISFY: `execute` must never become the thing governance
// decides on. If the floor decided on "execute", one permit would unlock every discoverable tool at
// once. So `execute` is not really a tool at all — it is a second WIRE ENCODING of a tool call, and
// the run loop's tool-call ingress unwraps it exactly where it already translates the flattened wire
// name back to a path (see `modelToolProjection`). Past that line nothing knows the call arrived
// wrapped: the floor decision, the per-tool gate, the approval checkpoint, the effect claim, the
// audit and the transcript all read the TARGET's canonical path. The `execute` descriptor below
// carries no `access` fact (so it is not a modeled action) and its `execute` throws — being
// dispatched at all means the ingress did not unwrap, which is a fail-closed condition, not a call.

import {
	EUROCLAW_TOOL_NAMESPACE,
	stateError,
	type ToolDefinition,
	type ToolDefinitionSet,
	toolDescriptors,
	toolModelName,
} from "@euroclaw/contracts";
import { asSchema, jsonSchema } from "ai";
import { createToolCatalog, toolEntriesFromTools } from "../catalog";

/** Search discoverable tools. `euroclaw__search` on the wire. */
export const SEARCH_TOOL_PATH = `${EUROCLAW_TOOL_NAMESPACE}.search`;
/** Run a discoverable tool by its canonical path. `euroclaw__execute` on the wire. */
export const EXECUTE_TOOL_PATH = `${EUROCLAW_TOOL_NAMESPACE}.execute`;

/** The paths euroclaw's own tools occupy — what a host tool or a registered row may not claim. */
export const DISCOVERY_TOOL_PATHS: readonly string[] = [
	SEARCH_TOOL_PATH,
	EXECUTE_TOOL_PATH,
];

/** How many matches one search returns by default. Enough to choose from, small enough that a
 *  vague query doesn't refill the context window it exists to protect. */
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 25;

const SEARCH_DESCRIPTION =
	"Find tools that are available to you but not listed above. Describe what you want to do " +
	"(e.g. 'publish a document', 'list github issues') and this returns matching tools with their " +
	"canonical path, what they do, and the JSON Schema of their arguments. Run one with " +
	`${toolModelName(EXECUTE_TOOL_PATH)}.`;

const EXECUTE_DESCRIPTION =
	"Run a tool you found with search, by its canonical path. Pass the tool's own arguments as " +
	"`args`, shaped by the input schema the search result gave you. The tool is authorized, " +
	"executed and recorded exactly as if it were listed above — so a denial here is a real " +
	"denial, not a call that needs rephrasing.";

/** One search hit: what the model needs to construct a call, and nothing else. */
type DiscoveredTool = {
	path: string;
	description: string | undefined;
	inputSchema: unknown;
};

/**
 * The JSON Schema of a descriptor's input, for a model to read. The descriptor keeps the schema as
 * an opaque type parameter (contracts is vendor-neutral and never imports `ai`), so this is the one
 * place it is read back as the AI SDK's flexible schema — the SAME conversion the provider edge
 * applies to the very same value when a tool IS offered, which is what makes a search result and an
 * offered tool describe the target identically.
 */
function inputJsonSchema(schema: unknown): unknown {
	return asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema;
}

/** The discoverable half of a run's tools — the set `search` searches and `execute` addresses. */
function discoverableTools(tools: ToolDefinitionSet): ToolDefinitionSet {
	return Object.fromEntries(
		Object.entries(tools).filter(
			([, definition]) => definition.presence === "discoverable",
		),
	);
}

function searchTool(discoverable: ToolDefinitionSet): ToolDefinition {
	// The catalog is the read-path euroclaw already has over tools — a lexical, schema-lazy index
	// with a coverage gate. Built over the discoverable subset only: an always-tool is in the
	// context window already, so returning it would spend context re-describing what the model can
	// see. Schemas come from the descriptors beside it, because catalog summaries drop them.
	const catalog = createToolCatalog(toolEntriesFromTools(discoverable));
	const byPath = new Map(
		toolDescriptors(discoverable).map((descriptor) => [
			descriptor.path,
			descriptor,
		]),
	);
	return {
		description: SEARCH_DESCRIPTION,
		presence: "always",
		inputSchema: jsonSchema<{ query: string; limit?: number }>({
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"What you are trying to do, in words. Matched against tool paths, names and descriptions.",
				},
				limit: {
					type: "number",
					description: `Maximum matches to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
				},
			},
			required: ["query"],
		}),
		// VISIBILITY, not authorization — the same rule the catalog carries. No `access` fact, so the
		// floor does not model this as an action: enumerating what exists is not doing any of it.
		//
		// Results MAY be filtered one day (don't offer what the caller plainly cannot call — it wastes
		// context and invites denied attempts), and that would be a UX nicety, never enforcement. The
		// floor still decides at execute time: a tool absent from these results must not be
		// unreachable BECAUSE it was hidden, and a tool present in them must not be callable BECAUSE
		// it was shown. Nothing here is filtered today — a filter would have to pre-evaluate policy,
		// and the turn context a decision needs does not cross the tool-execute boundary.
		governance: { effect: { kind: "internal", output: "none", risk: "low" } },
		invocation: {
			kind: "local",
			execute: (input: { query: string; limit?: number }) => {
				const limit = Math.min(
					Math.max(Math.trunc(input.limit ?? DEFAULT_SEARCH_LIMIT), 1),
					MAX_SEARCH_LIMIT,
				);
				const tools: DiscoveredTool[] = [];
				for (const summary of catalog.search(input.query, { limit })) {
					const descriptor = byPath.get(summary.address);
					if (!descriptor) continue;
					tools.push({
						path: descriptor.path,
						description: descriptor.description,
						inputSchema: inputJsonSchema(descriptor.inputSchema),
					});
				}
				return { tools };
			},
		},
	};
}

function executeTool(): ToolDefinition {
	return {
		description: EXECUTE_DESCRIPTION,
		presence: "always",
		inputSchema: jsonSchema<{ path: string; args?: Record<string, unknown> }>({
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"The canonical path of the tool to run, exactly as a search result gave it (e.g. `docs.admin.publish`).",
				},
				args: {
					type: "object",
					description:
						"The target tool's own arguments, matching the input schema from its search result.",
					additionalProperties: true,
				},
			},
			required: ["path"],
		}),
		// No `access` fact ON PURPOSE: the floor must not model this as an action. What gets decided
		// is the TARGET, resolved at ingress — a policy that could permit "execute" would be a permit
		// for everything reachable through it.
		governance: {},
		invocation: {
			kind: "local",
			execute: () => {
				// Unreachable through a well-formed call: the ingress rewrites it to its target before
				// anything dispatches. Getting here means the envelope named no usable target (or
				// named this tool), so there is nothing to authorize — fail closed rather than
				// invent one.
				throw stateError(
					`${EXECUTE_TOOL_PATH} needs the canonical \`path\` of a tool available in this run`,
					{ toolName: EXECUTE_TOOL_PATH },
				);
			},
		},
	};
}

/**
 * The meta-tools for a run's tool set — EMPTY when nothing in it is discoverable, so a host that
 * ships none sees no new tools, no new wire names, and no behaviour change at all.
 */
export function discoveryTools(tools: ToolDefinitionSet): ToolDefinitionSet {
	const discoverable = discoverableTools(tools);
	if (Object.keys(discoverable).length === 0) return {};
	return {
		[SEARCH_TOOL_PATH]: searchTool(discoverable),
		[EXECUTE_TOOL_PATH]: executeTool(),
	};
}

/**
 * Read an `execute` envelope: the target path and the args the target itself receives. `null` when
 * the envelope names no usable target — the call then stays on the meta-tool, whose executable fails
 * closed. Deliberately total and permissive about the ARGS (an absent `args` is an empty record):
 * shaping a target's own input is the target's business, and `handleToolCall` re-validates the call
 * at the chokepoint like any other.
 */
export function readExecuteEnvelope(
	input: unknown,
): { path: string; args: unknown } | null {
	if (input === null || typeof input !== "object") return null;
	const envelope = input as { path?: unknown; args?: unknown };
	if (typeof envelope.path !== "string" || envelope.path === "") return null;
	// Addressing the meta-tools THROUGH the meta-tool resolves to nothing: unwrapping once and
	// landing back here would either loop or dispatch a router as if it were a tool.
	if (envelope.path === EXECUTE_TOOL_PATH) return null;
	return { path: envelope.path, args: envelope.args ?? {} };
}
