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
	currentToolName: string;
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
	currentModelRunner?: () => unknown | Promise<unknown>;
	recording?: RuntimeRecordingContext;
	abortSignal?: RuntimeAbortSignal;
};

export function createRunState(): RunState {
	return {
		currentToolCallId: "",
		currentToolName: "",
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
