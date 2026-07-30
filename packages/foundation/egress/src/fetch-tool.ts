// The governed fetch as a TOOL — so a sandbox's outbound request is a decision the chokepoint makes,
// not a door the engine opens on its own.
//
// A guest `fetch` used to reach the network through a host function the engine built and called
// directly. That got the SSRF floor and (since `allow`) a destination list, and nothing else: no
// principal, no policy decision, no audit record, no redaction of what came back. The one nested
// path that DID have all of it was `tools.x()`, which goes through `subInvoke` → `handleToolCall`.
// So the fetch becomes a tool and takes the same road.
//
// It is model-callable, and that is deliberate rather than a leak. Registered in the run's toolset,
// the model can call it directly instead of writing a sandbox program that calls it — but a sandbox
// confers no authority of its own, so a claw where the model may run fetching code is a claw where
// the model may fetch. Permitting one and refusing the other would be a distinction policy cannot
// actually hold, and the floor denies both by default until something permits them.

import { govern, type ToolDefinition } from "@busyclaw/contracts";
import { jsonSchema } from "ai";
import { type GovernedFetchOptions, governedFetch } from "./governed-fetch";
import { FETCH_TOOL_PATH } from "./index";

/** Config the DEPLOYMENT owns. `signal` is absent because a lifetime is per call, not per tool: it
 *  arrives with the call, from whoever is waiting on it. */
export type FetchToolInput = Omit<GovernedFetchOptions, "signal">;

const DESCRIPTION =
	"Perform an HTTP request to an allowed destination. Returns { status, statusText, headers, body }.";

/**
 * Build the governed fetch tool.
 *
 * `allow` still lives here and still cannot be widened by policy — it is the deployment saying which
 * destinations exist at all, beneath whatever an organization's rules narrow it to. The `destination`
 * governance fact is what makes the narrowing expressible: it names `url` as the argument the origin
 * is read from, so the floor stamps `context.server` per CALL and one egress policy governs this and
 * every bound tool in the same vocabulary.
 *
 * `access: "read"` is the conservative half of a tool whose method is an argument. A single access
 * class cannot describe it honestly, so this declares the one that does not claim a write it might
 * not be making; a policy that cares should condition on the method rather than trust a class this
 * tool is not in a position to state truthfully.
 */
export { FETCH_TOOL_PATH };

export function fetchTool(input: FetchToolInput): ToolDefinition {
	return govern(
		{
			description: DESCRIPTION,
			// An AI-SDK `Schema`, not a bare JSON Schema object: `asSchema` in provider-utils v5
			// rejects the latter, so "the provider edge will wrap it" is not true and a plain object
			// fails at `prepareTools` — after the claw builds, on the first call. That is why this
			// module is its own entry point (`@busyclaw/egress/tool`): the floor stays importable
			// without an AI SDK, and only a consumer that wants the TOOL pays for one.
			inputSchema: jsonSchema<{
				url: string;
				method?: string;
				headers?: Record<string, string>;
				body?: string;
			}>({
				type: "object",
				properties: {
					url: { type: "string", description: "Absolute https URL." },
					method: { type: "string", description: "HTTP method. Default GET." },
					headers: { type: "object", additionalProperties: { type: "string" } },
					body: { type: "string" },
				},
				required: ["url"],
			}),
			execute: async (
				args: {
					url: string;
					method?: string;
					headers?: Record<string, string>;
					body?: string;
				},
				options?: { abortSignal?: AbortSignal },
			) => {
				// Built per call, because the two things it needs are per call. The floor's DNS pin and
				// the byte cap are per-request state; and the lifetime is whoever is waiting — the run's
				// signal combined with the sandbox execution's, which the runtime hands down here.
				//
				// This is the property that made the whole route worth threading a signal for: without
				// it, an execution ending left the request it started running to completion, so the
				// guest saw a timeout and the socket did not.
				const perform = governedFetch({
					...input,
					...(options?.abortSignal ? { signal: options.abortSignal } : {}),
				});
				return await perform(args.url, {
					method: args.method ?? "GET",
					...(args.headers ? { headers: args.headers } : {}),
					...(args.body !== undefined ? { body: args.body } : {}),
				});
			},
		},
		{
			access: "read",
			groups: ["egress"],
			// WHICH argument carries the destination — declared by this tool, never by its caller.
			destination: { arg: "url" },
		},
	);
}
