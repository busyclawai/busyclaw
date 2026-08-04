// Credential application over a request plan. Given the plan, the binding's security requirements
// (the AND-ed alternatives), the denormalized scheme definitions, and the one-door `Secrets` reader,
// place the right credential material onto the plan — or fail LOUD when a required credential is
// unconfigured.
//
// RESOLUTION and APPLICATION are separate concerns. Resolution: the material comes ONLY from the
// reader, keyed by the registration SOURCE name with the turn's {scope, scopeId, principal?} context
// (never from model args, never from the spec) — one credential per registration (the per-scheme
// override is a later slice). Application: HOW to place that material (header/query/basic/bearer) is
// read from the spec's own securityScheme, per scheme. A required-but-unconfigured source fails the
// call (an actionable configure-your-credential error) rather than silently sending unauthenticated;
// a reader THROW is infrastructure failure and propagates unchanged — never swallowed into "unsatisfiable".

import type {
	ResolveContext,
	SecretMaterial,
	Secrets,
} from "@busyclaw/contracts";
import { asPrincipal, configurationError } from "@busyclaw/contracts";
import { type CredentialPlacement, placeCredential } from "@busyclaw/egress";
import type {
	OpenApiAuthScheme,
	OpenApiBinding,
} from "../sources/openapi/binding";
import type { HttpRequestPlan } from "./request-plan";

/** The trusted keying context for credential resolution — the turn's org + principal, plus the row's
 *  registration source. NONE of it comes from model args. */
export type CredentialContext = {
	scope: string;
	scopeId: string;
	source: string;
	principal?: string;
};

/** Apply the first fully satisfiable security alternative to a COPY of the plan. Public operations
 *  (no security, `[]`, or a `{}` alternative) pass through unchanged. */
export async function applyCredentials(
	plan: HttpRequestPlan,
	binding: OpenApiBinding,
	secrets: Secrets,
	context: CredentialContext,
): Promise<HttpRequestPlan> {
	const requirements = binding.security;
	// Undefined or `[]` security ⇒ the operation declared no auth ⇒ public.
	if (!requirements || requirements.length === 0) return plan;

	// Resolution context — the turn's org + principal (never model args). The scheme/scopes are NOT part
	// of the name (name = the registration source); they are read from the spec's securityScheme when the
	// material is APPLIED below.
	const resolveCtx: ResolveContext = {
		// Both halves or nothing — the invoker's `CredentialContext` is built from a closure captured at
		// tool synthesis and can still carry half a pair; omitting it entirely is what the reader reads
		// as UNSCOPED, and a half-named boundary must land there rather than in a bucket of its own.
		...(context.scope !== undefined && context.scopeId !== undefined
			? { configScope: { scope: context.scope, scopeId: context.scopeId } }
			: {}),
		principal:
			context.principal === undefined
				? undefined
				: asPrincipal(context.principal),
	};

	const unmet: string[] = [];
	for (const requirement of requirements) {
		const schemeNames = Object.keys(requirement);
		// A `{}` alternative is explicitly public — accept it, credential-free.
		if (schemeNames.length === 0) return plan;

		const staged: {
			scheme: string;
			def: OpenApiAuthScheme;
			material: SecretMaterial;
		}[] = [];
		let satisfiable = true;
		for (const scheme of schemeNames) {
			const def = binding.authSchemes?.[scheme];
			if (!def) {
				// Referenced scheme has no supported definition — this alternative can't be placed.
				unmet.push(`${scheme} (unsupported or undefined scheme)`);
				satisfiable = false;
				break;
			}
			// Resolve by the registration SOURCE name — one credential per registration; the scheme drives
			// APPLICATION (below), not resolution. A reader THROW is infra failure — let it propagate.
			const material = await secrets.get(context.source, resolveCtx);
			if (material === null) {
				unmet.push(`${scheme} (not configured)`);
				satisfiable = false;
				break;
			}
			staged.push({ scheme, def, material });
		}
		if (!satisfiable) continue;

		// Every AND-ed scheme resolved — apply them all to a fresh copy and take this alternative.
		const applied: HttpRequestPlan = { ...plan, headers: { ...plan.headers } };
		for (const { scheme, def, material } of staged) {
			applyScheme(applied, scheme, def, material);
		}
		return applied;
	}

	// No alternative was fully satisfiable and the operation required auth — fail loud, actionably.
	// This resolution named a tenant, so deployment-wide providers sat it out unless the name was
	// declared shared. Say so: the likeliest cause of a miss here is a credential that used to arrive
	// from the environment, and "not configured" alone would send the reader looking in the wrong place.
	throw configurationError(
		"registered tool requires a credential that is not configured",
		{
			source: context.source,
			scope: context.scope,
			scopeId: context.scopeId,
			unsatisfied: unmet,
			reason:
				"configure this source's credential for the tenant (a data-tier provider, e.g. the secret-store plugin), or — if it is genuinely one credential every tenant shares — list its name in the config provider's `shared`",
		},
	);
}

function applyScheme(
	plan: HttpRequestPlan,
	scheme: string,
	def: OpenApiAuthScheme,
	material: SecretMaterial,
): void {
	// The spec dialect decides WHICH placement; the shared primitive performs it. Doing the placement
	// here as well would be a second implementation of "where a bearer token goes", and the fetch
	// tool would be the one that drifted — silently, because a credential in the wrong header and no
	// credential at all both come back as a 401.
	placeCredential(plan, placementOf(def), material, `scheme "${scheme}"`);
}

/** An OpenAPI security scheme, as a placement. oauth2/openIdConnect place a bearer token — the
 *  material arrives from a token-minting resolver like any other. */
function placementOf(def: OpenApiAuthScheme): CredentialPlacement {
	if (def.type === "apiKey") {
		return def.in === "header"
			? { kind: "header", name: def.name }
			: { kind: "query", name: def.name };
	}
	if (def.type === "http" && def.scheme === "basic") return { kind: "basic" };
	return { kind: "bearer" };
}
