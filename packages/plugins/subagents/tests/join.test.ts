// A parent stops for its children, and something wakes it.
//
// The whole feature is one property: a run parked on a barrier comes back exactly once, whatever
// happened to the children. "Whatever happened" is the hard half — a child that COMPLETED announces
// itself and the sink hears it in milliseconds, and a child that CRASHED announces nothing at all.
// There is no runtime event for a failed run: the union has five run-level members, a throw returns
// through the worker's catch, and the two dead-letter paths emit nothing. So the reconciler is not a
// safety net under the sink; it is the mechanism, and the sink is a latency optimisation over it.
//
// The tests that matter here are therefore about the paths NOBODY announces, and about the two
// writers racing — because those are the two ways this ends up with a parent that waits forever or
// one that resumes twice from one transcript.

import { userPrincipal } from "@busyclaw/contracts";
import { entityAdapter, memoryAdapter } from "@busyclaw/storage-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	agentJoinId,
	agentWaitId,
	createSubagentStore,
	subagentModels,
} from "../src/index";
import { spawningClaw } from "./harness";

const alice = userPrincipal("alice");

function setup() {
	const adapter = memoryAdapter();
	const claw = spawningClaw({ adapter });
	// `entityView` refuses a raw adapter — the assembly wraps the one it hands the plugin, so a suite
	// reading the same rows has to wrap its own or it is talking to a different surface.
	const entities = entityAdapter(adapter, subagentModels);
	return { adapter: entities, claw, store: createSubagentStore(entities) };
}

/** Drive the engine until it has nothing left — how a child actually reaches `completed`. */
async function drain(claw: unknown): Promise<void> {
	const engine = (
		claw as { $context: { engine?: { work?: () => Promise<unknown> } } }
	).$context.engine;
	for (let i = 0; i < 12; i += 1) {
		const result = (await engine?.work?.()) as { status?: string } | undefined;
		if (result === undefined || result.status === "idle") return;
	}
}

describe("await, when the children are already done", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it("comes back with results and never parks", async () => {
		// The synchronous return. Without it a parent that asked one step too late parks for a wake that
		// is never going to be sent — the sink fires on the TRANSITION, and these already transitioned.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		for (const alias of ["a", "b"]) {
			await ctx.claw.spawnFrom({ principal: alice, alias, prompt: "go", parentRunId });
		}
		await drain(ctx.claw);

		const result = await ctx.claw
			.capability({ principal: alice, parentRunId })
			.awaitChildren({});

		expect(result.status).toBe("settled");
		expect(ctx.claw.parkRequests).toEqual([]);
		if (result.status !== "settled") throw new Error("unreachable");
		expect(result.results.map((r) => r.alias).sort()).toEqual(["a", "b"]);
		expect(result.results.every((r) => r.outcome === "completed")).toBe(true);
	});
});

describe("await, when they are not", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it("parks, naming the token that will wake it", async () => {
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		await ctx.claw.spawnFrom({ principal: alice, alias: "a", prompt: "go", parentRunId });

		const result = await ctx.claw
			.capability({ principal: alice, parentRunId, step: 3 })
			.awaitChildren({});

		expect(result.status).toBe("waiting");
		// DERIVED from (run, step), so a replayed step re-derives the wait it already armed instead of
		// minting a second one and leaving the first parked against a checkpoint nothing resumes.
		const expected = agentWaitId({ runId: parentRunId, step: 3 });
		expect(ctx.claw.parkRequests).toEqual([expected]);
		if (result.status !== "waiting") throw new Error("unreachable");
		expect(result.pending).toEqual(["a"]);
	});

	it("refuses when there is no loop to park", async () => {
		// An api call has no loop. A capability that armed a wait it could not park would leave a
		// durable row nobody answers, and the caller would carry on as if it had asked for nothing.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		await ctx.claw.spawnFrom({ principal: alice, alias: "a", prompt: "go", parentRunId });

		await expect(
			ctx.claw
				.capability({ principal: alice, parentRunId, canPark: false })
				.awaitChildren({}),
		).rejects.toThrow(/cannot wait/);
	});

	it("refuses to wait for a child it does not have", async () => {
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		await expect(
			ctx.claw
				.capability({ principal: alice, parentRunId })
				.awaitChildren({}),
		).rejects.toThrow(/nothing to wait for/);
	});

	it("re-derives its own barrier when the same step runs again", async () => {
		// The replay property. A resumed parent re-enters at the step its checkpoint named and calls
		// `await` again; a fresh join each time would leave the first waiting forever with its own row.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		await ctx.claw.spawnFrom({ principal: alice, alias: "a", prompt: "go", parentRunId });
		const capability = ctx.claw.capability({ principal: alice, parentRunId, step: 2 });

		await capability.awaitChildren({});
		await capability.awaitChildren({});

		const open = await ctx.store.openJoins(10);
		expect(open).toHaveLength(1);
	});
});

describe("the reconciler is the only thing that sees a failure", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it("records an arrival for a child whose run is gone, rather than waiting out the deadline", async () => {
		// A spawn that crashed between writing the edge and starting the run leaves an edge with no run.
		// Nothing is ever going to complete it. Left unrecorded, the parent burns its entire deadline
		// waiting for a child that does not exist — and the sink cannot help, because a run that never
		// started emits nothing to hear.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		const joinId = agentJoinId(
			parentRunId,
			agentWaitId({ runId: parentRunId, step: 0 }),
		);
		const now = new Date().toISOString();
		await ctx.store.createEdge({
			id: "child-that-never-ran",
			parentRunId,
			rootRunId: parentRunId,
			depth: 1,
			alias: "ghost",
			principal: alice,
			containerKind: "claw",
			containerId: "claw-1",
			createdAt: now,
			updatedAt: now,
		});
		await ctx.store.openJoin({
			id: joinId,
			ownerRunId: parentRunId,
			waitId: agentWaitId({ runId: parentRunId, step: 0 }),
			expected: 1,
			threshold: 1,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			now,
		});

		const report = (await ctx.claw.runCron()).data as { recorded: number };

		expect(report.recorded).toBe(1);
		const arrivals = await ctx.store.arrivals(joinId);
		expect(arrivals.map((a) => a.outcome)).toEqual(["failed"]);
		// And the barrier is met, so the parent is released rather than parked on a ghost.
		expect((await ctx.store.join(joinId))?.status).toBe("fired");
	});

	it("times a barrier out at its deadline and releases the parent with what landed", async () => {
		// THE ONLY DEADLINE ENFORCEMENT THERE IS. The plan had the parent arm its own timeout as a due
		// resume task; it cannot, because `resumeRun` derives its task id from the checkpoint and
		// swallows the conflict — an arm enqueued first makes the real wake a silent no-op. The
		// idempotence that stops a double resume is the same thing that stops an early one.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		const waitId = agentWaitId({ runId: parentRunId, step: 0 });
		const joinId = agentJoinId(parentRunId, waitId);
		const now = new Date().toISOString();
		await ctx.claw.spawnFrom({ principal: alice, alias: "a", prompt: "go", parentRunId });
		await ctx.store.openJoin({
			id: joinId,
			ownerRunId: parentRunId,
			waitId,
			expected: 1,
			threshold: 1,
			// Already past.
			deadlineAt: new Date(Date.now() - 60_000).toISOString(),
			now,
		});

		const report = (await ctx.claw.runCron()).data as { timedOut: number };

		expect(report.timedOut).toBe(1);
		expect((await ctx.store.join(joinId))?.status).toBe("timed_out");
	});

	it("leaves a barrier alone while its children are still running", async () => {
		// The other half of the deadline rule: before it, an unmet barrier must survive the pass
		// untouched. A reconciler that settled early would hand the parent an answer that does not exist.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		const waitId = agentWaitId({ runId: parentRunId, step: 0 });
		const joinId = agentJoinId(parentRunId, waitId);
		const now = new Date().toISOString();
		await ctx.claw.spawnFrom({ principal: alice, alias: "a", prompt: "go", parentRunId });
		await ctx.claw.spawnFrom({ principal: alice, alias: "b", prompt: "go", parentRunId });
		await ctx.store.openJoin({
			id: joinId,
			ownerRunId: parentRunId,
			waitId,
			expected: 2,
			threshold: 2,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			now,
		});

		await ctx.claw.runCron();

		expect((await ctx.store.join(joinId))?.status).toBe("waiting");
	});

	it("reports what it did NOT get to, rather than looking complete", async () => {
		// A silent cap reads as "everything is reconciled" when it is not, and the thing it is hiding is
		// parents that did not get woken this pass.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		const now = new Date().toISOString();
		for (let i = 0; i < 3; i += 1) {
			const waitId = agentWaitId({ runId: parentRunId, step: i });
			await ctx.store.openJoin({
				id: agentJoinId(parentRunId, waitId),
				ownerRunId: parentRunId,
				waitId,
				expected: 1,
				threshold: 1,
				deadlineAt: new Date(Date.now() + 60_000).toISOString(),
				now,
			});
		}

		const result = await ctx.claw.runCron(1);

		expect(result.status).toBe("limit");
		expect((result.data as { deferred: number }).deferred).toBe(2);
	});
});

describe("the barrier elects exactly one waker", () => {
	let ctx: ReturnType<typeof setup>;
	beforeEach(() => {
		ctx = setup();
	});

	it("settles once when two arrivals meet the threshold together", async () => {
		// `settleJoin` is a CAS on `status: waiting` — one caller gets the row, everyone else gets null.
		// Without it two children landing together both call `resumeRun` and the parent resumes twice
		// from one transcript. (On memoryAdapter this pins the CAS SHAPE, not the isolation:
		// `enforcesUnique: false` and its `transaction` does not isolate, so the real race belongs on
		// SQLite — see the note in the suite header.)
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		const waitId = agentWaitId({ runId: parentRunId, step: 0 });
		const joinId = agentJoinId(parentRunId, waitId);
		const now = new Date().toISOString();
		await ctx.store.openJoin({
			id: joinId,
			ownerRunId: parentRunId,
			waitId,
			expected: 2,
			threshold: 2,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			now,
		});

		const won = await Promise.all([
			ctx.store.settleJoin({ joinId, to: "fired", now }),
			ctx.store.settleJoin({ joinId, to: "fired", now }),
		]);

		expect(won.filter((row) => row !== null)).toHaveLength(1);
	});

	it("records one arrival however many times a child is reported", async () => {
		// The fast path and the reconciler both see an ordinary completion. The primary key is what makes
		// that free rather than a double count that fires a threshold early.
		const parentRunId = await ctx.claw.openRun(alice, "claw-1");
		const waitId = agentWaitId({ runId: parentRunId, step: 0 });
		const joinId = agentJoinId(parentRunId, waitId);
		const now = new Date().toISOString();
		await ctx.store.openJoin({
			id: joinId,
			ownerRunId: parentRunId,
			waitId,
			expected: 2,
			threshold: 2,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			now,
		});

		const first = await ctx.store.recordArrival({
			joinId,
			childRunId: "child-1",
			outcome: "completed",
			now,
		});
		const second = await ctx.store.recordArrival({
			joinId,
			childRunId: "child-1",
			outcome: "completed",
			now,
		});

		expect([first, second]).toEqual([true, false]);
		expect(await ctx.store.countArrivals(joinId)).toBe(1);
	});
});

describe("await, called again on a barrier that already fired", () => {
	it("returns the results instead of parking on a wake nobody will send", async () => {
		// THE WAITER-NOBODY-WAKES CASE, reached by the most ordinary path there is: a parent resumes,
		// re-enters the step its checkpoint named, and calls `await` again. The join is derived from
		// (run, step), so it finds the one that already FIRED — and a park against a fired barrier is a
		// run that never ends, because the thing that would have woken it already did.
		const adapter = memoryAdapter();
		const claw = spawningClaw({ adapter });
		const store = createSubagentStore(entityAdapter(adapter, subagentModels));
		const parentRunId = await claw.openRun(alice, "claw-1");
		await claw.spawnFrom({
			principal: alice,
			alias: "a",
			prompt: "go",
			parentRunId,
		});

		// First call: the child is still running, so it parks.
		const first = await claw
			.capability({ principal: alice, parentRunId, step: 4 })
			.awaitChildren({});
		expect(first.status).toBe("waiting");

		// The child finishes and the barrier fires, exactly as it would in production.
		await drain(claw);
		const joinId = agentJoinId(
			parentRunId,
			agentWaitId({ runId: parentRunId, step: 4 }),
		);
		await claw.runCron();
		expect((await store.join(joinId))?.status).toBe("fired");

		// The resumed parent asks again, AT THE SAME STEP.
		const second = await claw
			.capability({ principal: alice, parentRunId, step: 4 })
			.awaitChildren({});

		expect(second.status).toBe("settled");
		if (second.status !== "settled") throw new Error("unreachable");
		expect(second.results.map((r) => r.alias)).toEqual(["a"]);
	});
});
