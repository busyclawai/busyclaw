// buildAuthzModel — assemble the canonical authorization model from action inputs. Pure (no I/O,
// deterministic): generators (OpenAPI/MCP extractors) and the assembly (host tools via the
// `govern`/`tool` stamp) both feed the same builder, so a hand-registered tool is governed
// identically to a spec-generated one — one registry, no special cases.

import type {
	ActionDef,
	ActionGroupDef,
	ActionSource,
	AuthzModel,
	EntityTypeDef,
	JsonObject,
	ToolDescriptor,
	ToolGovernance,
} from "@busyclaw/contracts";
import { validationError } from "@busyclaw/errors";

export type AuthzActionInput = {
	/** The action id — the tool's canonical path (`petstore.getPet`) or the domain verb. */
	id: string;
	source: ActionSource;
	/** The governance stamp — `access`/`groups`/`resource`/`audit` facts are read from it. */
	governance?: ToolGovernance;
	/** The action's arg schema (JSON Schema). The Cedar projection (`projectArgs`) derives the
	 *  policy-visible subset from it at render/filter time — unprojectable constructs are opaque
	 *  to policy, never silently mistyped. */
	args?: JsonObject;
};

/**
 * Tool descriptors → action inputs. A descriptor feeds the model DIRECTLY: `path` is the action id
 * and `governance` is already a typed field, so nothing re-reads or re-validates a stamp on the way
 * in. This is the whole payoff of the descriptor collapse — the builder used to be fed by two
 * shape-specific reconcilers (one unwrapping the AI-SDK `busyclaw` passenger, one unwrapping a
 * storage row), each re-validating what the other had just validated.
 *
 * EVERY descriptor becomes an action, including one with no declared access class — {@link
 * buildAuthzModel} classes those as WRITE. This used to `continue` past them, on the reasoning that an
 * unstamped tool "is not a policy-modeled action, so the floor's matcher must not claim it (its own
 * gate, OR NOTHING, still governs it)". That last clause was the hole: omission from the model is what
 * made the floor's matcher skip the call, so the cheapest possible mistake — forgetting a stamp —
 * silently produced an ungoverned tool. A missing access class is now the LOUDEST classification
 * rather than the absent one: under the seeded posture a write needs confirmation interactively and is
 * refused autonomously, so an unstamped tool announces itself the first time it is called.
 *
 * `args` is deliberately not derived from `inputSchema` here: an AI-SDK schema object is not a JSON
 * Schema, and projecting host tools' args into policy is a change of behaviour, not of shape.
 */
export function actionInputsFromTools(
	descriptors: readonly ToolDescriptor[],
): AuthzActionInput[] {
	return descriptors.map((descriptor) => ({
		id: descriptor.path,
		source: "tool" as const,
		governance: descriptor.governance,
	}));
}

export type BuildAuthzModelOptions = {
	/** Resource entity type when the stamp declares none. Default "Tool". */
	defaultResourceType?: string;
	/** Pin the model version explicitly (e.g. a spec digest). Default: content hash of the model. */
	version?: string;
};

/** The derived group for an access class — the taxonomy the seeded policies target. */
function accessGroup(access: "read" | "write"): string {
	return access === "read" ? "reads" : "writes";
}

/**
 * Build the model. Fails loud on duplicate action ids. Defaults are fail-closed: an action that
 * declares no access class is treated as a WRITE (under seeded policies: needs confirmation).
 */
export function buildAuthzModel(
	inputs: readonly AuthzActionInput[],
	options: BuildAuthzModelOptions = {},
): AuthzModel {
	const defaultResourceType = options.defaultResourceType ?? "Tool";
	const seen = new Set<string>();
	const groupIds = new Set<string>();
	const resourceTypes = new Set<string>();

	const actions: ActionDef[] = [];
	for (const input of inputs) {
		if (seen.has(input.id)) {
			throw validationError("authz model invalid", "duplicate action id", {
				actionId: input.id,
			});
		}
		seen.add(input.id);

		const access = input.governance?.access ?? "write";
		const declared = input.governance?.groups ?? [];
		const groups = [...new Set([...declared, accessGroup(access)])].sort();
		const resourceType = input.governance?.resource ?? defaultResourceType;
		for (const group of groups) groupIds.add(group);
		resourceTypes.add(resourceType);

		actions.push({
			id: input.id,
			groups,
			resourceType,
			...(input.args !== undefined ? { args: input.args } : {}),
			access,
			source: input.source,
			...(input.governance?.audit !== undefined
				? { audit: input.governance.audit }
				: {}),
		});
	}

	actions.sort((a, b) => a.id.localeCompare(b.id));
	const groups: ActionGroupDef[] = [...groupIds]
		.sort()
		.map((id) => ({ id }) as ActionGroupDef);
	const entityTypes: EntityTypeDef[] = [...resourceTypes]
		.sort()
		.map((type) => ({ type }) as EntityTypeDef);

	const version =
		options.version ??
		fnv1a32(JSON.stringify({ actions, entityTypes, groups }));
	return { version, actions, groups, entityTypes };
}

// A tiny stable content hash for the default version pin. Drift detection only (a changed model
// must produce a changed version) — NOT cryptographic; pass `options.version` (e.g. a real spec
// digest) when provenance matters.
function fnv1a32(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
