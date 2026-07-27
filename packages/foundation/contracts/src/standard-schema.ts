/**
 * The minimal-marker shape is adapted from Elysia's `StandardSchemaV1Like` pattern
 * (`src/types.ts`; patterns, not copied code), Copyright 2022 saltyAom, licensed under
 * the MIT License. See THIRD_PARTY_NOTICES.md.
 */

// Standard-schema INTEROP — the structural contracts for accepting schemas from any
// standard-schema library (arktype, zod v4, valibot, …) without depending on one. The marker
// interface follows the Elysia pattern (minimal, reduced to what inference and validation
// actually need — not the full spec type); the guards are pure predicates, the same protocol
// grade as common.ts's JSON guards. Consumers: @busyclaw/vendors/ai-sdk (tool inputSchema
// routing), the authz model builder/generators (projected-args extraction) — the latter must
// never import a vendor SDK, which is why this seam lives in contracts.

/** One standard-schema issue (the spec guarantees `message`). */
export type StandardIssue = { readonly message: string };

/** A standard-schema validation result: success carries `value`, failure carries `issues`. */
export type StandardResult<T> =
	| { readonly value: T; readonly issues?: undefined }
	| { readonly issues: readonly StandardIssue[] };

/**
 * Minimal structural standard-schema marker. Detection is the `~standard` property; the `types`
 * phantom carries inference; `validate` is the vendor-neutral validation entry (morphs and
 * normalization included — it runs the library's own pipeline).
 */
export interface StandardSchemaV1Like<In = unknown, Out = In> {
	readonly "~standard": {
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) => StandardResult<Out> | Promise<StandardResult<Out>>;
		readonly types?: { readonly input: In; readonly output: Out } | undefined;
	};
}

/**
 * The JSON-Schema CAPABILITY — a schema that can emit the JSON Schema describing itself
 * (arktype's native `toJsonSchema()`). Checked structurally, never by vendor name: any library
 * that grows the method qualifies. Boundaries that must hand a schema to something JSON-Schema-
 * shaped (an LLM provider's tool definition, the authz model's projected args) require this
 * capability — bare standard-schema defines validation only.
 */
export type JsonSchemaSource = { toJsonSchema: () => unknown };

export function isStandardSchema(
	schema: unknown,
): schema is StandardSchemaV1Like {
	const kind = typeof schema;
	if (schema === null || (kind !== "object" && kind !== "function")) {
		return false;
	}
	return "~standard" in (schema as object);
}

export function hasToJsonSchema(schema: object): schema is JsonSchemaSource {
	return (
		"toJsonSchema" in schema &&
		typeof (schema as JsonSchemaSource).toJsonSchema === "function"
	);
}
