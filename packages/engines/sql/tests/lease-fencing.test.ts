/**
 * THE LEASE IS A FENCE, AND A FENCE THAT LIES IS WORSE THAN NO FENCE.
 *
 * The worker's whole safety story rests on one signal: `heartbeatLease` returning null means "you no
 * longer hold this task", and the worker answers it by aborting the runtime and skipping terminal
 * persistence (`engine-sql.test.ts:513`). Everything downstream — not double-charging a model, not
 * writing two terminal results, not running one slice's tool effects twice — is that one boolean.
 *
 * These cases ask whether the boolean can be wrong, and they are deliberately about the state
 * BETWEEN two writes rather than about either write on its own. The existing suite is thorough on
 * each operation in isolation (43 cases, including the reaper's CAS and lapse-vs-failure), which is
 * exactly why what is left to find lives in the interleavings.
 *
 * Against SQLite for the reason `concurrency.test.ts` gives: `memoryAdapter` declares
 * `enforcesUnique: false` and runs single-threaded with a pre-check, so the losing branch of a race
 * is unreachable there and a green test would prove nothing.
 */

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { runMessageEntity, userPrincipal } from "@busyclaw/contracts";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSqlEngineStore,
	type SqlEngineStore,
	sqlEngineSchema,
} from "../src/index";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

async function harness(): Promise<{
	adapter: Adapter;
	store: SqlEngineStore;
}> {
	const sqlite = new Database(":memory:");
	closers.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const plan = await planMigrations({
		db: kdb,
		schema: {
			...sqlEngineSchema,
			...runMessageEntity.storage,
		} as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	return { adapter, store: createSqlEngineStore(adapter) };
}

/** Enqueue one run + task and claim it, the way a worker's tick would. */
async function claimed(store: SqlEngineStore) {
	const run = await store.createRun({
		principal: userPrincipal("alice"),
		input: { ctx: {} },
	});
	const task = await store.enqueueTask({
		runId: run.id,
		kind: "runtime.run",
		payload: { prompt: "job" },
	});
	const held = await store.claimDueTask({ workerId: "w1" });
	if (!held)
		throw new Error("precondition: the task should have been claimable");
	return { run, task, held };
}

/**
 * The reaper's OWN task write, replayed verbatim from `store.ts` `reapExpiredLeases` — status back
 * to `pending`, the lease forgotten.
 *
 * Reproduced rather than provoked by wall-clock, because the interleaving that reaches this state is
 * a sub-millisecond straddle of a lease expiry and would make the test a coin flip. The reachability
 * argument is in the case below; this helper is only the state it lands in.
 */
async function reaperRequeuesTask(
	adapter: Adapter,
	taskId: string,
): Promise<void> {
	await adapter.update({
		model: "runtime_task",
		where: [
			{ field: "id", value: taskId },
			{ field: "status", value: "leased", connector: "AND" },
		],
		update: {
			status: "pending",
			lastError: "lease expired",
			leaseId: null,
			workerId: null,
			leasedUntil: null,
		},
	});
}

describe("a heartbeat must not confirm a lease whose task was taken away", () => {
	it("returns null once the task no longer names this lease", async () => {
		// HOW THIS STATE IS REACHED — a live lease row beside a task that no longer points at it.
		//
		// `heartbeatLease` reads the lease, checks `expiresAt <= now()`, and only THEN captures
		// `ts = now()` for its compare-and-set (`store.ts:975-985`). A reaper whose sweep begins in
		// that gap selects the lease as expired; the heartbeat's CAS still passes, because it is
		// measured against the earlier `ts`; and the reaper's task CAS still passes too, because it
		// pins `status` and `leaseId` and never looks at expiry. Both writes commit. The heartbeat
		// renewed a lease the reaper has already decided to collect.
		//
		// What makes it a defect rather than a lost race is the last line of `heartbeatLease`: it
		// issues the `runtime_task` update, DOES NOT LOOK AT WHETHER IT MATCHED, and returns the
		// LEASE row as its success value (`store.ts:990-1000`). So the one signal the worker uses to
		// decide whether it is still allowed to act comes back green while the task has been handed
		// back to the queue.
		const { adapter, store } = await harness();
		const { task, held } = await claimed(store);

		await reaperRequeuesTask(adapter, task.id);

		const beat = await store.heartbeatLease({
			leaseId: held.leaseId,
			leaseToken: held.leaseToken,
		});
		expect(beat).toBeNull();
	});

	it("leaves at most one holder: a confirmed heartbeat and a fresh claim cannot both succeed", async () => {
		// The consequence, stated as the invariant rather than as the mechanism — this is the case
		// that stays meaningful if the fix changes shape.
		//
		// After the requeue the task is `pending`, so an ordinary tick on another host claims it. If
		// the first worker's heartbeat also reports success, two workers are driving one slice at the
		// same time: two model calls billed, two sets of tool effects, and whichever finishes second
		// finds its terminal write refused — after the side effects already happened.
		const { adapter, store } = await harness();
		const { task, held } = await claimed(store);

		await reaperRequeuesTask(adapter, task.id);

		const beat = await store.heartbeatLease({
			leaseId: held.leaseId,
			leaseToken: held.leaseToken,
		});
		const second = await store.claimDueTask({ workerId: "w2" });

		const holders = [beat !== null, second !== null].filter(Boolean).length;
		expect(holders).toBe(1);
	});

	it("does not renew the lease of a task that has already been retired", async () => {
		// The same missing check reached without any race at all, through the path the claim side
		// uses when a run is stopped: `attemptClaim` retires a task to `dead` and clears its
		// `leaseId`. A `dead` task is finished for good, so confirming a heartbeat against it tells a
		// worker to keep driving work that has been explicitly abandoned.
		const { adapter, store } = await harness();
		const { task, held } = await claimed(store);

		await adapter.update({
			model: "runtime_task",
			where: [{ field: "id", value: task.id }],
			update: {
				status: "dead",
				lastError: "abandoned",
				leaseId: null,
				workerId: null,
				leasedUntil: null,
			},
		});

		const beat = await store.heartbeatLease({
			leaseId: held.leaseId,
			leaseToken: held.leaseToken,
		});
		expect(beat).toBeNull();
	});
});
