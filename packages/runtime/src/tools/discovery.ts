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
// audit and the transcript all read the TARGET's canonical path.
//
// HOW that constraint is held changed once the floor stopped skipping unmodeled calls. It used to
// rest on omission — the `execute` descriptor carried no `access` fact, so it was not a modeled
// action, so the floor's matcher passed it by. Omission now means WRITE, and a matcher that skips is
// exactly the hole that let an unstamped tool run ungoverned. So the guarantee moved to the ingress:
// `resolveCall` REFUSES an envelope it cannot unwrap, before any gate runs, and `buildFloorPolicyPlugin`
// leaves this one path out of the model. `execute` therefore never reaches a decision — neither as
// itself nor as a policy-nameable action.
//
// DISCLOSURE — what the floor would say about a hit — is answered THROUGH the chokepoint, not around
// it. The tempting symmetry is to answer `search` at that same ingress, beside the `execute` unwrap,
// but the two are different problems: unwrapping REWRITES an encoding and the call still goes on to
// be decided, while answering would take a tool call out of `handleToolCall` altogether — no gates,
// no audit row, a second door for the one thing this codebase keeps to one. The ingress has no
// advantage to offer either: what is in hand there is the RUN's context, not the DECISION's — the
// stamped principal and runMode are added by core's own resolution step, inside the door. So the
// runtime hands `search` a probe CAPABILITY at the execute boundary (the seam `subInvoke` already
// uses) and the search call stays an ordinary governed tool call.

import {
	EUROCLAW_TOOL_NAMESPACE,
	type Outcome,
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
	`${toolModelName(EXECUTE_TOOL_PATH)}. A result may carry an \`authorization\` hint — ` +
	"`available` (nothing objected), `needs-approval` (calling it pauses for a human), or " +
	"`conditional` (not permitted as a bare call — the arguments you pass may change that, so try " +
	"it if it fits), and `annotations` may carry a note the policy author wrote for you about what " +
	"to do instead. The hint is ADVISORY and may be stale: you are authorized when you call, never here.";

const EXECUTE_DESCRIPTION =
	"Run a tool you found with search, by its canonical path. Pass the tool's own arguments as " +
	"`args`, shaped by the input schema the search result gave you. The tool is authorized, " +
	"executed and recorded exactly as if it were listed above — so a denial here is a real " +
	"denial, not a call that needs rephrasing.";

/**
 * Ask what the governance floor would say about these tool paths, WITHOUT calling them — index-
 * aligned answers. Handed to the search meta-tool by the runtime (see runtime.ts), because a
 * decision needs the turn context and the turn context does not cross the tool-execute boundary.
 * Absent → search discloses nothing, which is exactly what it did before.
 */
export type ToolAccessProbe = (
	paths: readonly string[],
) => Promise<readonly Outcome[]>;

/**
 * What the floor would say about calling a tool — ADVISORY, never a grant and never a refusal:
 *
 *   - `available`      nothing objected to a bare call.
 *   - `needs-approval` it would park for a human; `annotations` may carry what the deciding rules'
 *                      author wrote FOR THE AGENT about it.
 *   - `conditional`    a bare call is not permitted, but this tool takes arguments and a policy may
 *                      condition on them, so the real call may well be. See {@link discloseTool}.
 *
 * A tool the probe could not decide at all carries NO hint — search states only what it can stand
 * behind. Disclosure is never enforcement: the floor decides again at execute, on the call as it
 * actually arrives, and that decision is the only one that governs.
 */
type ToolAuthorization = "available" | "needs-approval" | "conditional";

/** One search hit: what the model needs to construct a call, plus what the floor would say. */
type DiscoveredTool = {
	path: string;
	description: string | undefined;
	inputSchema: unknown;
	authorization?: ToolAuthorization;
	annotations?: Record<string, string>;
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

/**
 * Does this tool's DECLARED interface carry arguments a decision could read? The one question that
 * separates a probe we can stand behind from a guess: the probe asks with no arguments, so for a
 * tool that takes none, the request it asks about is byte-for-byte the request a real call makes —
 * every gate sees exactly what it would see, and the answer is the answer. The moment a tool
 * declares an argument, the real call can decide differently and a bare probe can only say "not as
 * asked". Two live mechanisms make that real: a per-tool GATE reading `call.args` (any tool), and a
 * Cedar `when { context.args… }` rule (REGISTERED tools — a code tool's action carries no `args`,
 * `actionInputsFromTools` leaves it undefined deliberately, so such a rule errors and is skipped for
 * the probe and the real call alike). Deliberately asked of the DESCRIPTOR rather than of either
 * mechanism: the runtime cannot enumerate what every gate reads, and "there are no arguments to
 * differ over" is true whoever is doing the reading.
 *
 * Read off the same JSON Schema the result hands the model, so the claim is about the interface the
 * model was told about. An `execute` envelope can smuggle arguments no schema declared (the provider
 * edge cannot validate a routed call) — one more reason this is advisory and the floor re-decides.
 */
function declaresArgs(schema: unknown): boolean {
	if (schema === null || typeof schema !== "object") return true;
	const properties = (schema as { properties?: unknown }).properties;
	if (properties === null || typeof properties !== "object") return false;
	return Object.keys(properties).length > 0;
}

/**
 * One probe answer → what a search result may honestly say. `null` OMITS the tool from the results.
 *
 * THE ONE THING THIS FUNCTION IS FOR: a probe evaluates a tool with no arguments, so a probe-derived
 * "you may not use this" can be WRONG for a tool that would be permitted with the right ones. If
 * search said no and the model believed it, a capability would silently disappear — strictly worse
 * than the status quo, where the model tries and finds out. So a deny is NEVER reported as a deny:
 *
 *   - the tool takes arguments  → `conditional`. The weakest true statement: the floor does not
 *     permit a bare call, and what you pass may change that. Keeps the capability reachable.
 *   - the tool takes none       → OMITTED. Here the probe is exact (see {@link declaresArgs}) and the
 *     engine has already re-asked as-if-confirmed, so this is a "no" approval cannot flip either.
 *     Listing an unusable tool spends context and invites a denied attempt; naming it also discloses
 *     that it EXISTS, which is itself a signal. Omitting is UX, never enforcement — the tool stays
 *     in the run's index, `execute` still addresses it by path, and the floor still decides it.
 *   - the probe could not decide → listed with no hint at all. A gate that threw (no stamped
 *     principal; a gate that assumes arguments) has refused to decide, which is not a "no" — saying
 *     nothing leaves the model exactly where it was before disclosure existed.
 */
function discloseTool(
	found: DiscoveredTool,
	outcome: Outcome | undefined,
): DiscoveredTool | null {
	if (outcome === undefined || outcome.status === "error") return found;
	if (outcome.status === "ok") return { ...found, authorization: "available" };
	// The MODEL-audience annotations only, verbatim — what a policy author wrote for whoever is
	// reading this ("this needs HR sign-off, ask the requester to route it"). The host's bag is a
	// different field and is never read here: an escalation target is an internal id for an
	// after-gate, and a disclosure is the one place a policy speaks to the agent, not about it.
	const annotations = outcome.modelAnnotations
		? { annotations: outcome.modelAnnotations }
		: {};
	if (outcome.status === "needs-approval") {
		return { ...found, authorization: "needs-approval", ...annotations };
	}
	if (!declaresArgs(found.inputSchema)) return null;
	// No `reason`: the deny reason carries the determining-policy trail, and which rules exist is
	// not the model's business.
	return { ...found, authorization: "conditional", ...annotations };
}

/** The disclosure capability off the runtime's execute options. Runtime-built (the model only
 *  authors `input`), so this is a narrowing read, not a trust decision. */
function readAccessProbe(options: unknown): ToolAccessProbe | undefined {
	if (options === null || typeof options !== "object") return undefined;
	const probe = (options as { probeAccess?: unknown }).probeAccess;
	return typeof probe === "function" ? (probe as ToolAccessProbe) : undefined;
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
		// VISIBILITY, not authorization — the same rule the catalog carries. Enumerating what exists is
		// not doing any of it, so this is a READ. It used to carry no `access` at all, on the reasoning
		// that the floor then would not model it; that stopped being a way to say "unmodeled" once
		// omission became the WRITE default, and an unstamped search would have been gated — turning
		// discovery itself into an approval prompt.
		//
		// Results DISCLOSE what the floor would say, and a disclosure is a UX nicety, never
		// enforcement. The floor still decides at execute time: a tool absent from these results must
		// not be unreachable BECAUSE it was hidden, and a tool present in them — with any hint at all —
		// must not be callable BECAUSE it was shown. The hint is also point-in-time; policy and scopes
		// can change before the call, which is a second reason nothing may be load-bearing on it.
		governance: {
			access: "read",
			effect: { kind: "internal", output: "none", risk: "low" },
		},
		invocation: {
			kind: "local",
			execute: async (
				input: { query: string; limit?: number },
				options: unknown,
			) => {
				const limit = Math.min(
					Math.max(Math.trunc(input.limit ?? DEFAULT_SEARCH_LIMIT), 1),
					MAX_SEARCH_LIMIT,
				);
				const found: DiscoveredTool[] = [];
				for (const summary of catalog.search(input.query, { limit })) {
					const descriptor = byPath.get(summary.address);
					if (!descriptor) continue;
					found.push({
						path: descriptor.path,
						description: descriptor.description,
						inputSchema: inputJsonSchema(descriptor.inputSchema),
					});
				}
				const probe = readAccessProbe(options);
				if (!probe) return { tools: found };
				// The PAGE is what gets probed, not the whole discoverable set: a decision per tool is
				// cheap (in-process wasm) but not free, and a result nobody is shown is a decision
				// nobody needed. Cost is therefore bounded by `limit`, not by how many tools exist.
				let outcomes: readonly Outcome[];
				try {
					outcomes = await probe(found.map((tool) => tool.path));
				} catch {
					// Disclosure is ADDITIVE. It must never become a new way for a run to die, so a probe
					// that fails outright (the context resolution behind it, say — the per-tool failures
					// are already answers) leaves search answering exactly what it answered before.
					return { tools: found };
				}
				const tools: DiscoveredTool[] = [];
				found.forEach((tool, index) => {
					const disclosed = discloseTool(tool, outcomes[index]);
					// An omission can under-fill the page (the page was picked by relevance, before
					// anyone asked the floor). A short page of usable tools beats a full one of doors
					// that do not open.
					if (disclosed) tools.push(disclosed);
				});
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
		// No `access` fact, and — unlike every other tool — this one is kept OUT of the floor's action
		// model on purpose (see the header, and `buildFloorPolicyPlugin`). If the floor could decide on
		// "execute", one permit would unlock every discoverable tool at once.
		//
		// That used to be achieved by omission: unstamped meant unmodeled meant unmatched. Omission now
		// means WRITE, so the guarantee is carried differently — the ingress refuses a malformed
		// envelope before any gate runs, so this path never reaches a decision at all. Being dispatched
		// remains a fail-closed condition rather than a call, and the throw below is the backstop for a
		// caller that bypassed the ingress.
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
