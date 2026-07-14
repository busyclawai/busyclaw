// The authorization MODEL — the canonical, engine-neutral description of everything that can be
// asked: one action per tool operation (or hand-declared domain verb), the group taxonomy, and the
// resource entity types. The model DESCRIBES (facts); policies PRESCRIBE (posture). Deliberately no
// posture fields here — "may the agent do this autonomously?" is a policy over stamped request
// facts (runMode/confirmationUsed), never an action attribute.
//
// The model is plain data (host-assembled by trusted code — no boundary, no schema). Cedar schema
// text is a RENDERING of this model owned by @euroclaw/authz; non-Cedar engines consume the
// model directly and never parse Cedar.

import type { JsonObject } from "../common";

/** Does the action mutate state? Derived: HTTP verb / MCP hints / GraphQL query-vs-mutation /
 *  the author's stamp. Named `access` (not `risk`) — `ToolEffectPolicy.risk` is a different axis. */
export type ActionAccess = "read" | "write";

/** Where the action came from: generated from a tool definition, a hand-authored domain verb, or a
 *  `claw.api` product-API method (the app-authz PEP surface — `ClawApi::` namespace, distinct from the
 *  `Tool::` agent chokepoint). */
export type ActionSource = "tool" | "domain" | "api";

/** One authorizable action — facts only. `args` is the action's arg schema (JSON Schema); the
 *  Cedar projection (@euroclaw/authz `projectArgs`) renders and request-filters the policy-visible
 *  subset from it (lossy-but-safe: policies may only condition on what projects cleanly). */
export type ActionDef = {
	id: string;
	groups: readonly string[];
	resourceType: string;
	args?: JsonObject;
	access: ActionAccess;
	source: ActionSource;
	audit?: boolean;
};

/** An action group — the taxonomy policies target (`action in Action::"writes"`). Groups may
 *  themselves belong to groups (Cedar action hierarchies render from `memberOf`). */
export type ActionGroupDef = {
	id: string;
	memberOf?: readonly string[];
};

/** A resource entity type. `parents` renders as Cedar `entity X in [Parent]` — e.g. an MCP tool's
 *  parent server, so one policy can govern a whole server (`resource in McpServer::"github"`). */
export type EntityTypeDef = {
	type: string;
	parents?: readonly string[];
};

/**
 * The assembled model. `version` pins the blueprint: policies are validated against exactly this
 * model version, so a vendor-spec update that changes an arg a policy depends on fails the build
 * instead of silently ungoverning the tool.
 */
export type AuthzModel = {
	version: string;
	actions: readonly ActionDef[];
	groups: readonly ActionGroupDef[];
	entityTypes: readonly EntityTypeDef[];
};
