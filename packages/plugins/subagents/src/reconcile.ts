// The two things that notice a child finished, and why there have to be two.
//
// The SINK is fast and incomplete. It sees `run.completed` and `run.denied` — the ordinary endings —
// within milliseconds, and it is best-effort by contract: sinks are observers, their failures are
// warned and dropped, and nothing retries them.
//
// The RECONCILER is slow and total. It is the only thing that ever learns a child FAILED: the
// `RuntimeEvent` union has five run-level members and a run that throws produces none of them — it
// returns through the worker's catch and writes an engine `run_event` row, which no sink observes.
// The two dead-letter paths (a task abandoned before its first claim, a lease that lapsed) emit
// nothing at all. So a crashed child unblocks its parent at cron latency, and there is no arrangement
// of sinks that changes that.
//
// Which makes the reconciler the mechanism and the sink an optimisation over it — not a backstop
// bolted on afterwards. Everything the sink does, the reconciler would do anyway.

import {
	arrivalOutcome,
	type JoinCheckpoints,
	type JoinEngine,
	settleIfMet,
	wakeArmedWait,
} from "./join";
import type { SubagentStore } from "./store";

/** Recognised as "this run ended" — the two the runtime actually announces. */
const TERMINAL_EVENTS = new Set(["run.completed", "run.denied"]);

/**
 * The fast path: a child ended, record it and see whether that completes its parent's barrier.
 *
 * Returns whether anything was recorded, which is for tests — a sink's return value goes nowhere.
 */
export async function onRunEvent(input: {
	store: SubagentStore;
	engine: JoinEngine;
	checkpoints?: JoinCheckpoints;
	event: { type: string; runId?: string; waitId?: string; checkpointId?: string };
	now: string;
}): Promise<boolean> {
	const { event, store } = input;

	// THE ARM. `run.awaiting` is the only place the checkpoint id and the wait token appear together —
	// the tool that opened the wait could not know the checkpoint, because the loop writes it after the
	// tool returns, and the loop knows nothing about waits.
	//
	// Best-effort, like every sink: if this never fires, `settleIfMet` falls back to the run's latest
	// checkpoint, which for a run that just parked is the same row. The arm makes it exact rather than
	// inferred, and gives the wait an `armed` status a reader can tell from a half-written one.
	if (event.type === "run.awaiting") {
		const waitId = event.waitId;
		const checkpointId = event.checkpointId;
		if (waitId === undefined || checkpointId === undefined) return false;
		const armed = await store.armWait({ waitId, checkpointId, now: input.now });
		// Not ours, or already spent. Another subsystem may own this wait — `waitId` is opaque to the
		// runtime and subagents is not the only thing that could ever park a run.
		if (armed === null) return false;
		// THE OTHER HALF OF THE ARM/LAND RACE. Every child may have finished while the parent was still
		// writing its checkpoint: the join fired and found no wait to wake, so the wake is this arm's.
		if (armed.joinId !== undefined) {
			const join = await store.join(armed.joinId);
			if (join !== null && join.status !== "waiting") {
				await wakeArmedWait({
					store,
					engine: input.engine,
					waitId,
					runId: armed.runId,
					checkpointId,
					now: input.now,
				});
			}
		}
		return true;
	}

	if (!TERMINAL_EVENTS.has(event.type)) return false;
	const runId = event.runId;
	if (runId === undefined) return false;
	// IS THIS RUN SOMEBODY'S CHILD — one primary-key read, and the whole cost of this sink on a claw
	// where nothing spawns anything. A run with no edge stops here.
	const edge = await store.edge(runId);
	if (edge === null) return false;

	// WHICH BARRIER, if any — asked by PARENT, on the indexed column. A child may finish with its
	// parent not yet waiting on it, which is the ordinary case for the first of three: nothing to
	// record, and the parent's own `await` reads this run's status directly when it gets there.
	const joins = await store.openJoinsForOwner(edge.parentRunId);
	let recorded = false;
	for (const join of joins) {
		const outcome =
			event.type === "run.denied"
				? ("failed" as const)
				: ("completed" as const);
		const fresh = await store.recordArrival({
			joinId: join.id,
			childRunId: runId,
			outcome,
			now: input.now,
		});
		recorded = recorded || fresh;
		await settleIfMet({
			store,
			engine: input.engine,
			...(input.checkpoints !== undefined
				? { checkpoints: input.checkpoints }
				: {}),
			joinId: join.id,
			now: input.now,
		});
	}
	return recorded;
}

export type ReconcileReport = {
	examined: number;
	recorded: number;
	fired: number;
	timedOut: number;
	/** Barriers left unexamined because the batch filled. Reported rather than swallowed: a silent cap
	 *  reads as "everything is reconciled" when it is not. */
	deferred: number;
};

/**
 * The authoritative pass: ask every open barrier what actually happened to its children.
 *
 * ASKS THE RUN, rather than waiting to be told. That is the difference that matters — a child that
 * crashed, dead-lettered, or lost its lease announced nothing, and its parent is parked with no
 * scheduler attention on it at all. Nothing but this will ever look.
 */
export async function reconcileJoins(input: {
	store: SubagentStore;
	engine: JoinEngine;
	checkpoints?: JoinCheckpoints;
	limit: number;
	now: string;
}): Promise<ReconcileReport> {
	const { store, limit } = input;
	const batch = await store.openJoins(limit);
	// COUNTED, not inferred from the page. Fetching one row over the limit answers "is there more",
	// and a `deferred` derived that way can only ever be 1 however deep the backlog is — a number
	// shaped like a measurement that is really a flag. This is the backlog an operator alerts on.
	const open = await store.countOpenJoins();
	const report: ReconcileReport = {
		examined: batch.length,
		recorded: 0,
		fired: 0,
		timedOut: 0,
		deferred: Math.max(0, open - batch.length),
	};

	for (const join of batch) {
		const children = await store.children(join.ownerRunId);
		const seen = new Set(
			(await store.arrivals(join.id)).map((arrival) => arrival.childRunId),
		);
		for (const edge of children) {
			if (seen.has(edge.id)) continue;
			const run = await input.engine.runs?.get(edge.id);
			// NO RUN BEHIND THE EDGE. Pruned, or a spawn that crashed between writing the edge and
			// starting the run. Either way nothing is ever going to finish it, and leaving it unrecorded
			// is how a parent waits out its whole deadline for a child that does not exist.
			const outcome =
				run === null || run === undefined
					? ("failed" as const)
					: arrivalOutcome(run.status);
			if (outcome === null) continue;
			if (
				await store.recordArrival({
					joinId: join.id,
					childRunId: edge.id,
					outcome,
					now: input.now,
				})
			) {
				report.recorded += 1;
			}
		}

		const met = await settleIfMet({
			store,
			engine: input.engine,
			...(input.checkpoints !== undefined
				? { checkpoints: input.checkpoints }
				: {}),
			joinId: join.id,
			now: input.now,
		});
		if (met.settled) {
			report.fired += 1;
			continue;
		}

		// THE DEADLINE, and this is the only thing enforcing it. The plan had the parent arm its own
		// timeout as a due resume task; it cannot, because `resumeRun` derives its task id from the
		// checkpoint and swallows the conflict — so an arm enqueued first would make the real wake a
		// no-op and the parent would sleep until its deadline whatever the children did. The idempotence
		// that stops a double resume is the same thing that stops an early one.
		if (input.now >= join.deadlineAt) {
			const timedOut = await settleIfMet({
				store,
				engine: input.engine,
				...(input.checkpoints !== undefined
					? { checkpoints: input.checkpoints }
					: {}),
				joinId: join.id,
				as: "timed_out",
				now: input.now,
			});
			if (timedOut.settled) report.timedOut += 1;
		}
	}
	return report;
}
