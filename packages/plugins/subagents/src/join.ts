// The barrier: one child landed, is that enough, and if so who wakes the parent.
//
// TWO CALLERS, ONE FUNCTION, and that is the whole reason this is not inlined into either of them.
// The event sink is the fast path and the cron reconciler is the authoritative one, and they overlap
// constantly — a child that completes normally is seen by both. Two copies of "count, decide, wake"
// would be two chances to disagree about what the threshold means, at the exact moment they raced.
//
// THE FAST PATH CANNOT CARRY FAILURES, so the reconciler is not a backstop bolted on afterwards — it
// is the mechanism, and the sink is an optimisation over it. `RuntimeEvent` has five run-level
// members and a run that THROWS produces none of them: it returns through the worker's catch and
// writes an engine `run_event` row, which no sink observes. So every child failure, not just the two
// dead-letter paths, waits for cron. Anyone expecting a crashed child to unblock its parent promptly
// should be told that in those words.

import type { AgentArrivalOutcome, SubagentStore } from "./store";

/** The engine surface a wake needs — structural, so this package imports no engine. */
export type JoinEngine = {
	runs?: {
		get: (id: string) => Promise<{ status: string } | null>;
	};
	resumeRun?: (input: {
		runId: string;
		checkpointId: string;
	}) => Promise<unknown>;
};

/** The checkpoint reader — the reconciler's answer to a sink that never fired. */
export type JoinCheckpoints = {
	latestForRun: (runId: string) => Promise<{ id: string } | null>;
};

/**
 * How an engine run status maps onto an arrival.
 *
 * `null` means NOT TERMINAL — the child is still going, and recording an arrival for it would fire a
 * barrier early and hand the parent an answer that does not exist yet.
 */
export function arrivalOutcome(status: string): AgentArrivalOutcome | null {
	switch (status) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		// `waiting` is the one that looks terminal and is not: a child parked on its OWN children is
		// mid-flight, and treating it as done would collapse a two-level tree into one.
		default:
			return null;
	}
}

export type SettleOutcome =
	| { settled: false; reason: "below-threshold" | "already-settled" }
	| { settled: true; woke: boolean };

/**
 * Count the arrivals, and if the barrier is met, elect one waker and resume the parent.
 *
 * The election is `settleJoin`'s CAS — exactly one caller gets the row back. Everyone else stops
 * here, which is what keeps two children landing in the same millisecond from resuming one
 * checkpoint twice.
 */
export async function settleIfMet(input: {
	store: SubagentStore;
	engine: JoinEngine;
	checkpoints?: JoinCheckpoints;
	joinId: string;
	/** `timed_out` when the deadline forced this rather than the children meeting it. */
	as?: "fired" | "timed_out";
	now: string;
}): Promise<SettleOutcome> {
	const { store, joinId } = input;
	const join = await store.join(joinId);
	if (join === null || join.status !== "waiting") {
		return { settled: false, reason: "already-settled" };
	}
	const as = input.as ?? "fired";
	if (as === "fired") {
		// COUNTED OVER MEMBERS, not over the table. The write paths already refuse to record a
		// non-member, but the count is what actually decides — and a barrier whose correctness depends
		// on every writer having remembered a rule is one bad caller away from waking a parent with an
		// answer about a run it never asked about. The intersection makes it true by construction.
		const members = new Set(join.members);
		const arrived = (await store.arrivals(joinId)).filter((arrival) =>
			members.has(arrival.childRunId),
		).length;
		if (arrived < join.threshold) {
			return { settled: false, reason: "below-threshold" };
		}
	}

	// THE ELECTION. One row back means this caller won; `null` means somebody else did and has the
	// wake. Nothing after this point runs twice for one barrier.
	const won = await store.settleJoin({ joinId, to: as, now: input.now });
	if (won === null) return { settled: false, reason: "already-settled" };

	const wait = await store.waitForJoin(joinId);
	// NO PARK TO WAKE, and this is a legal state rather than an error: every child finished before the
	// parent's `await` even reached its own park. The join is settled, the wait row does not exist
	// yet, and the arming `await` will read the fired join and return its results synchronously.
	if (wait === null) return { settled: true, woke: false };

	// A wait still `arming` has no checkpoint on it — the loop had not written one when the last child
	// landed. Fall back to the run's own latest, which is what the parent parked against; if there is
	// none yet, the arm will find the join already fired and settle itself.
	const checkpointId =
		wait.checkpointId ??
		(await input.checkpoints?.latestForRun(wait.runId))?.id;
	if (checkpointId === undefined) return { settled: true, woke: false };

	const woke = await wakeArmedWait({
		store,
		engine: input.engine,
		waitId: wait.id,
		runId: wait.runId,
		checkpointId,
		now: input.now,
	});
	return { settled: true, woke };
}

/**
 * Bring a parked run back because something arrived in its inbox.
 *
 * A run parked `awaiting` has no due row — nothing will ever look at it again — so a message to it
 * would sit undelivered until its barrier's deadline. This is also the deadlock escape: a child that
 * needs to ask its parent something, while the parent is parked on that very child, would otherwise
 * have both sides waiting on the other.
 *
 * The barrier is deliberately NOT settled. The parent comes back, reads its message, and if its
 * children are still going it asks again — opening a fresh barrier at its new step, and closing the
 * one it left behind (see `awaitChildren`'s one-open-join rule).
 */
export async function wakeForInbox(input: {
	store: SubagentStore;
	engine: JoinEngine;
	runId: string;
	now: string;
}): Promise<boolean> {
	const run = await input.engine.runs?.get(input.runId);
	// ONLY A PARKED RUN. A queued or running one will reach its own control point and drain the inbox
	// itself; resuming it would be a second slice over one transcript.
	if (run?.status !== "waiting") return false;
	const wait = await input.store.waitForRun(input.runId);
	if (wait?.checkpointId === undefined) return false;
	return wakeArmedWait({
		store: input.store,
		engine: input.engine,
		waitId: wait.id,
		runId: input.runId,
		checkpointId: wait.checkpointId,
		now: input.now,
	});
}

/**
 * Spend the park and resume the run. The one place a wake happens.
 *
 * Two callers: a barrier that just fired, and an arm that discovered its barrier had already fired
 * while the parent was still writing its checkpoint. Both have to do exactly this, in this order.
 */
export async function wakeArmedWait(input: {
	store: SubagentStore;
	engine: JoinEngine;
	waitId: string;
	runId: string;
	checkpointId: string;
	now: string;
}): Promise<boolean> {
	// SPEND THE PARK FIRST, and it is a CAS — so it is also the second election, the one that keeps a
	// fired barrier and a late arm from both resuming. `resumeRun` is idempotent on the checkpoint, but
	// a wait left `armed` would let every later reconciler pass retry the same wake against a run that
	// has moved on, and be refused, once per cron tick, forever.
	const fired = await input.store.fireWait({
		waitId: input.waitId,
		now: input.now,
	});
	if (fired === null) return false;

	try {
		await input.engine.resumeRun?.({
			runId: input.runId,
			checkpointId: input.checkpointId,
		});
	} catch (error) {
		// THE RUN WAS NOT WAITING. `resumeRun` refuses anything else, and the honest readings are all
		// benign: the parent was cancelled, or it never got as far as parking. Swallowed rather than
		// thrown because this is an observer path — a sink's failures are warned and dropped, and the
		// reconciler must go on to the next barrier rather than abandoning the batch over one dead
		// parent.
		if (!(error instanceof Error)) throw error;
		return false;
	}
	return true;
}
