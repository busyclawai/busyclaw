/**
 * The multi-schema acceptance mechanism (schema captured as its own generic, input type computed
 * via the `ToolInput<S>` unwrap) is adapted from Elysia's `UnwrapSchema` pattern (`src/types.ts`;
 * patterns, not copied code), Copyright 2022 saltyAom, licensed under the MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

// @euroclaw/vendors/ai-sdk — euroclaw's `tool()`: the AI-SDK tool helper with governance attached
// at authoring time. One definition carries both surfaces: the model-facing tool (description/
// inputSchema/execute, input inference preserved) and the euroclaw stamp (gate/effect/invoker +
// the authz-model facts access/groups/resource/audit — what the OpenAPI/MCP generators derive
// from specs, an author declares here). `govern()` remains the ADOPTION path for tools you didn't
// author (and the escape hatch for exotic AI-SDK fields: streaming hooks, provider-defined
// tools); both produce the identical stamped shape, read back by the runtime's validated
// `toolGovernance()` reader.
//
// Multi-schema `inputSchema` follows the Elysia pattern (elysia src/types.ts
// StandardSchemaV1Like / UnwrapSchema): the schema is captured as its own generic and the input
// type is COMPUTED from it — zod / `jsonSchema()` / lazy pass through the AI SDK's own union;
// standard-schema libraries are detected by the `~standard` marker. The interop contracts
// (marker, guards, JSON-Schema capability) live in @euroclaw/contracts/standard-schema — this
// module owns only the ai-coupled half. Where euroclaw goes beyond Elysia: a tool schema must
// also produce the JSON Schema sent to the provider (Elysia keeps standard schemas opaque
// validators), so bridging is CAPABILITY-based — a standard schema that can emit JSON Schema
// (arktype's `toJsonSchema()`) is bridged; one that can't fails loud rather than shipping a
// silently broken tool definition.

import {
	configurationError,
	govern,
	hasToJsonSchema,
	isStandardSchema,
	type JsonSchemaSource,
	type StandardResult,
	type StandardSchemaV1Like,
	type ToolGovernance,
} from "@euroclaw/contracts";
import {
	jsonSchema,
	type Schema,
	type Tool,
	type ToolExecuteFunction,
} from "ai";

/** The AI SDK's schema union (`FlexibleSchema` — not exported by `ai`, extracted via `Tool`). */
// biome-ignore lint/suspicious/noExplicitAny: the constraint position needs the widest schema union
type SdkSchema<T = any> = Tool<T, never>["inputSchema"];

/** What `tool()` accepts as `inputSchema`: the AI SDK's own union, or any standard schema. */
export type ToolSchemaLike = SdkSchema | StandardSchemaV1Like;

/** The input type COMPUTED from the captured schema generic (Elysia's UnwrapSchema move).
 *  Standard-marked schemas resolve through the `types` phantom; the AI SDK's own union resolves
 *  by inference against its members (`ai` doesn't export `InferSchema`; this is equivalent). */
export type ToolInput<S> =
	S extends StandardSchemaV1Like<unknown, infer Out>
		? Out
		: S extends SdkSchema<infer T>
			? T
			: never;

/** The shape `tool()` constructs — plain and honest, no AI-SDK conditional variants. It is
 *  structurally assignable to the AI SDK's `Tool` (asserted by a type test), so it drops into
 *  any `ToolSet`. euroclaw tools are always executable: the chokepoint requires `execute`. */
export type AuthoredTool<I, O> = {
	description?: string;
	inputSchema: SdkSchema<I>;
	// CONTEXT = unknown: euroclaw tools are context-agnostic — the runtime injects capabilities
	// (subInvoke) through its own blessed seam, never through the AI SDK toolsContext channel.
	execute: ToolExecuteFunction<I, O, unknown>;
};

/** A tool carrying its governance stamp — what euroclaw's `tool()` returns. */
export type GovernedTool<T = AuthoredTool<unknown, unknown>> = T & {
	euroclaw: ToolGovernance;
};

export function tool<const S extends ToolSchemaLike, OUTPUT>(
	definition: {
		description?: string;
		inputSchema: S;
		execute: ToolExecuteFunction<ToolInput<S>, OUTPUT, unknown>;
	} & ToolGovernance,
): GovernedTool<AuthoredTool<ToolInput<S>, OUTPUT>> {
	// Split the stamp off the AI-SDK definition; drop undefined facts so the stamp stays clean
	// (an absent `access` must read as absent — the model builder's fail-closed default owns it).
	const { gate, effect, invoker, access, groups, resource, audit, ...rest } =
		definition;
	return govern(
		{
			...rest,
			inputSchema: resolveInputSchema<ToolInput<S>>(rest.inputSchema),
		},
		{
			...(gate !== undefined ? { gate } : {}),
			...(effect !== undefined ? { effect } : {}),
			...(invoker !== undefined ? { invoker } : {}),
			...(access !== undefined ? { access } : {}),
			...(groups !== undefined ? { groups } : {}),
			...(resource !== undefined ? { resource } : {}),
			...(audit !== undefined ? { audit } : {}),
		},
	);
}

// Route the schema by detection: standard-marked + JSON-Schema-capable → bridge; zod → pass
// through (the AI SDK supports it natively); other standard vendors → loud failure (bare
// standard-schema defines validation only — no JSON Schema for the provider would mean silently
// shipping a broken tool definition); everything else is already the AI SDK's own union. The two
// pass-through casts are variance-only (the generic `I` is unprovable inside the function; the
// public signature carries the real typing).
function resolveInputSchema<I>(schema: ToolSchemaLike): SdkSchema<I> {
	if (isStandardSchema(schema)) {
		if (hasToJsonSchema(schema)) {
			return standardSchema(
				schema as StandardSchemaV1Like<unknown, I> & JsonSchemaSource,
			);
		}
		if (schema["~standard"].vendor === "zod") return schema as SdkSchema<I>;
		throw configurationError(
			`inputSchema vendor "${schema["~standard"].vendor}" cannot emit JSON Schema (no toJsonSchema()) — pass the AI SDK's jsonSchema()/zod, or a schema library that can (e.g. arktype)`,
			{ vendor: schema["~standard"].vendor },
		);
	}
	return schema as SdkSchema<I>;
}

/**
 * Bridge a JSON-Schema-capable standard schema (e.g. an arktype `Type`) into the AI SDK's
 * `Schema` (used automatically by `tool()`; exported for direct use with plain `aiTool`). The
 * provider-facing JSON Schema comes from the library's own `toJsonSchema()`; validation runs
 * through `~standard.validate`, so morphs/normalization apply before `execute` sees the args.
 * `toJsonSchema()` throws on constructs JSON Schema cannot express — a fail-loud authoring
 * error, not a silent lossy tool definition.
 */
export function standardSchema<T>(
	schema: StandardSchemaV1Like<unknown, T> & JsonSchemaSource,
): Schema<T> {
	const json = schema.toJsonSchema() as Parameters<typeof jsonSchema>[0];
	return jsonSchema<T>(json, {
		validate: (value) => {
			const result = schema["~standard"].validate(value);
			return result instanceof Promise
				? result.then(toValidation)
				: toValidation(result);
		},
	});
}

function toValidation<T>(
	result: StandardResult<T>,
): { success: true; value: T } | { success: false; error: Error } {
	return result.issues === undefined
		? { success: true, value: result.value }
		: {
				success: false,
				error: new Error(result.issues.map((i) => i.message).join("; ")),
			};
}

export type {
	JsonSchemaSource,
	StandardSchemaV1Like,
	ToolEffectPolicy,
	ToolGate,
	ToolGovernance,
} from "@euroclaw/contracts";
export { govern, hasToJsonSchema, isStandardSchema } from "@euroclaw/contracts";
