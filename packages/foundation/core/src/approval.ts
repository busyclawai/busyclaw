// The approval after-gate IMPLEMENTATION: persists every needs-approval outcome to the ApprovalStore
// with the REDACTED call so resume can replay it. The ApprovalStore port + record schema live in
// @euroclaw/contracts. See docs/architecture/07-approval-and-audit.md.

import {
	type AfterGate,
	type ApprovalMetadataResolver,
	type ApprovalStore,
	asPrincipal,
	PRINCIPAL_CONTEXT_KEY,
} from "@euroclaw/contracts";

/**
 * The approval after-gate: persists every needs-approval outcome to the ApprovalStore, with the
 * REDACTED call so resume can replay it. A plain after-gate (like auditGate) — it observes, the
 * pipeline decides.
 */
export function approvalGate(
	store: ApprovalStore,
	now: () => string,
	metadata?: ApprovalMetadataResolver,
): AfterGate {
	return {
		id: "approval",
		matcher: (call) => call.boundary === "tool",
		handler: async (call, ctx, outcome) => {
			if (outcome.status !== "needs-approval") return;
			if (call.boundary !== "tool") return;
			await store.create({
				gateId: outcome.gateId,
				toolName: call.toolCall.name,
				args: call.toolCall.args,
				reasonCode: outcome.reasonCode,
				principal:
					typeof ctx[PRINCIPAL_CONTEXT_KEY] === "string"
						? asPrincipal(ctx[PRINCIPAL_CONTEXT_KEY])
						: undefined,
				reason: outcome.reason,
				metadata: metadata?.(call.toolCall, ctx, outcome),
				createdAt: now(),
			});
		},
	};
}
