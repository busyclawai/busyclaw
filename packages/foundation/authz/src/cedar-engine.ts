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
	policySetTextToParts,
} from "@cedar-policy/cedar-wasm/nodejs";
import type {
	EntityRef,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
import { configurationError } from "@euroclaw/contracts";
import type { CedarEngine, CedarEngineConfig } from "./cedar-types";

const toUid = (e: EntityRef) => ({ type: e.type, id: e.id });

/**
 * Turn a NAMED policy set (name → cedar text, as `loadPolicyBundle` produces) into the id → policy map
 * cedar-wasm takes, so a decision's determining-policy trail — `PolicyResult.policies`, which the
 * compliance audit persists — reports WHICH RULE fired instead of a positional `policy3` that shifts
 * whenever a slice is added above it.
 *
 * The names come from euroclaw's OWN structure — a stored slice's `name`, a floor rule's key — never
 * from metadata inside the Cedar source, so nothing has to be annotated for the trail to be legible
 * and the id in the audit is the same handle the policy is managed by. cedar-wasm takes exactly ONE
 * policy per id, so a name whose text holds several policies is split into `<name>#<i>`; a
 * single-policy name is used verbatim.
 */
function namedPolicySet(
	named: Readonly<Record<string, string>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	const claim = (id: string, policy: string): void => {
		if (out[id] !== undefined) {
			throw configurationError(`duplicate Cedar policy id: ${id}`, {
				policyId: id,
				reason:
					"two policies resolved to the same id — the determining-policy trail could not tell them apart",
			});
		}
		out[id] = policy;
	};
	for (const [name, text] of Object.entries(named)) {
		const parts = policySetTextToParts(text);
		if (parts.type === "failure") {
			throw configurationError(
				`invalid Cedar policy set in "${name}": ${parts.errors.map((e) => e.message).join("; ")}`,
			);
		}
		const policies = parts.policies;
		const single = policies[0];
		if (policies.length === 1 && single !== undefined) {
			claim(name, single);
			continue;
		}
		policies.forEach((policy, index) => claim(`${name}#${index}`, policy));
	}
	return out;
}

/** A Cedar PDP as a PolicyEngine: deny-by-default, forbid-overrides, with a needs-approval probe. The
 *  `authorize` overload takes optional per-decision entities (merged UNDER the directory) — the product-
 *  api PEP passes its per-request Principal/Resource/Access graph there. */
export function cedarEngine(config: CedarEngineConfig): CedarEngine {
	const approvalFlag = config.approvalFlag ?? "confirmationUsed";
	const validateRequest = config.validateRequest ?? config.schema !== undefined;

	// Hand Cedar a NAMED set (id → policy) so `diagnostics.reason` — the trail that reaches the audit —
	// names the rule that fired. Plain TEXT is still accepted (a one-off engine, a test): Cedar then
	// assigns its own positional ids, the pre-naming behaviour. See {@link namedPolicySet}.
	const policies = {
		staticPolicies:
			typeof config.policies === "string"
				? config.policies
				: namedPolicySet(config.policies),
	};
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
