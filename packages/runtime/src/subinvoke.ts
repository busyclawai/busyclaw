import type { AbortLifetime, HandleResult } from "@busyclaw/contracts";

/** Governed nested tool invocation, handed to invoker-stamped tools' execute.
 *  Full pipeline (redact → gates → execute → audit); NO effect claim; a
 *  needs-approval outcome is converted to a denied value (see the runtime wiring).
 *  `path` is the tool's CANONICAL id (`docs.admin.publish`) — a nested caller is
 *  inside the runtime, past the provider edge, so it never speaks wire names. */
export type SubInvoke = (
	path: string,
	args: Record<string, unknown>,
	ctx?: Record<string, unknown>,
	/** The CALLER's lifetime for this one call — a sandbox execution's, say, which ends before the
	 *  run does. Combined with the run's signal, never substituted for it: this narrows a lifetime
	 *  and must not widen one. Absent ⇒ the run's own signal is the only bound, which is what an
	 *  ordinary caller wants. */
	options?: { signal?: AbortLifetime },
) => Promise<HandleResult>;

/** An invoker-stamped tool cannot itself be reached through a nested call — fail closed. */
export const NESTED_INVOKER_TOOL = "NESTED_INVOKER_TOOL";
/** A nested call that a gate wants to park has no durable home — fail closed as a value. */
export const NESTED_APPROVAL_UNSUPPORTED = "NESTED_APPROVAL_UNSUPPORTED";
/** A nested call that cannot safely run twice has no effect ledger behind it — fail closed. */
export const NESTED_EFFECT_UNSUPPORTED = "NESTED_EFFECT_UNSUPPORTED";
