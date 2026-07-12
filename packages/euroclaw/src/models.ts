// Model extension — the better-auth `additionalFields` analog. A default model is a field map
// (`clawFields`, …); the host adds fields via `createClaw({ models: { claw: { additionalFields } } })`
// and plugins via `plugin.schema.claw.fields`. This module folds those into the merged field map per
// model (default < plugin < host) and re-derives the record + create-input types from it — the same
// literal drives the runtime schema/validators (assembly) and these inferred types, so they can't
// drift. Runtime persistence of the merged columns is wired in the assembly + stores.
import type {
	clawFields,
	createClawInputOptions,
	EntityField,
	EntityRecord,
	EntitySchemaInput,
	InferPluginSchema,
} from "@euroclaw/contracts";
import type { clawRedactionFields } from "./redaction";

/** Extra fields the host declares for model `M` via `createClaw({ models: { <M>: { additionalFields } } })`. */
export type HostModelFields<Config, M extends string> = Config extends {
	models: infer Models;
}
	? Models extends Record<M, { additionalFields: infer F }>
		? F extends Record<string, EntityField>
			? F
			: Record<never, never>
		: Record<never, never>
	: Record<never, never>;

/** The default field map of every extensible model. Widen as models are opened up. */
type DefaultModelFields = {
	claw: typeof clawFields;
};

/** A model that can be extended (host + plugin). */
export type ExtensibleModel = keyof DefaultModelFields & string;

/**
 * The assembly-owned `redaction` posture column — present on `claw` exactly when the config
 * declares per-claw posture. The runtime injection (tables.ts collectModelFields) mirrors this,
 * so the typed create-input and the persisted column come from one declaration.
 */
type RedactionModelFields<Config, M extends ExtensibleModel> = M extends "claw"
	? Config extends { redaction: { posture: "per-claw" } }
		? typeof clawRedactionFields
		: Record<never, never>
	: Record<never, never>;

/**
 * The merged field map for model `M` under a given config: the default fields, every plugin's
 * `schema[M].fields`, the host's `models[M].additionalFields` (default < plugin < host), and the
 * assembly's per-claw redaction column when declared.
 */
export type InferModelFields<
	Config,
	M extends ExtensibleModel,
> = DefaultModelFields[M] &
	InferPluginSchema<Config, M> &
	HostModelFields<Config, M> &
	RedactionModelFields<Config, M>;

/** The `claw` record as seen through a given config — base fields + plugin/host extensions. */
export type ClawRecordOf<Config> = EntityRecord<
	InferModelFields<Config, "claw">
>;

/** The `createClaw` input as seen through a given config. */
export type CreateClawInputOf<Config> = EntitySchemaInput<
	InferModelFields<Config, "claw">,
	typeof createClawInputOptions
>;

/**
 * Host-facing config for extending default models with extra columns — the `additionalFields` analog
 * of better-auth's `user.additionalFields`. Declared on `createClaw({ models })`; the fields become
 * real persisted, queryable columns surfaced on the record (see {@link HostModelFields}).
 */
export type ClawModelsConfig = {
	readonly claw?: { readonly additionalFields: Record<string, EntityField> };
};

// ── Compile-time core-column collision guard ─────────────────────────────────────────────────────
// getEuroclawTables throws at runtime if a plugin/host schema redefines a core column. The same rule,
// lifted to the type level for the extensible `claw` model, so `createClaw` rejects the collision at
// compile time. Scoped to `claw` (the type spine's model); the runtime guard still backstops the rest.

/** Column names the core `claw` model already owns — schema may add to these, never redefine them. */
type CoreClawColumns = keyof typeof clawFields;

/** Every claw column a config registers: host `additionalFields` + every plugin's `schema.claw.fields`. */
type RegisteredClawColumns<Config> =
	| keyof HostModelFields<Config, "claw">
	| keyof InferPluginSchema<Config, "claw">;

/** Registered claw columns that collide with a core column — `never` when there are none. */
type ClawColumnCollisions<Config> = Extract<
	RegisteredClawColumns<Config>,
	CoreClawColumns
>;

/** The shape a colliding config resolves to — the key strings surface the problem in the type error. */
type CoreColumnCollisionError<Columns extends PropertyKey> = {
	readonly "ERROR: a plugin or host schema redefines a core claw column": never;
	readonly redefinedColumns: Columns;
	readonly "FIX: rename the field — schema may add columns, never rewrite a core one": never;
};

/**
 * `createClaw` constraint: reject at compile time any config whose plugin or host schema redefines a
 * core `claw` column — the compile-time mirror of {@link getEuroclawTables}' runtime guard. Resolves to
 * `unknown` (no-op) when there's no collision, so valid configs are untouched.
 */
export type RequireNoCoreColumnCollision<Config> = [
	ClawColumnCollisions<Config>,
] extends [never]
	? unknown
	: CoreColumnCollisionError<ClawColumnCollisions<Config>>;
