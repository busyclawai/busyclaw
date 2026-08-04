// The egress CEILING generated from a registered spec: Cedar text saying where the operations one
// registration brought in may reach, derived from the origins those operations themselves declare.
//
// FORBID ONLY, and that is the load-bearing decision. A spec states what an API offers, never who may
// use it — the document has no way to carry that and the operator has not been asked. A generated
// `permit` would make uploading a document an act of GRANTING, so a bigger spec would quietly mean
// more authority; that is the prefix-grant trap by another road. Forbid-only is also what makes
// generating on every registration safe: under a forbid-wins floor a ceiling can only narrow what an
// operator separately granted, and can never punch through the floor. Import grants nothing.
//
// The ceiling is a restatement of an invariant the registry already enforces on the TOOL path (a
// row's `credentialOrigin` is pinned and a re-registration may not move it), which is why it can be
// written straight to `enforce` — it cannot refuse a call the invoker would have allowed. Its real
// work is elsewhere: a sandbox guest doing `fetch()` has no row and no such invariant, and when that
// path gains a policy call this is the policy that answers it.

import type { ToolDescriptor } from "@busyclaw/contracts";
import { declaredOrigin } from "./invoke/request-plan";
import { sourceActionGroup } from "./registry";

/** One operation's contribution: its action id and the origin it declares. */
export type EgressPolicyOperation = {
	/** The Cedar action id — the row's address, `<source>.<tool>`. */
	address: string;
	/** The normalized origin from the operation's binding. */
	origin: string;
};

export type GenerateEgressPolicyInput = {
	source: string;
	operations: readonly EgressPolicyOperation[];
};

/** The slice name a source's generated ceiling is stored under. RESERVED: regeneration overwrites
 *  this name without asking, so nothing else may be written to it. */
export function egressPolicySliceName(source: string): string {
	return `${source}.egress`;
}

/** Cedar string literal — the origins come from `normalizeOrigin` (scheme + host only, no quotes or
 *  backslashes survive it), but the escape is here anyway: a generator that trusts its input to be
 *  quote-free produces a policy that fails to PARSE the day that stops being true, and a bundle that
 *  will not build is a claw that will not boot. */
function cedarString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The origin test, WITH its `has` guard — never write this bare.
 *
 * `server` is an optional context attribute, absent for every action that declares no reach (a
 * `local` closure, a meta-tool). Testing it bare on an action that has none is an evaluation error,
 * and Cedar's response to an erroring `forbid` is to SKIP it — so an unguarded ceiling fails OPEN on
 * exactly the actions that declared no destination. Verified against cedar-wasm, not assumed, and
 * pinned by a test that reads the unguarded form's decision.
 *
 * With the guard, `has` is false, the `unless` is false, and the forbid APPLIES: an action inside the
 * source that declares nowhere to go is refused. That is the right direction for a ceiling.
 */
function unlessOriginIn(origins: readonly string[]): string {
	const test = origins
		.map((origin) => `context.server == ${cedarString(origin)}`)
		.join(" || ");
	return origins.length === 1
		? `unless { context has server && ${test} };`
		: `unless { context has server && (${test}) };`;
}

/**
 * Generate the ceiling for one registration.
 *
 * TWO granularities, and the second is emitted only when it says something the first does not:
 *
 *  - The SOURCE rule always. It names the action group, so it covers operations this generator has
 *    never seen — one registered after the last generation, one whose specific rule an operator
 *    deleted. Without it, "not named by a rule" would mean "unconstrained", which is the same
 *    inert-fact failure as a policy no one stamps a fact for.
 *  - A per-OPERATION rule only when the source spans MORE THAN ONE origin. With a single origin every
 *    operation rule would restate the source rule at a narrower action scope — N statements saying
 *    what one already says, and N more lines for a reader to check are all identical. When a spec
 *    declares several servers the source rule alone WOULD let one operation reach another's origin,
 *    and that is exactly when the specific rules earn their place.
 *
 * They intersect, never union: both are forbids under a forbid-wins floor, so adding an operation can
 * only ever add another refusal. A generator whose output could WIDEN on re-import would be wrong
 * however convenient, so this must stay true.
 *
 * Returns undefined when there is nothing to say — a registration that extracted no operations has no
 * reach to bound, and an empty slice would be a rule that reads as a ceiling and holds nothing.
 */
export function generateEgressPolicy(
	input: GenerateEgressPolicyInput,
): string | undefined {
	if (input.operations.length === 0) return undefined;

	const origins = [
		...new Set(input.operations.map((operation) => operation.origin)),
	].sort();
	const group = sourceActionGroup(input.source);

	const statements = [
		`forbid(principal, action in Action::${cedarString(group)}, resource)\n${unlessOriginIn(origins)}`,
	];

	if (origins.length > 1) {
		// Sorted by address so re-registering an unchanged spec produces byte-identical text — the
		// slice's stored `cedar` is compared on write, and a generator whose output depended on
		// extraction order would report a change on every registration.
		const sorted = [...input.operations].sort((a, b) =>
			a.address.localeCompare(b.address),
		);
		for (const operation of sorted) {
			statements.push(
				`forbid(principal, action == Action::${cedarString(operation.address)}, resource)\n${unlessOriginIn([operation.origin])}`,
			);
		}
	}

	return statements.join("\n\n");
}

/** The operations of a descriptor set that declare an origin — the shape the generator wants, read
 *  through the SAME `declaredOrigin` the floor stamps `context.server` from, so the ceiling and the
 *  fact it tests can never disagree about what a tool declares. */
export function egressOperationsOf(
	descriptors: readonly ToolDescriptor[],
): EgressPolicyOperation[] {
	const operations: EgressPolicyOperation[] = [];
	for (const descriptor of descriptors) {
		const origin = declaredOrigin(descriptor);
		if (origin !== undefined) {
			operations.push({ address: descriptor.path, origin });
		}
	}
	return operations;
}
