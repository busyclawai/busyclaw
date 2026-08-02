// Client plugins for the BASE api — the surface `busyclaw` itself serves, which is the only surface
// this package may know about. `approvalsClient()` is PURE REACTIVITY: a query atom plus the signal
// that refetches it.
//
// A plugin's client half belongs to THAT PLUGIN, not here. `secretsClient()` used to live in this
// file, back when the client was its own package, which made it import `@busyclaw/secrets-plugin`
// — an import that survived
// into the published .d.ts, so a consumer typechecking against the client alone could not resolve
// it. It now ships from `@busyclaw/secrets-plugin/client`, the arrangement `@better-auth/stripe`
// uses and the reason better-auth's own client never hears about its plugins.

import type { ApprovalRecord } from "@busyclaw/contracts";
import { toKebabCase } from "@busyclaw/contracts/governance/endpoints";
import { atom } from "nanostores";
import { createQueryAtom } from "../query";
import type { ClawClientPlugin } from "../types";

// Paths derive through the ONE contracts splitter — never hand-written kebab, so the matcher and
// the route the client actually calls cannot drift apart.
const LIST_APPROVALS_PATH = `/${toKebabCase("listApprovals")}`;
const APPROVAL_MUTATION_PATHS = new Set(
	["grantApproval", "denyApproval", "sendMessage", "continueRun"].map(
		(name) => `/${toKebabCase(name)}`,
	),
);

/**
 * A `pendingApprovals` query atom over `listApprovals({ status: "pending" })`, refetched whenever
 * a call that can change the pending set succeeds: grant/deny (settles one), sendMessage/
 * continueRun (a run can park on a NEW approval). Lazy — nothing fetches until the first
 * subscriber.
 */
export function approvalsClient() {
	const $pendingApprovalsSignal = atom(false);
	return {
		id: "busyclaw.approvals",
		getAtoms: ($fetch) => ({
			$pendingApprovalsSignal,
			pendingApprovals: createQueryAtom<ApprovalRecord[]>({
				$fetch,
				input: { status: "pending" },
				path: LIST_APPROVALS_PATH,
				signals: [$pendingApprovalsSignal],
			}),
		}),
		atomListeners: [
			{
				matcher: (path) => APPROVAL_MUTATION_PATHS.has(path),
				signal: "$pendingApprovalsSignal",
			},
		],
	} satisfies ClawClientPlugin;
}
