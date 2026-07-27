// The approval after-gate IMPLEMENTATION: persists every needs-approval outcome to the ApprovalStore
// with the REDACTED call so resume can replay it. The ApprovalStore port + record schema live in
// @euroclaw/contracts. See docs/architecture/07-approval-and-audit.md.

import {
	type AfterGate,
	type ApprovalMetadataResolver,
	type ApprovalStore,
	asPrincipal,
	CLAW_ID_CONTEXT_KEY,
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
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
				// The access anchor. Stamped from the runtime's recording context — a trusted
				// post-strip stamp, never anything the call carried — so an approval cannot be
				// created claiming to belong to a claw its run was never part of.
				...(typeof ctx[CLAW_ID_CONTEXT_KEY] === "string"
					? { clawId: ctx[CLAW_ID_CONTEXT_KEY] }
					: {}),
				// The TENANT — the second anchor, and the only one a cron-triggered one-off has. Also a
				// trusted post-strip stamp (the host's configScope resolver writes it).
				...(typeof ctx[CONFIG_SCOPE_CONTEXT_KEY] === "string" &&
				typeof ctx[CONFIG_SCOPE_ID_CONTEXT_KEY] === "string"
					? {
							scope: ctx[CONFIG_SCOPE_CONTEXT_KEY],
							scopeId: ctx[CONFIG_SCOPE_ID_CONTEXT_KEY],
						}
					: {}),
				metadata: metadata?.(call.toolCall, ctx, outcome),
				createdAt: now(),
			});
		},
	};
}
