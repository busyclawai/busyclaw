// Exemplar client plugins — the two contract shapes in the wild: `secretsClient()` is PURE TYPE
// (a phantom carrying the server namespace, zero runtime), `approvalsClient()` is PURE REACTIVITY
// (a query atom + the signal that refetches it). Both import server types via `import type` only.

import type { ApprovalRecord } from "@euroclaw/contracts";
import { toKebabCase } from "@euroclaw/contracts/governance/endpoints";
import type { SecretsStorePlugin } from "@euroclaw/secrets-plugin";
import { atom } from "nanostores";
import { createQueryAtom } from "../query";
import type { ClawClientPlugin } from "../types";

/**
 * Client half of `secrets(…, { store })`: carries the server plugin's `$Api` as a TYPE-ONLY
 * phantom so `client.secrets.*` is typed even without `typeof claw`. Contributes nothing at
 * runtime — the calls themselves ride the convention proxy (`POST /secrets/set`,
 * `POST /secrets/delete`, `GET /secrets/list` — verbs from the same name rule the server mounts
 * with, so no `pathMethods` needed).
 */
export function secretsClient() {
	return {
		id: "euroclaw.secrets",
		$InferServerPlugin: {} as SecretsStorePlugin,
	} satisfies ClawClientPlugin;
}

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
		id: "euroclaw.approvals",
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
