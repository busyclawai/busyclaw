// What every tool source must produce — the one-path invariant as types: whatever the format
// (OpenAPI today; MCP, GraphQL next), extraction emits governance-stamped tool definitions that
// feed buildAuthzModel and the catalog identically, and reports every non-extracted operation.
// Inputs are deliberately NOT contracted: sources differ there (a spec document, a live MCP
// connection, an SDL string) — only the output shape is shared. Promoted from runtime to contracts
// (slice 5): the tool registry stores these as rows, so a non-runtime tier now consumes the type.

import { type } from "arktype";
import type { JsonObject } from "../common";
import type { ToolGovernance } from "../govern";

/** One extracted tool: model-facing schema + authz facts + format-specific invocation binding. */
export type SourceTool<Binding> = {
	name: string;
	description?: string;
	/** One flat object schema (JSON Schema) — what the model sees and the projection reads. */
	inputSchema: JsonObject;
	/** Facts stamped by the source: access, groups, … — flows into buildAuthzModel unchanged. */
	governance: ToolGovernance;
	binding: Binding;
};

/** One reported drop. `subject` names the dropped thing in the source's own vocabulary
 *  ("get /pets", "mutation createPet"); formats intersect extra structured fields on top —
 *  undeclared keys pass through the schema (arktype's default), so a format's extra fields
 *  (e.g. the OpenAPI extractor's `method`/`path`) survive storage round-trips. */
export const sourceDiagnostic = type({
	subject: "string",
	reason: "string",
});
export type SourceDiagnostic = typeof sourceDiagnostic.infer;

/** Every source's result: the tools, plus what did NOT extract and why — never silent. */
export type SourceExtraction<
	Binding,
	Diagnostic extends SourceDiagnostic = SourceDiagnostic,
> = {
	tools: SourceTool<Binding>[];
	/** Operations that did NOT become tools, and why. */
	skipped: Diagnostic[];
	/** Operations that became tools with a caveat (e.g. an optional unsupported param dropped). */
	warnings: Diagnostic[];
};
