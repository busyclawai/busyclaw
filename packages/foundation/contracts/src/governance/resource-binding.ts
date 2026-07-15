// How a governed method declares the shared resource it acts on — the app-authz PEP reads this to
// resolve the (kind, id) it loads for the generic owner∪scope∪grant check. The binding is CO-LOCATED
// with the method's own def (the base api route def in `euroclaw`, or a plugin `endpoints()` def), NOT
// a separate parallel map — the "derive from the api itself" principle. Because it rides the def, it is
// TYPE-CHECKED against that method's INPUT: `idKey`/`kindKey` must be keys of the input, or it does not
// compile. A method with NO binding is not resource-anchored (it acts within the caller's personal
// scope). Fail-closed downstream: a key that resolves to nothing loads no row and DENIES.

/** The input keys a binding may point at — the method-input's own keys, narrowed to strings. Constrains
 *  `idKey`/`kindKey` so a field absent from the input fails to compile (the point of co-location). */
export type ResourceInputKey<Input> = Extract<keyof Input, string>;

/**
 * A governed method's resource binding, a tagged union over the two cases:
 *  - STATIC kind: the resource kind is fixed (`kind`); the id comes from `input[idKey]`.
 *  - DYNAMIC kind: both the kind and the id come from the input (`input[kindKey]`, `input[idKey]`) —
 *    the generic share/unshare case, where the target kind is caller-supplied.
 * `idKey`/`kindKey` are constrained to `Input`'s own keys, so a wrong key is a compile error.
 */
export type ResourceBinding<Input> =
	| { readonly kind: string; readonly idKey: ResourceInputKey<Input> }
	| {
			readonly kindKey: ResourceInputKey<Input>;
			readonly idKey: ResourceInputKey<Input>;
	  };

/** The loosely-typed binding carried STRUCTURALLY on an `EndpointDefinition`/`EndpointRoute` and read by
 *  the PEP loader (any string key). The `endpoints()` generic TIGHTENS it per-def to the handler input's
 *  keys (see `ValidateEndpointResources`); the loader only ever reads the keys back as plain strings. */
export type LooseResourceBinding = ResourceBinding<Record<string, unknown>>;
