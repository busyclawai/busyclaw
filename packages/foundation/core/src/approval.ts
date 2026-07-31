// The approval after-gate IMPLEMENTATION: persists every needs-approval outcome to the ApprovalStore
// with the REDACTED call so resume can replay it. The ApprovalStore port + record schema live in
// @busyclaw/contracts. See docs/architecture/07-approval-and-audit.md.

import {
	type AfterGate,
	type ApprovalMetadataResolver,
	type ApprovalStore,
	asPrincipal,
	CLAW_ID_CONTEXT_KEY,
	CONFIG_SCOPE_CONTEXT_KEY,
	CONFIG_SCOPE_ID_CONTEXT_KEY,
	PRINCIPAL_CONTEXT_KEY,
	UNSCOPED,
} from "@busyclaw/contracts";

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
				// The whole question, not just the gate that happened to be listed first.
				demands: outcome.demands,
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
				// The TENANT — the second anchor, and the only one a cron-triggered one-off has. A trusted
				// post-strip stamp, from the run's resolved authority. Never absent: a run that resolves
				// no tenant carries UNSCOPED, which is a boundary nobody can be a member of, so the
				// approval is still parentless and still denied — it just says so in the column instead
				// of leaving it null for a resume to read as agreement.
				scope:
					typeof ctx[CONFIG_SCOPE_CONTEXT_KEY] === "string"
						? ctx[CONFIG_SCOPE_CONTEXT_KEY]
						: UNSCOPED.scope,
				scopeId:
					typeof ctx[CONFIG_SCOPE_ID_CONTEXT_KEY] === "string"
						? ctx[CONFIG_SCOPE_ID_CONTEXT_KEY]
						: UNSCOPED.scopeId,
				metadata: metadata?.(call.toolCall, ctx, outcome),
				createdAt: now(),
			});
		},
	};
}
