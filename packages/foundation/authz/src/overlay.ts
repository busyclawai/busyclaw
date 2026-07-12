// The facts overlay — a customer's per-action override of the DERIVED model facts, and the mapper
// that turns stored registered-tool rows into action inputs. Overlay-wins per field (access,
// resource, audit REPLACE; groups REPLACES when present — replacement is the predictable rule, never
// a union). A write→read change is a LOOSENING: still applied (the report is the guardrail, per the
// plan), but returned loudly so boot/registration can surface it — never silent. A duplicate
// override for one action id is a config bug and THROWS (same posture as buildAuthzModel's
// duplicate-id throw). An override whose action id matched nothing is reported (a typo must not
// vanish). Both this and the row mapper feed buildAuthzModel — the model is the convergence point.

import {
	type ActionAccess,
	type JsonObject,
	type ToolGovernance,
	toolGovernance,
} from "@euroclaw/contracts";
import { configurationError, validationError } from "@euroclaw/errors";
import { type } from "arktype";
import type { AuthzActionInput } from "./build";

export type FactsOverlayEntry = {
	actionId: string;
	access?: ActionAccess;
	groups?: readonly string[];
	resource?: string;
	audit?: boolean;
};

// The entry seam is a real boundary: overlay facts arrive as stored rows (already parsed, but
// carrying extra columns) OR as a host-authored config object (unvalidated). One arktype gates
// both — and `"+": "delete"` strips undeclared keys, so the merge below is a plain spread of
// exactly the overridable facts, never a field-by-field dance. Validated on a shallow copy: the
// delete morph must not mutate the caller's row.
const overlayFacts = type({
	actionId: "string",
	"access?": "'read' | 'write'",
	"groups?": "string[]",
	"resource?": "string",
	"audit?": "boolean",
	"+": "delete",
});

export type OverlayMergeResult = {
	inputs: AuthzActionInput[];
	/** write→read downgrades — surface these loudly at boot/registration; never silent. */
	loosenings: { actionId: string; from: ActionAccess; to: ActionAccess }[];
	/** overlay rows whose actionId matched nothing — a typo'd override must not vanish. */
	unmatched: string[];
};

/**
 * Merge a customer facts overlay onto the derived action inputs. Overlay-wins per field; write→read
 * downgrades are reported (still applied); unmatched overrides are reported; a duplicate override
 * throws.
 */
export function mergeFactsOverlay(
	inputs: readonly AuthzActionInput[],
	overlay: readonly FactsOverlayEntry[],
): OverlayMergeResult {
	const byAction = new Map<string, typeof overlayFacts.infer>();
	for (const raw of overlay) {
		const entry = overlayFacts({ ...raw });
		if (entry instanceof type.errors) {
			throw validationError("facts overlay entry invalid", entry.summary);
		}
		if (byAction.has(entry.actionId)) {
			throw configurationError("facts overlay has a duplicate override", {
				actionId: entry.actionId,
			});
		}
		byAction.set(entry.actionId, entry);
	}

	const matched = new Set<string>();
	const loosenings: OverlayMergeResult["loosenings"] = [];
	const merged = inputs.map((input) => {
		const entry = byAction.get(input.id);
		if (!entry) return input;
		matched.add(input.id);

		if (entry.access !== undefined) {
			// Fail-closed default: an action with no stamped access is already a write.
			const from = input.governance?.access ?? "write";
			if (from === "write" && entry.access === "read") {
				loosenings.push({ actionId: input.id, from, to: entry.access });
			}
		}

		// `entry` holds exactly the overridable facts (undeclared keys deleted, absent stay absent).
		const { actionId: _actionId, ...facts } = entry;
		const governance: ToolGovernance = { ...input.governance, ...facts };
		return { ...input, governance };
	});

	const unmatched = [...byAction.keys()].filter((id) => !matched.has(id));
	return { inputs: merged, loosenings, unmatched };
}

/**
 * Map stored registered-tool rows to action inputs. Structural row type (authz never imports
 * storage): `governance` arrives typed as `ToolGovernance` (the registry column is schema-first, so
 * the store validated it on read), but authz re-validates it through the contracts `toolGovernance`
 * schema anyway — it can't rely on any particular caller's boundary, so a hostile stamp fails LOUD
 * here, at model-assembly time, not silently downstream.
 */
export function actionInputsFromRegisteredTools(
	rows: readonly {
		address: string;
		governance: ToolGovernance;
		inputSchema: JsonObject;
	}[],
): AuthzActionInput[] {
	return rows.map((row) => {
		const governance = toolGovernance(row.governance);
		if (governance instanceof type.errors) {
			throw validationError(
				"registered tool governance invalid",
				governance.summary,
				{ address: row.address },
			);
		}
		return {
			id: row.address,
			source: "tool" as const,
			governance,
			args: row.inputSchema,
		};
	});
}
