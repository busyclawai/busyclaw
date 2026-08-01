// The governed route builder — `route.input().output().authz().handler()`.
//
// WHY A BUILDER AND NOT A DATA FIELD. Authorization used to be an OPTIONAL `resource` binding on a
// route definition, and a method that declared none got a resource shape whose owner WAS the caller:
// the PEP then asked Cedar "does the caller own this?" about a resource it had just defined as
// caller-owned. Cedar answered correctly; the question was rigged. 27 of 39 core methods were in that
// state. No policy can fix it, because the forgery happens upstream of policy evaluation.
//
// A required field would have closed it, but it makes the CHEAPEST thing to type ("no resource") the
// insecure thing. This builder inverts that: `.handler()` is not callable until `.authz()` has run.
// The mechanism is a phantom `Authorized` type parameter — `handler` is typed as an error-producing
// function while it is `false`, so forgetting the check is a compile error that names its own fix.
// Lifted from quickhr's `authorizedProcedure` facade, which does the same over oRPC.
//
// Types make OMISSION impossible. They cannot make the CHOICE correct — nothing can check that
// `getMessage` resolves the message rather than something else convenient. That is what the boot-time
// coverage walk and the cross-principal tests are for.

import type { EndpointHttpMethod } from "./endpoints";
import type { ClawApiCaller, Principal } from "./principal";

/** An action's required permission level, ordered `read < use < manage`.
 *
 *  Written out here rather than aliased from `AccessGrantPermission` so this module stays a LEAF. The
 *  client's wire allowlist requires every transitively-reachable wire module to carry no arktype doc
 *  metadata, and importing the grant module would drag entity.ts into that closure. The two must stay
 *  one vocabulary all the same, so authz/grant.ts carries a compile-time assertion that they are the
 *  identical union — divergence is a type error there, not a silent second scale. */
export type RouteLevel = "read" | "use" | "manage";

/**
 * What a route's authz resolver returns — the thing the call is authorized AGAINST.
 *  - `{ kind, id }`      a shared row: loaded through the resource registry, then owner ∪ scope ∪ grant.
 *  - `{ scope, scopeId }` an opaque access boundary: verified membership only, no owner. Both halves
 *                         come from the input and mean nothing to core — an organization is a plugin.
 * A resolver that cannot produce either DENIES. It never falls back to a caller-owned shape.
 */
export type AuthzTarget =
	| { readonly kind: string; readonly id: string }
	| { readonly scope: string; readonly scopeId: string };

/**
 * The two ways to ask the PEP a question mid-handler — `ctx.authz.enforce` for one resource,
 * `ctx.authz.filter` for many. Grouped under their own key rather than spread onto the context so the
 * decision surface is one namable thing: a handler reading `ctx.authz.filter(...)` says what it is
 * doing, and a future third way to ask has an obvious home.
 */
export type AuthzDecisions = {
	/**
	 * Authorize an additional resource mid-handler, or throw `authorizationError`. Named `enforce`
	 * rather than `check` because it does not RETURN a verdict — `if (await ctx.authz.check(…))` would
	 * await `undefined` and take the denied branch on a permitted call, which is a silent inversion.
	 *
	 * Decided as THIS method unless `asMethod` names another. That matters for a LISTING: a listing has
	 * no id, so it is declared caller-only, so it sits in the `creates` group the sealed baseline
	 * permits for any authenticated principal — and a per-row check decided as the listing would
	 * inherit that permit and pass for everyone. A listing filters by asking the question its SINGLE-ROW
	 * read asks, so it names that method.
	 */
	readonly enforce: (
		level: RouteLevel,
		target: AuthzTarget,
		asMethod?: string,
	) => Promise<void>;
	/**
	 * Authorize MANY resources and return the ones that survive — the listing primitive, and what a
	 * listing should use instead of `enforce` in a loop.
	 *
	 * Same decision as {@link AuthzDecisions.enforce} per row, with three differences that only make sense
	 * in bulk: the caller's scope memberships are resolved ONCE for the whole set rather than re-asking
	 * the host's resolver per row, and the grants for every row are fetched in ONE query rather than one
	 * per row; the rows are decided with BOUNDED concurrency, so a thousand-row page cannot open a
	 * thousand simultaneous reads; and a row that DENIES is dropped rather than thrown, because one
	 * unreadable row must not fail the page. A row whose decision ERRORS is also dropped — fail-closed,
	 * the same answer `enforce` would reach by throwing.
	 *
	 * `asMethod` matters here for the same reason it matters on `check`, and more sharply: a listing is
	 * declared caller-only, so it sits in the `creates` group the sealed baseline permits for any
	 * authenticated principal. Decided as the listing, every row would pass. Name the SINGLE-ROW read.
	 *
	 * Cedar has no bulk authorize (`isAuthorized` takes one request), so this is not a batched
	 * evaluation — it is the per-row evaluation with the per-CALL work lifted out of the loop.
	 */
	readonly filter: <T>(
		level: RouteLevel,
		rows: readonly T[],
		target: (row: T) => AuthzTarget,
		asMethod?: string,
	) => Promise<T[]>;
};

/** The imperative half, handed to every handler. The declarative `.authz()` gate has already run; this
 *  is for checks that only become expressible once the handler has loaded something. You can always
 *  demand MORE than you declared, never less. */
export type AuthzContext = {
	/** The out-of-band caller as received. */
	readonly caller: ClawApiCaller;
	/** The caller's principal, guaranteed present and non-blank — the principal floor ran before the
	 *  handler was entered, so a handler never has to re-check it. Branded, because it IS one: a handler
	 *  stamping an identity column takes it straight, with no re-parse and no cast to reach the brand. */
	readonly principal: Principal;
	/** Ask the PEP about something the handler has since loaded — see {@link AuthzDecisions}. */
	readonly authz: AuthzDecisions;
};

/** The boundary validator a route declares — an arktype type in practice. */
export type RouteInputSchema = (input: unknown) => unknown;
/** The declared response schema, structural against its `infer` phantom. Pins the handler's return
 *  type; never runtime-validated (a handler result is trusted server code). */
export type RouteOutputSchema = { readonly infer: unknown };

/** Surfaced as the type of `.handler` until `.authz()` has been called. Calling it with a real handler
 *  fails with this string in the error, so the message carries its own fix. */
type RequireAuthz = (
	AUTHZ_REQUIRED: "❌ Call .authz(level, resolve) — or .authz(null, reason) — before .handler(): every route must say what it authorizes against",
) => never;

/** How a route resolved its authorization, carried into the route metadata so the assembled api can be
 *  audited: which routes authorize against a real resource, and which against nothing but the caller. */
export type RouteAuthz =
	| {
			readonly mode: "resource";
			readonly level: RouteLevel;
			readonly resolve: (input: never) => AuthzTarget | Promise<AuthzTarget>;
	  }
	| { readonly mode: "caller"; readonly reason: string };

/** A built route — what `.handler()` returns and `endpoints()` collects. Generic in the handler's INPUT
 *  and OUTPUT so the collector can rebuild a typed namespace from a record of these; erasing them here
 *  would erase them from `claw.api`. The NAME is not here: it comes from the record key the route is
 *  declared under, so it is written exactly once. */
export type RouteDefinition<In = never, Out = unknown> = {
	readonly input: RouteInputSchema;
	readonly output?: RouteOutputSchema;
	readonly authz: RouteAuthz;
	readonly handler: (input: In, ctx: AuthzContext) => Out | Promise<Out>;
	readonly method?: EndpointHttpMethod;
	readonly description?: string;
};

type Handler<In, Out> = (input: In, ctx: AuthzContext) => Out | Promise<Out>;

/** The "no `.output()` declared" marker. A distinct unique symbol rather than `unknown`, because every
 *  type extends `unknown` — a conditional on it would always take the same branch and the handler's
 *  return would never be pinned. */
declare const UNSET: unique symbol;
type Unset = typeof UNSET;

/**
 * The builder, threaded with three type parameters: the handler INPUT (set by `.input()`), the handler
 * OUTPUT (set by `.output()`; `unknown` means unconstrained and the return is inferred), and the phantom
 * `Authorized` flag that `.authz()` flips and `.handler()` reads.
 */
export interface RouteBuilder<In, Out, Authorized extends boolean> {
	/** Declare the boundary schema. The handler's input type — and the authz resolver's — come from here. */
	input<S extends RouteInputSchema>(
		schema: S,
	): RouteBuilder<
		S extends { readonly infer: infer T } ? T : unknown,
		Out,
		Authorized
	>;

	/** Pin the handler's return type and document the OpenAPI 200 `data`. */
	output<S extends RouteOutputSchema>(
		schema: S,
	): RouteBuilder<In, S["infer"], Authorized>;

	/** Verb override; absent ⇒ the shared `get*`/`list*` → GET rule applied to the record key. */
	method(method: EndpointHttpMethod): RouteBuilder<In, Out, Authorized>;

	/** Operation summary for the OpenAPI generator. */
	description(text: string): RouteBuilder<In, Out, Authorized>;

	/**
	 * Resolve the resource this route authorizes against. The resolver's input is typed from
	 * `.input()`, so a field that does not exist is a compile error. Returning an unresolvable target
	 * denies.
	 */
	authz(
		level: RouteLevel,
		resolve: (input: In) => AuthzTarget | Promise<AuthzTarget>,
	): RouteBuilder<In, Out, true>;

	/**
	 * Declare that this route authorizes against NOTHING but the caller — a genuine create, or a row
	 * keyed to the caller themselves. The reason is REQUIRED and is carried into the route metadata, so
	 * "which routes authorize against nothing shared, and why" is a question the assembled api can
	 * answer rather than one an auditor has to reconstruct.
	 */
	authz(level: null, reason: string): RouteBuilder<In, Out, true>;

	/** Attach the handler and build the route. Unreachable until `.authz()` has run. With no `.output()`
	 *  the return type is INFERRED from the handler; with one, it is pinned to the schema. */
	handler: [Authorized] extends [true]
		? [Out] extends [Unset]
			? <R>(handler: Handler<In, R>) => RouteDefinition<In, Awaited<R>>
			: (handler: Handler<In, Out>) => RouteDefinition<In, Out>
		: RequireAuthz;
}

type RouteState = {
	input?: RouteInputSchema;
	output?: RouteOutputSchema;
	authz?: RouteAuthz;
	method?: EndpointHttpMethod;
	description?: string;
};

/**
 * The RUNTIME shape of the builder — one plain object whose methods return more of itself. The public
 * {@link RouteBuilder} is a type-level state machine over this same value: its method signatures change
 * with the phantom `Authorized` parameter, which no single runtime type can express. Keeping the
 * implementation typed against this concrete shape means the body below is fully checked, and the whole
 * overlay costs exactly ONE cast, at the export.
 */
type BuilderRuntime = {
	input: (schema: RouteInputSchema) => BuilderRuntime;
	output: (schema: RouteOutputSchema) => BuilderRuntime;
	method: (method: EndpointHttpMethod) => BuilderRuntime;
	description: (text: string) => BuilderRuntime;
	authz: (
		level: RouteLevel | null,
		second: string | ((input: never) => AuthzTarget | Promise<AuthzTarget>),
	) => BuilderRuntime;
	handler: (
		handler: (input: never, ctx: AuthzContext) => unknown,
	) => RouteDefinition;
};

function build(state: RouteState): BuilderRuntime {
	const next = (patch: RouteState) => build({ ...state, ...patch });
	return {
		input: (schema) => next({ input: schema }),
		output: (schema) => next({ output: schema }),
		method: (method) => next({ method }),
		description: (text) => next({ description: text }),
		authz: (level, second) =>
			next({
				authz:
					level === null
						? { mode: "caller", reason: second as string }
						: {
								mode: "resource",
								level,
								resolve: second as (
									input: never,
								) => AuthzTarget | Promise<AuthzTarget>,
							},
			}),
		handler: (handler) => {
			// A JS caller can reach here past the type gate. Refuse at declaration rather than serving an
			// unauthorized route: an unbuilt authz is exactly the state this whole module exists to make
			// impossible, so it must not degrade into "no check".
			if (state.authz === undefined) {
				throw new Error(
					"busyclaw route: .handler() called before .authz() — every route must declare what it authorizes against",
				);
			}
			if (state.input === undefined) {
				throw new Error(
					"busyclaw route: .handler() called before .input() — a route with no boundary schema would pass unvalidated network input to the handler",
				);
			}
			const definition: RouteDefinition = {
				input: state.input,
				authz: state.authz,
				handler,
				...(state.output !== undefined ? { output: state.output } : {}),
				...(state.method !== undefined ? { method: state.method } : {}),
				...(state.description !== undefined
					? { description: state.description }
					: {}),
			};
			return definition;
		},
	};
}

/**
 * Start a governed route. The chain is `.input(...)` → optional `.output(...)` → `.authz(...)` →
 * `.handler(...)`, and the name comes from the record key you declare it under.
 *
 * THE ONE CAST. `build()` is fully typed against {@link BuilderRuntime}; this attaches the type-level
 * state machine to it. The two shapes cannot overlap by construction — an unauthorized builder types
 * `handler` as {@link RequireAuthz}, a function of a literal string returning `never`, which no working
 * implementation can satisfy. That mismatch IS the gate, so the seam is where it belongs: one place,
 * named, rather than smeared across every method body.
 */
export const route = build({}) as unknown as RouteBuilder<
	unknown,
	Unset,
	false
>;
