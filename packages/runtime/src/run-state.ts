// Per-run, per-step loop state — mutated across the model loop (runtime, ai-sdk-loop,
// model-middleware). It lives here, not under tools/, because it is LOOP state, not tool
// machinery: keeping it in the tools barrel forced tools/ to reach upward into ../events and
// ../runtime and mixed loop concerns into the tool subsystem's public surface.

import type { RunMode } from "@euroclaw/contracts";
import { stateError } from "@euroclaw/contracts";
import type { ModelMessage } from "ai";
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
	/** Durable run identity (engine run id) — stable across attempts and yield slices. */
	runId?: string;
	/** How this run was triggered — stamped into every gated call's context as `euroclaw__runMode`
	 *  (spoof-proof: the runtime sets it from the ENTRY POINT, never the model/caller). Defaults to
	 *  "autonomous" (fail-closed: an unattended run must not silently pass write policies). */
	runMode: RunMode;
	/** The authenticated caller that initiated this run (the api `{ principal }`, threaded from the
	 *  ENTRY POINT via {@link runtimeRunOptionsWithCaller} — never the model/ctx). When present the
	 *  trusted context assembly SEEDS it as `euroclaw__principal`, so the run's principal IS the caller
	 *  (the caller wins over the `identity` resolver, which is the caller-LESS fallback). Absent for
	 *  autonomous runs (cron/engine resume) — identity resolver / a system principal covers those. */
	callerPrincipal?: string;
	/** The approver of a granted `needs-approval` this run is resuming — the ApprovalRecord's `decidedBy`
	 *  (forge-proof: read from the persisted, PEP-gated approval, never the model/caller). When present the
	 *  trusted context assembly seeds it as `euroclaw__approvedBy`, so the replayed action's audit records
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
export function abortIfNeeded(signal: RuntimeAbortSignal | undefined): void {
	if (signal?.aborted) throw stateError("runtime aborted");
}
