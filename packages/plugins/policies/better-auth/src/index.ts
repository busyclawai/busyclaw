// @busyclaw/policy-better-auth — govern tool calls with your better-auth app's OWN access control.
//
// It doesn't re-declare who has which role. It delegates to better-auth's `auth.api.hasPermission`,
// which resolves everything from the request headers on its own: session → active organization →
// the member's role(s), including dynamic DB roles → the permission check. busyclaw stores no
// identity, roles, or org mapping — you forward the headers and it asks "can this user do X?".
//
// At request time you pass better-auth's own thing — the request `headers`:
//   claw.generate(prompt, { headers })
//
// The `auth` param is typed structurally (just `api.hasPermission`), so a real auth WITH the
// organization plugin satisfies it, an auth WITHOUT it fails to compile, and a test stub needs no DB.
//
// H-13. Which is why better-auth is a PEER here and not a dependency: nothing in this package
// imports it, and pinning a version it never loads only forced a second copy into every consumer's
// tree — one that shipped at 1.6.19, inside the range GHSA-qq9h-g4jm-xgf3 covers, whether or not the
// host used better-auth at all. As a peer, the host's own install is the one that answers, and the
// `>=1.6.22` range says which installs this plugin is willing to be used with. Optional, because a
// deployment governing tools some other way should not have to install it to satisfy a resolver.

import { createPolicyPlugin, type PolicyPlugin } from "@busyclaw/authz";
import type {
	PolicyEngine,
	PolicyRequest,
	ToolCall,
} from "@busyclaw/contracts";

/** better-auth's request context: the incoming headers (carrying the session). */
export type BetterAuthContext = { headers: Headers };

/** What the `hasPermission` check returns — a boolean, or `{ success }` depending on call path. */
export type HasPermissionResult = boolean | { success?: boolean };

/**
 * The slice of a better-auth instance this plugin uses: `auth.api.hasPermission`. Added by the
 * organization plugin — so a real `auth` configured with `organization()` satisfies this.
 */
export type AuthWithPermission = {
	api: {
		hasPermission: (input: {
			headers: Headers;
			body: { permissions: Record<string, readonly string[]> };
		}) => Promise<HasPermissionResult>;
	};
};

/** A PolicyEngine that delegates each decision to better-auth's `hasPermission`. */
export function betterAuthEngine(auth: AuthWithPermission): PolicyEngine {
	return {
		async authorize(req) {
			const headers = req.context.headers as Headers;
			const permissions = { [req.resource.id]: [req.action.id] };
			const result = await auth.api.hasPermission({
				headers,
				body: { permissions },
			});
			const ok = typeof result === "boolean" ? result : result.success === true;
			return ok
				? { decision: "permit" }
				: {
						decision: "deny",
						reason: `not permitted: "${req.action.id}" on "${req.resource.id}"`,
					};
		},
	};
}

export type BetterAuthAccessControlConfig = {
	/** Your better-auth instance (must have the `organization()` plugin for `hasPermission`). */
	auth: AuthWithPermission;
	/** Map a tool call to (resource, action, headers). Override to target your real org permissions. */
	mapCall?: (call: ToolCall, ctx: BetterAuthContext) => PolicyRequest;
	/** Which calls this governs. Default: every call (the allowlist). */
	matcher?: (call: ToolCall, ctx: BetterAuthContext) => boolean;
	/** The action verb a tool maps to (the resource is the tool name). Default "execute". */
	action?: string;
	/** Namespace the permission resource as `<prefix>:<tool>` (default none — the bare tool name). */
	prefix?: string;
	/** Gate/plugin id. Default "policy:better-auth". */
	id?: string;
	/** Seal the gate — the org floor can't be removed. Default false. */
	sealed?: boolean;
};

/**
 * The better-auth access-control plugin. `busyclaw({ plugins: [betterAuthAccessControl({ auth })] })`
 * governs every tool call through your org's permissions, and `run(prompt, { headers })` forwards the
 * request. By default a tool maps to the permission `{ [tool]: ["execute"] }`; override `mapCall` to
 * target the resources/actions your `createAccessControl` statements actually declare.
 */
export function betterAuthAccessControl(
	config: BetterAuthAccessControlConfig,
): PolicyPlugin<BetterAuthContext> {
	const op = config.action ?? "execute";
	const resourceId = (name: string) =>
		config.prefix ? `${config.prefix}:${name}` : name;
	const mapCall =
		config.mapCall ??
		((call: ToolCall, ctx: BetterAuthContext): PolicyRequest => ({
			principal: { type: "User", id: "" }, // resolved by better-auth from the headers, not here
			action: { type: "Action", id: op },
			resource: { type: "Tool", id: resourceId(call.name) },
			context: { headers: ctx.headers },
		}));
	return createPolicyPlugin({
		engine: betterAuthEngine(config.auth),
		mapCall,
		matcher: config.matcher,
		id: config.id ?? "policy:better-auth",
		sealed: config.sealed,
	});
}

export type { PolicyPlugin } from "@busyclaw/authz";
export { createPolicyPlugin } from "@busyclaw/authz";
export type {
	PolicyEngine,
	PolicyRequest,
} from "@busyclaw/contracts";
