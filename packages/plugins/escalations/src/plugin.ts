// The `escalate` policy annotation, ROUTED. A policy names who should be asked
// (`@escalate("betterauth:team_eng")`); the engine only carries that value out because a plugin
// DECLARED the key (`policyAnnotations` is an allowlist, not documentation), and this plugin is the
// declaration plus the hand-off to the host.
//
// It also declares `guidance` — the same situation written for the AGENT rather than the host, which
// is all `audience: "model"` means. That one this plugin never sees: the engine keeps the two bags
// apart and the runtime hands the model's to the model. See {@link GUIDANCE_ANNOTATION}.
//
// It is an OBSERVER by construction: an after-gate cannot change permit/deny/needs-approval, and
// nothing here tries to. Escalation routing must never become a new way for a run to die — so a
// throwing `onEscalate` is swallowed and warned, exactly like a failing observer event sink.

import {
	type AfterGate,
	asPrincipal,
	type BusyclawPlugin,
	CLAW_ID_CONTEXT_KEY,
	errorMessage,
	type Outcome,
	PRINCIPAL_CONTEXT_KEY,
	type Principal,
	RUN_ID_CONTEXT_KEY,
	RUN_MODE_CONTEXT_KEY,
	type RunMode,
	THREAD_ID_CONTEXT_KEY,
	type TurnContext,
} from "@busyclaw/contracts";

/** The annotation key this plugin declares and consumes — what a policy writes as `@escalate("…")`. */
export const ESCALATE_ANNOTATION = "escalate";

/**
 * The other half of the same sentence, addressed to the other reader. Beside the two facts a blocked
 * call already carries — `reason` (why) and `@escalate` (who can unblock it, an id no agent should
 * ever see) — `@guidance` is what to DO about it, in the policy author's own words, written for the
 * agent that just hit the wall:
 *
 * ```cedar
 * @escalate("betterauth:team_eng")
 * @guidance("Salary fields need HR approval — ask the requester to route this to People Ops.")
 * permit(principal, action == Action::"read_salary", resource) when { context.confirmationUsed };
 * ```
 *
 * Declared here because this plugin already owns "the call did not go through — here is what to do",
 * and the two annotations are written on the same rule. NOTHING about it is special: it is one entry
 * in the ordinary `policyAnnotations` allowlist, and `audience: "model"` is what routes it to the
 * agent instead of to `onEscalate`. A host that wants a different vocabulary declares its own the
 * same way — a bare plugin object is enough, no package required:
 *
 * ```ts
 * plugins: [{ id: "house-style", policyAnnotations: [{ key: "hint", audience: "model" }] }]
 * ```
 *
 * The value is bounded (`MODEL_ANNOTATION_MAX_LENGTH`) and rejected at assembly if it overruns:
 * it lands in a context window, so it is a sentence, not a document.
 */
export const GUIDANCE_ANNOTATION = "guidance";

/**
 * One escalation, as it reaches the host: a governed call did not go through, and a policy said who
 * to ask about it. Everything here is READ off the finished call — the plugin decides nothing and
 * stores nothing.
 */
export type Escalation = {
	/**
	 * The annotation's value, VERBATIM: an authority-tagged `<authority>:<id>` (`betterauth:team_eng`,
	 * `workday:dept_456`, `app:accessibility-specialists`). Deliberately UNPARSED — the authority
	 * vocabulary belongs to the host and its adapters, so splitting on the colon here would
	 * re-introduce exactly the taxonomy that shape exists to avoid.
	 */
	target: string;
	/** Which boundary the call crossed. `"tool"` today; `"model"` when a model-egress gate annotates. */
	boundary: "tool" | "model";
	/** The BoundaryCall's own name: the tool's canonical path, or the literal `"model"`. */
	name: string;
	/** Why it did not go through — a hard refusal (`denied`) or a parked call awaiting a human. */
	status: "denied" | "needs-approval";
	/** The gate that decided, and the reason it gave (already carrying the determining-policy trail). */
	gateId: string;
	reason: string;
	reasonCode?: string;
	/** Who the call ran as — the runtime-stamped principal, absent only when nothing stamped one. */
	principal?: Principal;
	/** How the run started. `autonomous` is the case that most needs routing: no human is watching it. */
	runMode?: RunMode;
	/** The conversation this ran in — present only for a RECORDED run (a claw-bound
	 *  `sendMessage`/engine run). An ad-hoc `generate` has neither, and says so rather than inventing
	 *  them. */
	clawId?: string;
	threadId?: string;
	/** The JOIN KEY back to a parked approval, and the one id EVERY run has — the runtime mints one
	 *  when a run has no engine run and no recording to be named by. The same value sits on the
	 *  ApprovalRecord's checkpoint as `metadata.runId` (and, for a recorded run, inside
	 *  `metadata.recording` too), so one `listApprovals` + one comparison answers "which approval is
	 *  this escalation about" on either path. Absent only when something outside the runtime ran the
	 *  gate. */
	runId?: string;
};

export type EscalationsOptions = {
	/**
	 * Where an escalation goes — page a team, open a ticket, write your own queue row. Awaited, like
	 * every observer in this runtime, so a short-lived host cannot return before the notice is sent;
	 * hand off fast (enqueue, don't deliver inline). Throwing is safe — the failure goes to the host's
	 * own `warn` door, never into the run — but a hang is still a hang.
	 */
	onEscalate: (escalation: Escalation) => void | Promise<void>;
	/** Plugin id override (default "busyclaw.escalations"), which the after-gate's id derives from.
	 *  Two installs need two ids — same-id gates replace, they do not stack. */
	id?: string;
};

/** The two outcomes that can carry annotations at all — the rest have nothing to route. */
type EscalatingOutcome = Extract<
	Outcome,
	{ status: "denied" | "needs-approval" }
>;

function escalating(
	outcome: Outcome,
): { target: string; outcome: EscalatingOutcome } | undefined {
	if (outcome.status !== "denied" && outcome.status !== "needs-approval") {
		return undefined;
	}
	const target = outcome.annotations?.[ESCALATE_ANNOTATION];
	return target === undefined ? undefined : { target, outcome };
}

const stringFrom = (ctx: TurnContext, key: string): string | undefined =>
	typeof ctx[key] === "string" ? ctx[key] : undefined;

/** The runtime-stamped facts an escalation carries: who ran it, how, and where to find it again. */
function stampsOf(
	ctx: TurnContext,
): Pick<Escalation, "principal" | "runMode" | "clawId" | "threadId" | "runId"> {
	// asPrincipal validates the stamp — a malformed one is a host bug, and it surfaces through the
	// handler's warn rather than as a payload the router would route on.
	const principal = stringFrom(ctx, PRINCIPAL_CONTEXT_KEY);
	const runMode = ctx[RUN_MODE_CONTEXT_KEY];
	const clawId = stringFrom(ctx, CLAW_ID_CONTEXT_KEY);
	const threadId = stringFrom(ctx, THREAD_ID_CONTEXT_KEY);
	const runId = stringFrom(ctx, RUN_ID_CONTEXT_KEY);
	return {
		...(principal !== undefined ? { principal: asPrincipal(principal) } : {}),
		...(runMode === "interactive" || runMode === "autonomous"
			? { runMode }
			: {}),
		...(clawId !== undefined ? { clawId } : {}),
		...(threadId !== undefined ? { threadId } : {}),
		...(runId !== undefined ? { runId } : {}),
	};
}

/**
 * Route the `escalate` policy annotation to the host.
 *
 * ```ts
 * escalations({ onEscalate: (e) => pageTeam(e.target, e) })
 * ```
 *
 * Two things make it work, and both are already in the box: declaring `escalate` is what lets the
 * value leave the policy engine at all, and an after-gate is where a finished call can be read. A
 * DENY escalates as legitimately as a park — `@escalate` on a forbid means "you cannot, ask X".
 *
 * Installing this also makes `@guidance("…")` usable — the model-audience half, which goes to the
 * AGENT and never through `onEscalate`. See {@link GUIDANCE_ANNOTATION}.
 *
 * What it does NOT do: persist. There is no escalation table in this slice — the host's `onEscalate`
 * IS the durability boundary. A parked call is already durable as an ApprovalRecord and a deny is
 * already in the audit chain, so a third copy would be a queue with no reader.
 */
export function escalations(
	options: EscalationsOptions,
	// `"no-cron"` explicitly: the phantom's DEFAULT is the whole flag union, which reads as "might
	// contribute cron" and would make every host that installs this plugin pass a `cronHandler`.
): BusyclawPlugin<"no-cron"> {
	const id = options.id ?? "busyclaw.escalations";
	const gate: AfterGate = {
		id,
		// Every boundary: an escalation annotated onto a model-egress forbid is the same fact as one on
		// a tool forbid. Narrowing to the tool boundary here would drop it silently.
		matcher: () => true,
		// `warn` arrives from governance — the HOST's one operator-notice door (`createClaw({ warn })`),
		// not a second knob on this plugin. A router that swallows a failure the host never sees is a
		// silently dropped escalation.
		handler: async (call, ctx, result, warn) => {
			// Nothing to route: no annotation on the deciding policies (every `ok`, and the ordinary
			// deny), or a policy annotated a key no plugin declared — which never leaves the engine.
			const escalation = escalating(result);
			if (escalation === undefined) return;
			try {
				await options.onEscalate({
					target: escalation.target,
					boundary: call.boundary,
					name: call.name,
					status: escalation.outcome.status,
					gateId: escalation.outcome.gateId,
					reason: escalation.outcome.reason,
					...(escalation.outcome.reasonCode !== undefined
						? { reasonCode: escalation.outcome.reasonCode }
						: {}),
					...stampsOf(ctx),
				});
			} catch (err) {
				// The observer contract (the runtime's observer fan-out, packages/runtime/src/events.ts):
				// isolated, warned, never propagated. This handler runs inside governance's `finally`, so
				// a throw here would surface as the run's failure and mask the real outcome.
				warn(
					`busyclaw escalations: onEscalate failed for "${escalation.target}" — ${errorMessage(err)}`,
				);
			}
		},
	};
	return {
		id,
		// The ALLOWLIST. Without these lines the same `@escalate("…")` is inert: the engine never lets
		// an undeclared key out, because policy text is author-written and reaches a compliance log. No
		// `parse` on either — the target is opaque by design, guidance is prose, and a validator that
		// throws would throw INSIDE the engine, turning a routing concern into a decision-path failure.
		//
		// Two keys, two AUDIENCES: `escalate` defaults to the host (this plugin's after-gate reads it),
		// `guidance` is declared for the model and never reaches `onEscalate` at all — the engine
		// separates them, so neither door has to remember which is which.
		policyAnnotations: [
			{ key: ESCALATE_ANNOTATION },
			{ key: GUIDANCE_ANNOTATION, audience: "model" },
		],
		afterGates: [gate],
	};
}
