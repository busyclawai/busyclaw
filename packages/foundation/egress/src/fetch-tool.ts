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

import { govern, type Secrets, type ToolDefinition } from "@busyclaw/contracts";
import { jsonSchema } from "ai";
import {
	type CredentialPlacement,
	managedHeader,
	placeCredential,
} from "./credential-placement";
import { type GovernedFetchOptions, governedFetch } from "./governed-fetch";
import { FETCH_TOOL_PATH, originOf } from "./index";

/**
 * A destination → credential routing row: WHERE it applies, WHICH secret, and HOW it is placed.
 *
 * The match key is the destination ORIGIN, not an integration slug, because this tool sees a URL
 * rather than a named operation. Exact origins only, matching `allow` — a pattern spanning a
 * multi-tenant host family reads as one destination and is many, and injecting a credential hands
 * the secret to whatever answers.
 */
export type EgressCredentialBinding = {
	/** The origin this credential is for — `https://api.example`, compared after normalization. */
	origin: string;
	/** The secret NAME, resolved through the one door. Never a value: what a deployment writes down
	 *  is which credential to use, and the resolver decides where it actually lives. */
	secret: string;
	/** Where it goes on the request. */
	placement: CredentialPlacement;
};

/** Config the DEPLOYMENT owns. `signal` is absent because a lifetime is per call, not per tool: it
 *  arrives with the call, from whoever is waiting on it. */
export type FetchToolInput = Omit<GovernedFetchOptions, "signal"> & {
	/**
	 * Claim-check credentials, matched on destination and applied PER CALL at egress.
	 *
	 * The point is what the caller never holds. The model writes the URL and the guest runs the code,
	 * and neither is ever handed the secret — it is resolved here, placed on the outbound request,
	 * and gone. So an over-privileged token stops being the problem it usually is: over-privileged is
	 * survivable when the holder is the host and every use passes the gate, and prompt-injected code
	 * cannot exfiltrate a credential it was never given.
	 *
	 * A destination with no binding is UNAUTHENTICATED, not refused — still floored, still
	 * policy-governed, just carrying no credential. A binding that exists and resolves to nothing
	 * FAILS LOUD, because that is a configuration error wearing the costume of a public endpoint.
	 */
	credentials?: {
		bindings: readonly EgressCredentialBinding[];
		/** The one door. Bind context with `.with({ scope, scopeId, principal })` before handing it
		 *  over — per-actor credentials ride that, not a knob here. */
		secrets: Secrets;
	};
};

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

				// CLAIM-CHECK. The credential is resolved and placed here, per call, at the last moment
				// before the request leaves — never pre-baked into the caller and never handed across.
				const target = {
					url: args.url,
					headers: { ...(args.headers ?? {}) },
				};
				const binding = input.credentials?.bindings.find(
					(candidate) => originOf(candidate.origin) === originOf(args.url),
				);
				if (binding && input.credentials) {
					// STRIP first, then place. A guest that put its own token in the slot this binding
					// manages must not have it survive — at the destination, a smuggled credential in the
					// managed header is indistinguishable from one the deployment authorized. Header names
					// are case-insensitive on the wire, so the strip has to be too, or `Authorization`
					// walks past a check looking for `authorization`.
					const managed = managedHeader(binding.placement);
					if (managed) {
						const lower = managed.toLowerCase();
						for (const name of Object.keys(target.headers)) {
							if (name.toLowerCase() === lower) delete target.headers[name];
						}
					}
					// `require`, not `get`: a binding that exists and resolves to nothing is a
					// configuration error, and sending the request unauthenticated would dress it up as a
					// public endpoint and hand the failure to whoever reads the 401 later.
					const material = await input.credentials.secrets.require(
						binding.secret,
					);
					placeCredential(
						target,
						binding.placement,
						material,
						`credential "${binding.secret}"`,
					);
				}

				return await perform(target.url, {
					method: args.method ?? "GET",
					headers: target.headers,
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
