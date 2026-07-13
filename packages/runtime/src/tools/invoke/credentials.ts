// Credential application over a request plan. Given the plan, the binding's security requirements
// (the AND-ed alternatives), the denormalized scheme definitions, and the one-door `Secrets` reader,
// place the right credential material onto the plan — or fail LOUD when a required credential is
// unconfigured.
//
// RESOLUTION and APPLICATION are separate concerns. Resolution: the material comes ONLY from the
// reader, keyed by the registration SOURCE name with the turn's {organizationId, principal?} context
// (never from model args, never from the spec) — one credential per registration (the per-scheme
// override is a later slice). Application: HOW to place that material (header/query/basic/bearer) is
// read from the spec's own securityScheme, per scheme. A required-but-unconfigured source fails the
// call (an actionable configure-your-credential error) rather than silently sending unauthenticated;
// a reader THROW is infrastructure failure and propagates unchanged — never swallowed into "unsatisfiable".

import type {
	ResolveContext,
	SecretMaterial,
	Secrets,
} from "@euroclaw/contracts";
import { configurationError } from "@euroclaw/contracts";
import type {
	OpenApiAuthScheme,
	OpenApiBinding,
} from "../sources/openapi/binding";
import type { HttpRequestPlan } from "./request-plan";

/** The trusted keying context for credential resolution — the turn's org + principal, plus the row's
 *  registration source. NONE of it comes from model args. */
export type CredentialContext = {
	organizationId: string;
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
		organizationId: context.organizationId,
		principal: context.principal,
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
	throw configurationError(
		"registered tool requires a credential that is not configured",
		{ source: context.source, unsatisfied: unmet },
	);
}

function applyScheme(
	plan: HttpRequestPlan,
	scheme: string,
	def: OpenApiAuthScheme,
	material: SecretMaterial,
): void {
	if (def.type === "apiKey") {
		const value = tokenValue(scheme, def.type, material);
		if (def.in === "header") {
			plan.headers[def.name] = value;
		} else {
			appendQueryParam(plan, def.name, value);
		}
		return;
	}
	if (def.type === "http" && def.scheme === "basic") {
		if (material.kind !== "basic") {
			throw configurationError(
				`scheme "${scheme}" is http/basic but the resolver returned ${material.kind} material`,
				{ scheme },
			);
		}
		plan.headers.authorization = `Basic ${base64Utf8(`${material.username}:${material.password}`)}`;
		return;
	}
	// http/bearer and oauth2/openIdConnect all place a bearer token.
	plan.headers.authorization = `Bearer ${tokenValue(scheme, def.type, material)}`;
}

function tokenValue(
	scheme: string,
	type: string,
	material: SecretMaterial,
): string {
	if (material.kind !== "token") {
		throw configurationError(
			`scheme "${scheme}" (${type}) needs token material but the resolver returned ${material.kind}`,
			{ scheme },
		);
	}
	return material.value;
}

function appendQueryParam(
	plan: HttpRequestPlan,
	name: string,
	value: string,
): void {
	const separator = plan.url.includes("?") ? "&" : "?";
	plan.url = `${plan.url}${separator}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

/** Base64 of a UTF-8 string using web-standard primitives (euroclaw packages avoid node `Buffer`
 *  types): TextEncoder → bytes → btoa. Correct for non-ASCII basic-auth credentials. */
function base64Utf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
