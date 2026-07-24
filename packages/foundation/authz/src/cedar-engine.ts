// The Cedar PDP behind the @euroclaw/contracts PolicyEngine port.
//
// Every request is evaluated DENY-BY-DEFAULT: nothing runs unless a `permit` matches (an
// allowlist), and `forbid` overrides `permit`. Conditional `permit ... when
// { context.confirmationUsed }` policies surface as NEEDS-APPROVAL via a probe: on a deny, the
// engine re-evaluates the request as-if-confirmed; if that flips to allow, the action isn't
// forbidden — it just needs sign-off. ABAC works through principal/resource attributes and tags
// carried on the synced entity directory.
//
// Uses cedar-wasm's stateless `isAuthorized` for clarity. When the PDP gets hot, swap to
// `preparsePolicySet` + `statefulIsAuthorized` (parse the policy text once) — same answers.
// The /nodejs build loads the WASM synchronously (fs.readFileSync) — server-side, no async init.

import type {
	AuthorizationCall,
	Entities,
} from "@cedar-policy/cedar-wasm/nodejs";
import {
	checkParsePolicySet,
	checkParseSchema,
	isAuthorized,
} from "@cedar-policy/cedar-wasm/nodejs";
import type {
	EntityRef,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
import { configurationError } from "@euroclaw/contracts";
import type { CedarEngine, CedarEngineConfig } from "./cedar-types";

const toUid = (e: EntityRef) => ({ type: e.type, id: e.id });

/** A Cedar PDP as a PolicyEngine: deny-by-default, forbid-overrides, with a needs-approval probe. The
 *  `authorize` overload takes optional per-decision entities (merged UNDER the directory) — the product-
 *  api PEP passes its per-request Principal/Resource/Access graph there. */
export function cedarEngine(config: CedarEngineConfig): CedarEngine {
	const approvalFlag = config.approvalFlag ?? "confirmationUsed";
	const policies = { staticPolicies: config.policies };
	const validateRequest = config.validateRequest ?? config.schema !== undefined;

	// Fail LOUD at construction for a broken policy set / schema — a config bug, not a runtime deny.
	const parsedPolicies = checkParsePolicySet(policies);
	if (parsedPolicies.type === "failure") {
		throw configurationError(
			`invalid Cedar policy set: ${parsedPolicies.errors.map((e) => e.message).join("; ")}`,
		);
	}
	if (config.schema !== undefined) {
		const parsedSchema = checkParseSchema(config.schema);
		if (parsedSchema.type === "failure") {
			throw configurationError(
				`invalid Cedar schema: ${parsedSchema.errors.map((e) => e.message).join("; ")}`,
			);
		}
	}

	const resolveEntities = async (): Promise<Entities> => {
		if (typeof config.entities === "function") return config.entities();
		return config.entities ?? [];
	};

	// One Cedar evaluation. Never throws: a request that can't be evaluated is fail-CLOSED (deny),
	// with the error surfaced so the audit shows config breakage, not a policy deny.
	const evaluate = (
		req: PolicyRequest,
		context: Record<string, unknown>,
		entities: Entities,
	): { allow: boolean; policies: string[]; error?: string } => {
		try {
			const call: AuthorizationCall = {
				principal: toUid(req.principal),
				action: toUid(req.action),
				resource: toUid(req.resource),
				context: context as AuthorizationCall["context"],
				policies,
				entities,
				...(config.schema !== undefined
					? { schema: config.schema, validateRequest }
					: {}),
			};
			const answer = isAuthorized(call);
			if (answer.type === "failure") {
				return {
					allow: false,
					policies: [],
					error: answer.errors.map((e) => e.message).join("; "),
				};
			}
			// NB: cedar-wasm populates `diagnostics.errors` even for a `has`-guarded, short-circuited
			// optional-attribute access (the standard idiom for optional context facts) — the DECISION
			// is still correct. So we must NOT blanket-deny on `diagnostics.errors`: that would break
			// every correct `has`-guarded policy (verified against 4.11.1). Policies that must fail
			// closed on an unknown fact express it structurally with `unless { … has x … }` (see
			// @euroclaw/authz SYSTEM_POSTURE), so an erroring branch makes the forbid APPLY, not vanish.
			return {
				allow: answer.response.decision === "allow",
				policies: answer.response.diagnostics.reason,
			};
		} catch (err) {
			return {
				allow: false,
				policies: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	};

	return {
		capabilities: { reads: "identity+args", approvals: true },
		async authorize(
			req: PolicyRequest,
			extraEntities?: Entities,
		): Promise<PolicyResult> {
			// One entities snapshot per decision — the base evaluation and the probe must agree. Per-
			// request entities (the api PEP's Principal/Resource/Access graph) merge UNDER the directory.
			const directory = await resolveEntities();
			const entities: Entities =
				extraEntities !== undefined
					? [...directory, ...extraEntities]
					: directory;
			const baseContext = { ...req.context, [approvalFlag]: false };
			const first = evaluate(req, baseContext, entities);
			if (first.error)
				return { decision: "deny", reason: `cedar error: ${first.error}` };
			if (first.allow) return { decision: "permit", policies: first.policies };

			// Probe: would confirmation unblock it? If yes, it's needs-approval, not a hard deny.
			const probed = evaluate(
				req,
				{ ...baseContext, [approvalFlag]: true },
				entities,
			);
			if (!probed.error && probed.allow) {
				return {
					decision: "needs-approval",
					reason: "confirmation required",
					policies: probed.policies,
				};
			}
			return { decision: "deny", policies: first.policies };
		},
	};
}
