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
	policyToJson,
} from "@cedar-policy/cedar-wasm/nodejs";
import type {
	EntityRef,
	PolicyAnnotationKind,
	PolicyRequest,
	PolicyResult,
} from "@euroclaw/contracts";
import {
	configurationError,
	MODEL_ANNOTATION_MAX_LENGTH,
} from "@euroclaw/contracts";
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

/** One policy's declared annotations, already split by the audience each key was declared for. The
 *  split happens HERE — the index is the last place that still knows the declarations — so no
 *  downstream door has to remember to filter, and the two bags never travel as one. */
type AnnotationsByAudience = {
	host: Record<string, string>;
	model: Record<string, string>;
};

/**
 * Index each policy's DECLARED annotations by policy id, so a decision can report the metadata of the
 * rules that actually decided it. Annotations are read structurally (`policyToJson`), never by a regex
 * over source, and filtered to the keys plugins DECLARED: policy text is author-written and rides into
 * a hash-chained compliance log, so what may flow there is bounded, and an undeclared annotation is
 * inert rather than silently carried. `parse` is the declaring plugin's boundary validator.
 *
 * A key declared `audience: "model"` is bounded here as well as filtered: its value ends up in an
 * agent's context, which is neither a log line nor an id, and an over-long one is REJECTED rather
 * than truncated. This runs at CONSTRUCTION, beside the parse check below, so it fails the same way
 * unparseable policy text does — loudly, at assembly, as the config bug it is. Truncating instead
 * would hand a model an instruction that stops mid-clause, which is worse than no instruction.
 */
function annotationIndex(
	policies: Record<string, string>,
	declared: readonly PolicyAnnotationKind[],
): Map<string, AnnotationsByAudience> {
	const index = new Map<string, AnnotationsByAudience>();
	if (declared.length === 0) return index;
	const byKey = new Map(declared.map((d) => [d.key, d]));
	for (const [id, text] of Object.entries(policies)) {
		const json = policyToJson(text);
		if (json.type !== "success") continue;
		const found: AnnotationsByAudience = { host: {}, model: {} };
		for (const [key, raw] of Object.entries(json.json.annotations ?? {})) {
			const declaration = byKey.get(key);
			if (declaration === undefined || typeof raw !== "string") continue;
			const value = declaration.parse ? declaration.parse(raw) : raw;
			// Absent audience = "host": declaring a key must never, on its own, start feeding a model.
			if (declaration.audience !== "model") {
				found.host[key] = value;
				continue;
			}
			if (value.length > MODEL_ANNOTATION_MAX_LENGTH) {
				throw configurationError(
					`policy annotation "@${key}" on "${id}" is ${value.length} characters; a model-audience annotation is limited to ${MODEL_ANNOTATION_MAX_LENGTH}`,
					{
						policyId: id,
						reason:
							"the value reaches an agent's context window — shorten it rather than relying on a truncation that would cut the instruction mid-sentence",
					},
				);
			}
			found.model[key] = value;
		}
		if (
			Object.keys(found.host).length > 0 ||
			Object.keys(found.model).length > 0
		) {
			index.set(id, found);
		}
	}
	return index;
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
	const staticPolicies =
		typeof config.policies === "string"
			? config.policies
			: namedPolicySet(config.policies);
	const policies = { staticPolicies };
	// Declared policy annotations, indexed by policy id at CONSTRUCTION (parsed once, not per decision).
	// Only meaningful for a named set — plain text has no stable ids to index by.
	const annotations =
		typeof staticPolicies === "string"
			? new Map<string, AnnotationsByAudience>()
			: annotationIndex(staticPolicies, config.annotations ?? []);
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

	// The declared annotations of the policies that DECIDED, merged — one bag per AUDIENCE, kept
	// apart the whole way out. Either is omitted entirely when empty, so a decision never carries an
	// empty bag. (A key on two determining policies: last wins — they are metadata about a decision
	// already made, not part of it.)
	const annotationsOf = (
		determining: readonly string[],
	): {
		annotations?: Record<string, string>;
		modelAnnotations?: Record<string, string>;
	} => {
		if (annotations.size === 0) return {};
		const host: Record<string, string> = {};
		const model: Record<string, string> = {};
		for (const id of determining) {
			const found = annotations.get(id);
			if (found === undefined) continue;
			Object.assign(host, found.host);
			Object.assign(model, found.model);
		}
		return {
			...(Object.keys(host).length > 0 ? { annotations: host } : {}),
			...(Object.keys(model).length > 0 ? { modelAnnotations: model } : {}),
		};
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
			// NB: a policy that ERRORS is SKIPPED, and cedar-wasm reports it in `diagnostics.errors`
			// while the DECISION stays correct — so we must NOT blanket-deny on `diagnostics.errors`.
			// What actually errors is reaching an ABSENT BASE (`context.args` when the request carries no
			// `args` key, `context.runMode` when unstamped) — NOT a `has`-guarded access, which
			// short-circuits cleanly with zero errors when the base is present (re-verified 4.11.1; an
			// earlier note here claimed the opposite and was wrong). The consequence is unchanged and is
			// why bases are always stamped: a skipped policy is a permit that fails to fire, or a forbid
			// that VANISHES. Policies that must fail closed on an unknown fact say so structurally with
			// `unless { … has x … }` (see SYSTEM_POSTURE), so an erroring branch makes the forbid APPLY.
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
			if (first.allow)
				return {
					decision: "permit",
					policies: first.policies,
					...annotationsOf(first.policies),
				};

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
					// The PROBE's determining policies — the rules that would permit once confirmed. Their
					// annotations are what an escalation routes on ("this needs @escalate("team:x")").
					...annotationsOf(probed.policies),
				};
			}
			return {
				decision: "deny",
				policies: first.policies,
				...annotationsOf(first.policies),
			};
		},
	};
}
