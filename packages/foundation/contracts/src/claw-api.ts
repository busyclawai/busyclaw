// The claw product-api WIRE protocol — the pieces a remote client and the HTTP adapter must agree
// on WITHOUT importing the server assembly: the flat base-api method-name list (each name derives
// its route through the one `toKebabCase`/`endpointHttpMethod` pair in ./governance/endpoints) and
// the success/error response envelope every adapter response carries. Input SCHEMAS stay server-side
// (`euroclaw`): the client sends inputs as-is and the boundary validates.

import { type } from "arktype";

/**
 * Every FLAT base `claw.api` method, the ONE source both route tables derive from: the server
 * (`clawApiRouteList` in `euroclaw`) and the remote client (`@euroclaw/client`) map each name to
 * `/<kebab(name)>` + the `get*`/`list*` → GET verb rule. `euroclaw` compile-checks the list against
 * `keyof ClawApi` in both directions, so a drifted name cannot ship.
 */
export const CLAW_API_METHOD_NAMES = [
	"appendMessage",
	"archiveClaw",
	"archiveThread",
	"bindConversation",
	"continueEngineRun",
	"continueRun",
	"createCheckpoint",
	"createClaw",
	"createThread",
	"createToolCall",
	"createToolResult",
	"deletePolicySlice",
	"denyApproval",
	"forgetSubject",
	"generate",
	"getApproval",
	"getCheckpoint",
	"getClaw",
	"getEffect",
	"getLatestCheckpoint",
	"getMessage",
	"getRun",
	"getThread",
	"getToolCall",
	"getToolCallByProviderId",
	"getToolResult",
	"grantApproval",
	"listActions",
	"listApprovals",
	"listMessages",
	"listPolicySlices",
	"listRegisteredTools",
	"listRunEvents",
	"listThreads",
	"listToolResults",
	"putPolicySlice",
	"registerOpenApiSpec",
	"sendMessage",
	"shareResource",
	"startRun",
	"unshareResource",
	"updateClaw",
	"updateToolCallStatus",
] as const;

export type ClawApiMethodName = (typeof CLAW_API_METHOD_NAMES)[number];

/**
 * The HTTP envelope every euroclaw adapter response carries: success/error around the claw api
 * result. One schema — the server builds it and the client PARSES it (never casting untrusted
 * network JSON). `error.code` is the stable {@link EuroclawErrorCode} when the failure carried one.
 */
export const clawResponseEnvelope = type({
	"ok?": "boolean",
	"data?": "unknown",
	"error?": { message: "string", "code?": "string" },
});
export type ClawResponseEnvelope = typeof clawResponseEnvelope.infer;

/** Validate an untrusted decoded wire value against the envelope; `undefined` when it isn't one
 *  (a proxy/gateway error page, say) — the caller lets the HTTP status drive the error then. */
export function parseClawResponseEnvelope(
	value: unknown,
): ClawResponseEnvelope | undefined {
	const valid = clawResponseEnvelope(value);
	return valid instanceof type.errors ? undefined : valid;
}
