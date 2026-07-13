// The registry ASSEMBLY — the one place that turns stored registry rows into the per-organization
// action vocabulary, plus the agent-facing governed registration tool. `assembleOrgActions` is the
// single function the org router compiles and `listActions` reads, so a policy-editor UI and
// enforcement can never disagree: code stamps ∪ domain verbs ∪ registered rows, facts overlay
// merged (overlay-wins). Actions ≠ tools — a domain verb appears here with no tool row behind it.
//
// Engine-agnostic: this assembles the neutral AuthzModel; compiling it into a Cedar bundle (the
// router's engineFor) is the host's concern and lives outside src (euroclaw does not depend on a
// policy engine at runtime).

import {
	type AuthzActionInput,
	actionInputsFromRegisteredTools,
	buildAuthzModel,
	mergeFactsOverlay,
	projectArgs,
} from "@euroclaw/authz";
import {
	type ActionAccess,
	type ActionSource,
	type AuthzModel,
	type FactsOverlayRecord,
	jsonObject,
	type RegisteredToolRecord,
	validationError,
} from "@euroclaw/contracts";
import { normalizeOrigin, type SpecRegistry } from "@euroclaw/runtime";
import { tool } from "@euroclaw/vendors/ai-sdk";
import { type } from "arktype";

/** One row of the assembled per-org action vocabulary — facts only, plus the pinned model version. */
export type ActionView = {
	id: string;
	source: ActionSource;
	access: ActionAccess;
	groups: readonly string[];
	resourceType: string;
	/** The Cedar type of the policy-visible args, when the action's schema projects any. */
	argsCedarType?: string;
	contentVersion: string;
};

export type AssembledOrgActions = {
	model: AuthzModel;
	actions: ActionView[];
	/** write→read overlay downgrades — surface loudly; never silent. */
	loosenings: { actionId: string; from: ActionAccess; to: ActionAccess }[];
	/** overlay rows whose actionId matched no action. */
	unmatched: string[];
};

/**
 * Assemble an organization's action model + view. `base` carries the code-tool stamps and domain
 * verbs (they exist with no registered row); registered rows become dotted tool actions; the facts
 * overlay merges last (overlay-wins, loosenings reported). The SAME function the router compiles.
 * Overlay rows pass to the merge as-is — a FactsOverlayRecord IS a FactsOverlayEntry structurally
 * (the row was already arktype-parsed at the store read; no re-mapping, no re-validation).
 */
export function assembleOrgActions(input: {
	base?: readonly AuthzActionInput[];
	registeredTools: readonly RegisteredToolRecord[];
	overlay?: readonly FactsOverlayRecord[];
}): AssembledOrgActions {
	const registered = actionInputsFromRegisteredTools(
		input.registeredTools.map((row) => ({
			address: row.address,
			governance: row.governance,
			inputSchema: row.inputSchema,
		})),
	);
	const merged = mergeFactsOverlay(
		[...(input.base ?? []), ...registered],
		input.overlay ?? [],
	);
	const model = buildAuthzModel(merged.inputs);
	const actions: ActionView[] = model.actions.map((action) => {
		// Same projection the Cedar render uses; unprojectable schemas carry no policy-visible args.
		const projection = action.args ? projectArgs(action.args) : undefined;
		return {
			id: action.id,
			source: action.source,
			access: action.access,
			groups: action.groups,
			resourceType: action.resourceType,
			...(projection ? { argsCedarType: projection.cedarType } : {}),
			contentVersion: model.version,
		};
	});
	return {
		model,
		actions,
		loosenings: merged.loosenings,
		unmatched: merged.unmatched,
	};
}

/**
 * Build the `serverForAction` provider for the Cedar plugin from an organization's registered
 * rows: action id (`<source>.<tool>`) → the binding's NORMALIZED origin. The same normalization the
 * egress floor + request plan use, so `context.server` matches the origin a tool actually reaches.
 * Model-derived and spoof-proof — it comes from the stored binding, never caller context. A row
 * whose server is absent/unparseable simply carries no origin fact (the tool is uninvokable anyway).
 */
export function serverForActionFromRegisteredTools(
	rows: readonly RegisteredToolRecord[],
): (actionId: string) => string | undefined {
	const origins = new Map<string, string>();
	for (const row of rows) {
		const server = row.binding.server;
		if (typeof server !== "string") continue;
		try {
			origins.set(row.address, normalizeOrigin(server));
		} catch {
			// Uninvokable binding — no egress fact to stamp.
		}
	}
	return (actionId) => origins.get(actionId);
}

/**
 * The agent-facing GOVERNED registration tool. The model may set ONLY `{ source, document }`;
 * organizationId + registeredBy are BOUND here from trusted turn context (the claw's org + principal),
 * NEVER from model args — the input schema has no such field, so a prompt-injected model cannot
 * register into another organization. "Who may register" is a policy over register_openapi_spec.
 */
export function registerOpenApiSpecTool(
	registry: SpecRegistry,
	principal: { organizationId: string; registeredBy: string },
) {
	return tool({
		description:
			"Register an OpenAPI spec so its operations become this organization's governed tools.",
		inputSchema: type({ source: "string", document: "object" }),
		access: "write",
		groups: ["registry"],
		execute: ({ source, document }) => {
			// Boundary: the model's `document` is untrusted — validate it is a JSON object, fail loud.
			const doc = jsonObject(document);
			if (doc instanceof type.errors) {
				throw validationError(
					"register_openapi_spec document invalid",
					doc.summary,
				);
			}
			return registry.registerOpenApiSpec({
				organizationId: principal.organizationId,
				registeredBy: principal.registeredBy,
				source,
				document: doc,
			});
		},
	});
}
