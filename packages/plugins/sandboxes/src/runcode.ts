// The run_code tool factory: a tool descriptor the host adds to createClaw/createRuntime
// ({ tools }). It rides the runtime's invoker seam — its execute receives `subInvoke`, which routes
// every tool call the sandboxed script makes through the full governance pipeline.

import {
	govern,
	type HandleResult,
	stateError,
	type ToolDefinition,
} from "@euroclaw/contracts";
import { jsonSchema, tool } from "ai";
import type {
	ExecutionContext,
	Sandbox,
	SandboxToolInvoker,
	SandboxVolumeStore,
	VolumeRef,
} from "./core/contracts";
import { executeInSandbox } from "./core/engine";

// The governed nested-invoke seam the runtime hands invoker-stamped tools. Typed locally (its shape
// mirrors @euroclaw/runtime's SubInvoke) so this factory needs no runtime dependency.
type SubInvoke = (
	path: string,
	args: Record<string, unknown>,
	ctx?: Record<string, unknown>,
) => Promise<HandleResult>;
type InvokerExecuteOptions = { toolCallId: string; subInvoke?: SubInvoke };

// The guest proxy joins property access with dots, which lands exactly on a tool's canonical PATH —
// the same id the floor decides on. So the sandbox addresses tools the way policy does, not the way
// the wire does; a namespaced tool is reached by walking it, never by its flattened wire name.
const DEFAULT_DESCRIPTION =
	"Run JavaScript in an isolated sandbox. Call tools by their path with `await tools.<path>(args)` " +
	"— walk namespaces as properties, e.g. `tools.github.issues.list(args)`; each call is " +
	"individually governed and returns a result object you can read. `console.log` output is " +
	"captured. The value you `return` is the result.";

export function runCodeTool(input: {
	sandbox: Sandbox;
	/** Per-execution context assembly. Host-supplied; may close over integration/actor to build a
	 *  governed fetchAdapter. Default: {} (no fetch, no fs, defaults-only bounds).
	 *
	 *  The guest has no network stack of its own, so `fetchAdapter` is the ONLY way out — and the
	 *  provider turns fetch on from its mere presence, without inspecting what it does. Pass
	 *  `governedFetch()` rather than `fetch`: a bare passthrough reaches loopback, the private
	 *  network, and the cloud metadata endpoint.
	 *
	 *      context: () => ({ fetchAdapter: governedFetch() })
	 */
	context?: (options: { toolCallId: string }) => ExecutionContext;
	description?: string;
	/** When supplied, the mounted filesystem PERSISTS across run_code calls that resolve to the same
	 *  VolumeRef: the engine snapshots a bounded tree in (load) before the guest runs and out (save)
	 *  after. Absent = no filesystem at all, exactly as before this slice (no regression). */
	store?: SandboxVolumeStore;
	/** Resolves the VolumeRef for an execution. Default: the `toolCallId` — a per-call scope, because
	 *  the claw/conversation id is NOT reachable through the AI-SDK tool boundary (the runtime injects
	 *  it into the governance context, not the tool's execute options). For cross-call persistence the
	 *  host supplies this resolver (e.g. mapping to a claw id it closes over, or an external S3/
	 *  SharePoint key). Only consulted when `store` is set. */
	volumeRef?: (options: { toolCallId: string }) => VolumeRef;
}): ToolDefinition {
	// The AI SDK's `tool()` is used purely to infer `execute`'s args from the schema; `govern` then
	// adopts the result as the canonical descriptor.
	const theTool = tool({
		description: input.description ?? DEFAULT_DESCRIPTION,
		inputSchema: jsonSchema<{ code: string }>({
			type: "object",
			properties: {
				code: {
					type: "string",
					description:
						"JavaScript source. Use `await tools.<path>(args)` to call tools; `return` the result.",
				},
			},
			required: ["code"],
		}),
		execute: async ({ code }, options) => {
			// Blessed seam cast: the AI-SDK ToolCallOptions type is closed; the runtime extends it with
			// `subInvoke` for invoker-stamped tools only (runtime.ts). Absent = the stamp is missing.
			const { subInvoke, toolCallId } =
				options as unknown as InvokerExecuteOptions;
			if (!subInvoke) {
				throw stateError("run_code requires the runtime subInvoke seam");
			}
			const invoker: SandboxToolInvoker = {
				// `path` is already the canonical id — the guest proxy joins segments on ".", which is
				// the path separator, so nothing needs translating on this seam. The HandleResult VALUE
				// (ok/denied) round-trips to the sandbox as JSON so model code can read status/reason.
				// handleToolCall re-validates args downstream, so the guest object crosses as-is here.
				invoke: ({ path, args }) =>
					subInvoke(path, args as Record<string, unknown>),
			};
			const baseContext = input.context?.({ toolCallId }) ?? {};

			// Snapshot-in / snapshot-out around the run: when a store is configured, load the bounded
			// tree for this ref, mount it (the store owns the fs — it wins over any host-supplied
			// mountFs), run, then save the mutated tree the provider handed back. Without a store the
			// filesystem is absent unless the host set mountFs directly (the pre-slice behavior).
			const store = input.store;
			const ref = store
				? (input.volumeRef?.({ toolCallId }) ?? toolCallId)
				: undefined;
			const tree =
				store && ref !== undefined ? await store.load(ref) : undefined;
			const context: ExecutionContext =
				tree !== undefined ? { ...baseContext, mountFs: tree } : baseContext;

			const { output, fsTree } = await executeInSandbox({
				sandbox: input.sandbox,
				code,
				invoker,
				context,
			});
			if (store && ref !== undefined && fsTree !== undefined) {
				await store.save(ref, fsTree);
			}
			return output;
		},
	});

	// Forced stamp (sandboxes-plan invariant #8): the script is one atomic effect — idempotency/output
	// "none" so a half-run script is never replayed or double-fired. NOT configurable.
	return govern(theTool, {
		// WRITE, stated rather than inherited. An unstamped tool defaults to write, so this changes
		// nothing today — but `run_code` is the last tool that should depend on a default. The outer
		// code-execution capability is authorized on its OWN account, independently of the nested tools
		// the script may go on to call: each of those is decided again at the chokepoint, and a policy
		// permitting them says nothing about whether this caller may run arbitrary code at all.
		access: "write",
		invoker: true,
		effect: {
			idempotency: "none",
			output: "none",
			risk: "high",
			kind: "external",
		},
	});
}
