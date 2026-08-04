// Per-run, per-step loop state — mutated across the model loop (runtime, ai-sdk-loop,
// model-middleware). It lives here, not under tools/, because it is LOOP state, not tool
// machinery: keeping it in the tools barrel forced tools/ to reach upward into ../events and
// ../runtime and mixed loop concerns into the tool subsystem's public surface.

import type { Principal, RunMode } from "@busyclaw/contracts";
import { stateError } from "@busyclaw/contracts";
import type { ModelMessage } from "ai";
import type { RunAuthority } from "./authority";
import type { RuntimeRecordingContext } from "./events";
import type { RuntimeAbortSignal } from "./runtime";

export type RunState = {
	currentToolCallId: string;
	/** The CANONICAL id of the call in flight — the path, never the wire name the provider used.
	 *  The loop translates at ingress, so everything reading this (approval checkpoints, events,
	 *  effect ids) records the same id the policy decision did. */
	currentToolPath: string;
	/** The WIRE name the call arrived under. Read at exactly one site — parking an approval, so the
	 *  resumed tool result can be correlated the way the provider sent it. Usually the flattened
	 *  projection of the path and therefore re-derivable; not when the call arrived through the
	 *  `execute` meta-tool, which is why it is carried rather than recomputed. Never an id anything
	 *  decides or dispatches on. */
	currentToolWireName?: string;
	currentToolInput: unknown;
	currentMessages: ModelMessage[];
	currentStep: number;
	currentApprovalWaitId?: string;
	currentEffectId?: string;
	runInstanceId?: string;
	/** The run's identity — the engine run id when it has one (stable across attempts and yield
	 *  slices), otherwise minted per invocation, because an ad-hoc `generate` still has to be
	 *  correlatable: it is stamped as `busyclaw__runId` on every gated call and written onto the
	 *  approval a parked call leaves behind, which is the only join a claw-less run has. */
	runId?: string;
	/** How this run was triggered — stamped into every gated call's context as `busyclaw__runMode`
	 *  (spoof-proof: the runtime sets it from the ENTRY POINT, never the model/caller). Defaults to
	 *  "autonomous" (fail-closed: an unattended run must not silently pass write policies). */
	runMode: RunMode;
	/** The authenticated caller that initiated this run (the api `{ principal }`, threaded from the
	 *  ENTRY POINT via {@link runtimeRunOptionsWithCaller} — never the model/ctx). When present the
	 *  trusted context assembly SEEDS it as `busyclaw__principal`, so the run's principal IS the caller
	 *  (the caller wins over the `identity` resolver, which is the caller-LESS fallback). Absent for
	 *  autonomous runs (cron/engine resume) — identity resolver / a system principal covers those. */
	callerPrincipal?: Principal;
	/** The run's authority — principal, config scope, team/role, subject — resolved ONCE at the entry
	 *  point, before any tool is selected, and frozen. Every governance door STAMPS this rather than
	 *  re-running the host's resolvers, so the tool closure, the floor, the audit and the approval all
	 *  name the same principal in the same tenant. Absent only before the entry point has resolved it.
	 *  See {@link RunAuthority} for what each split used to cost. */
	authority?: RunAuthority;
	/** The approver of a granted `needs-approval` this run is resuming — the ApprovalRecord's `decidedBy`
	 *  (forge-proof: read from the persisted, PEP-gated approval, never the model/caller). When present the
	 *  trusted context assembly seeds it as `busyclaw__approvedBy`, so the replayed action's audit records
	 *  WHO approved it (beside the borrowed `principal`). Absent for a normal (non-resume) run. */
	approvedBy?: string;
	currentModelRunner?: () => unknown | Promise<unknown>;
	recording?: RuntimeRecordingContext;
	abortSignal?: RuntimeAbortSignal;
};

export function createRunState(): RunState {
	return {
		currentToolCallId: "",
		currentToolPath: "",
		currentToolInput: undefined,
		currentMessages: [],
		currentStep: 0,
		runMode: "autonomous",
	};
}

/** Throw if the run was aborted — checked at each loop/tool boundary. */
/** Marks the error `abortIfNeeded` throws, so a caller that wants to say WHY the run stopped can tell
 *  a deliberate abort from an unrelated failure that happened to land at the same moment. */
export const ABORTED_DETAIL = "runtimeAborted";

export function abortIfNeeded(signal: RuntimeAbortSignal | undefined): void {
	if (signal?.aborted) {
		throw stateError("runtime aborted", { [ABORTED_DETAIL]: true });
	}
}
