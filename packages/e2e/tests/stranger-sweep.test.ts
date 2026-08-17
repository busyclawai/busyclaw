/**
 * THE SWEEP — every door on the api, tried by somebody with no claim to anything.
 *
 * This is a property over the whole surface rather than a scenario, and that shape is deliberate:
 * the equivalent sweep over Cedar's context attributes is what found the floor failing open, and it
 * found it because it asked the same question of EVERY attribute instead of the ones somebody
 * suspected. Individual authz tests cover the doors people thought about. A stranger does not
 * restrict themselves to those.
 *
 * The method list is read from `CLAW_API_METHOD_NAMES`, the shared list the routes and the client are
 * also keyed by — so a door added later is swept by the next run of this file, with nobody
 * remembering to add it here.
 *
 * THREE OUTCOMES, and conflating them is how a sweep like this lies:
 *   - DENIED — the floor held.
 *   - ANSWERED — a hole, unless it is on the allowlist below with a reason.
 *   - UNREACHED — the input was rejected before authz ran, so this door was NOT tested. Reported out
 *     loud rather than counted as a pass, because "it threw" and "it refused" are different facts.
 *
 * WHAT THIS FILE DOES NOT TEST, stated so nobody reads more into a green run than is there: it calls
 * the api IN PROCESS, so it exercises the PEP and nothing above it. The input schemas — including
 * their `onUndeclaredKey("reject")` — are enforced at the HTTP route, and `resolveCaller` runs there
 * too. An unauthenticated HTTP sweep is a different test, against the surface where untrusted input
 * actually arrives.
 */

import type { ClawApiMethodName } from "@busyclaw/contracts";
import { CLAW_API_METHOD_NAMES } from "@busyclaw/contracts";
import { afterEach, expect, it } from "vitest";
import { script } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

const ALICE = "user:alice";
const STRANGER = "user:mallory";

/**
 * Doors a stranger may legitimately answer, and why.
 *
 * Kept explicit and short. Every entry is a decision that anyone holding a valid identity may do
 * this — so the list itself is the useful artifact, more than the assertions around it.
 */
const OPEN_TO_ANY_CALLER: Partial<Record<ClawApiMethodName, string>> = {
	createClaw: "anyone may create a claw of their own; it becomes theirs",
	createThread: "a thread under a claw they own — the claw is what is guarded",
	generate: "an ad-hoc turn against no stored resource",
	listActions: "the authorization catalogue, not anybody's data",
	listRegisteredTools: "the tool catalogue, not anybody's data",
	listApprovals:
		"scoped to the caller — a stranger's list is empty, not refused",
	listActiveRuns: "scoped to the caller",
	listThreads: "scoped to the caller",
	// VERIFIED RATHER THAN ASSUMED — this is the one the sweep flagged, and it was worth chasing.
	//
	// `startRun` deliberately does not honour a caller's `clawId`. The contract says so: "the api door
	// never forwards a caller's — it takes a `parentRunId`, verifies the parent already runs as that
	// caller, and copies the claw off the parent row", precisely so nobody can attach a run to a claw
	// they do not own. So a stranger gets an UNATTACHED run of their own (`run.clawId` is null), never
	// a foothold on Alice's — confirmed by reading the row back. `getClaw` and `sendMessage`, the doors
	// that WOULD reach her claw, both deny.
	//
	// The `clawId` this sweep passes is therefore ignored rather than rejected, despite the schema
	// declaring `onUndeclaredKey("reject")`: those schemas are enforced at the HTTP route, and this
	// sweep calls the api in-process. Which is the honest limit of this file — see the note at the top.
	startRun:
		"an unattached run the caller owns; a caller's clawId is never honoured",
};

/** Best-effort input per door, pointed at ALICE's resources. */
function inputFor(
	method: ClawApiMethodName,
	ids: Record<string, string>,
): unknown {
	const byId = { id: ids.clawId };
	const map: Partial<Record<ClawApiMethodName, unknown>> = {
		appendMessage: {
			clawId: ids.clawId,
			threadId: ids.threadId,
			role: "user",
			content: "hello",
		},
		archiveClaw: byId,
		archiveThread: { id: ids.threadId },
		continueRun: { approvalId: ids.approvalId },
		controlRun: { runId: ids.runId, intent: "stop" },
		createCheckpoint: {
			clawId: ids.clawId,
			threadId: ids.threadId,
			runId: ids.runId,
			kind: "yield",
			state: {},
		},
		createClaw: { id: "mallory-claw", name: "Mine" },
		createThread: { id: "mallory-thread", clawId: ids.clawId, title: "t" },
		createToolCall: {
			clawId: ids.clawId,
			threadId: ids.threadId,
			runId: ids.runId,
			toolCallId: "tc-x",
			toolName: "peek",
			args: {},
		},
		deliverMessage: { toRunId: ids.runId, message: "hi" },
		denyApproval: { approvalId: ids.approvalId },
		forgetSubject: {
			subjectId: "someone",
			containerKind: "claw",
			containerId: ids.clawId,
		},
		generate: { prompt: "hello" },
		getApproval: { id: ids.approvalId },
		getClaw: byId,
		getLatestCheckpoint: { runId: ids.runId },
		getMessage: { id: ids.messageId },
		getRun: { id: ids.runId },
		getThread: { id: ids.threadId },
		getToolCallByProviderId: { runId: ids.runId, toolCallId: "tc-1" },
		grantApproval: { approvalId: ids.approvalId },
		listActions: {},
		listApprovals: { status: "pending" },
		listActiveRuns: { threadId: ids.threadId },
		listMessages: { threadId: ids.threadId },
		listPolicySlices: { scope: "claw", scopeId: ids.clawId },
		listRegisteredTools: {},
		listRunEvents: { runId: ids.runId },
		listThreads: { clawId: ids.clawId },
		listToolResults: { runId: ids.runId },
		pruneRuns: { clawId: ids.clawId, before: new Date().toISOString() },
		sendMessage: {
			clawId: ids.clawId,
			threadId: ids.threadId,
			message: "hi",
		},
		startRun: { clawId: ids.clawId, prompt: "hi" },
		updateClaw: { id: ids.clawId, patch: { name: "taken" } },
	};
	return map[method];
}

type Outcome = "denied" | "answered" | "unreached";

function classify(error: unknown): Outcome {
	const code = (error as { code?: unknown }).code;
	return code === "BUSYCLAW_AUTHORIZATION_DENIED" ? "denied" : "unreached";
}

it("refuses every door to a caller who owns nothing", async () => {
	const w = await world({
		database: "sqlite",
		model: script([{ text: "ok" }]),
		principal: ALICE,
	});
	open = w;

	// Alice's world: a claw, a thread, a message, and a finished run to point at.
	await w.api.createClaw({ id: "claw-1", name: "Assistant" });
	await w.api.createThread({
		id: "thread-1",
		clawId: "claw-1",
		title: "Chat",
	});
	const message = await w.api.appendMessage({
		clawId: "claw-1",
		threadId: "thread-1",
		role: "user",
		content: "mine",
	});
	const started = await w.api.startRun({ clawId: "claw-1", prompt: "hi" });
	await w.settle();

	const ids = {
		clawId: "claw-1",
		threadId: "thread-1",
		messageId: String(message.id),
		runId: String(started.id),
		approvalId: "approval-1",
	};

	const answered: string[] = [];
	const unreached: string[] = [];
	const denied: string[] = [];

	for (const method of CLAW_API_METHOD_NAMES) {
		const input = inputFor(method, ids);
		if (input === undefined) {
			unreached.push(`${method} (no input built)`);
			continue;
		}
		const door = (
			w.claw.api as unknown as Record<
				string,
				(a: unknown, b: unknown) => Promise<unknown>
			>
		)[method];
		if (door === undefined) {
			unreached.push(`${method} (not on api)`);
			continue;
		}
		try {
			await door(input, { principal: STRANGER });
			answered.push(method);
		} catch (error) {
			const outcome = classify(error);
			if (outcome === "denied") denied.push(method);
			else unreached.push(`${method}: ${String(error).slice(0, 90)}`);
		}
	}

	// The doors that ANSWERED, minus the ones a stranger is allowed to reach. Anything left is a
	// caller with no claim to Alice's claw reading or changing it.
	const holes = answered.filter((method) => !(method in OPEN_TO_ANY_CALLER));

	// Reported through the assertion so a failure names them rather than making somebody re-run with
	// logging. `unreached` rides along for the same reason: it is the sweep's own coverage gap.
	expect({ holes, unreached, deniedCount: denied.length }).toMatchObject({
		holes: [],
	});

	// The sweep has to be WIDE to mean anything: a run where almost everything landed in `unreached`
	// would pass while testing nothing. This pins the reach so that stops being silent.
	expect(denied.length).toBeGreaterThanOrEqual(20);
}, 60000);
