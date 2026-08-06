// Driving more than one due task at a time.
//
// Against SQLite, not `memoryAdapter`: every claim is a compare-and-set, and that adapter declares
// `enforcesUnique: false` and runs single-threaded with a pre-check — so the LOSING branch of every
// race is unreachable there and a green test proves nothing about the thing under test.
//
// The shape that matters is the one this replaces. Calling `claimDueTask` K times in parallel looks
// like the obvious way to get concurrency and is not: each call begins with `reapExpiredLeases()`, an
// unbounded scan over every expired lease plus a transaction per lease, so K calls do K full sweeps
// per tick; and all K read the same `dueAt`-ordered window, so they collide on the same head row and
// K−1 lose the CAS. The work gets serialized by contention exactly where it was meant to spread out.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { runMessageEntity, userPrincipal } from "@busyclaw/contracts";
import type { Runtime, RuntimeModel } from "@busyclaw/runtime";
import { createRuntime } from "@busyclaw/runtime";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSqlEngineStore,
	createSqlEngineWorker,
	type SqlEngineStore,
	sqlEngineSchema,
} from "../src/index";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

/** A model that takes `ms` to answer — the only way to tell "together" from "one after another". */
function slowModel(ms: number, onCall?: (n: number) => void): RuntimeModel {
	let calls = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
			onCall?.(++calls);
			await new Promise((resolve) => setTimeout(resolve, ms));
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

async function harness(model: RuntimeModel) {
	const sqlite = new Database(":memory:");
	closers.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const plan = await planMigrations({
		db: kdb,
		// `run_message` is core's, not the engine's — `sqlEngineSchema` deliberately does not claim
		// it — but the drain reads the run inbox at its first control point, so a bare engine schema
		// gives every task "no such table". The assembly merges the two; a hand-wired harness has to.
		schema: {
			...sqlEngineSchema,
			...runMessageEntity.storage,
		} as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	const store = createSqlEngineStore(adapter);
	const runtime: Runtime = createRuntime({ model, tools: {} });
	return { adapter, store, runtime };
}

/** Enqueue `count` independent runs, the way `startRun` would. */
async function seed(store: SqlEngineStore, count: number): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const run = await store.createRun({
			principal: userPrincipal("alice"),
			input: { ctx: {} },
		});
		await store.enqueueTask({
			runId: run.id,
			kind: "runtime.run",
			payload: { prompt: `job ${i}` },
		});
		ids.push(run.id);
	}
	return ids;
}

const worker = (input: Awaited<ReturnType<typeof harness>>, workerId = "w1") =>
	createSqlEngineWorker({
		store: input.store,
		runtime: input.runtime,
		workerId,
	});

describe("one round claims and drives several tasks", () => {
	it("finishes five in materially less than five turns' worth of time", async () => {
		const TURN_MS = 60;
		const built = await harness(slowModel(TURN_MS));
		await seed(built.store, 5);

		const started = Date.now();
		const results = await worker(built).tickMany({ max: 5 });
		const elapsed = Date.now() - started;

		expect(results).toHaveLength(5);
		expect(results.every((r) => r.status === "completed")).toBe(true);
		// Serial would be 5 × TURN_MS. Generous — this asserts "overlapped", not a timing budget, so
		// it does not become a flake on a loaded machine.
		expect(elapsed).toBeLessThan(TURN_MS * 3);
	});

	it("claims at most `max`, and leaves the rest for the next round", async () => {
		const built = await harness(slowModel(0));
		await seed(built.store, 5);

		const first = await worker(built).tickMany({ max: 2 });
		expect(first).toHaveLength(2);
		const second = await worker(built).tickMany({ max: 2 });
		expect(second).toHaveLength(2);
		const third = await worker(built).tickMany({ max: 2 });
		expect(third).toHaveLength(1);
		// Drained: the next round is what says so.
		expect(await worker(built).tickMany({ max: 2 })).toEqual([]);
	});

	it("reaps ONCE for the batch, not once per task", async () => {
		// The quadratic the batch exists to remove. Counted at the ADAPTER, because the sweep is a
		// scan over every expired lease and that is where it costs — and because `claimDueTasks` calls
		// the reaper through the store's own closure, so wrapping the returned object intercepts
		// nothing. Four single claims would run four of these; one batch runs one.
		const sqlite = new Database(":memory:");
		closers.push(() => sqlite.close());
		const kdb = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		const inner: Adapter = kyselyAdapter(kdb);
		let leaseScans = 0;
		const counting: Adapter = {
			...inner,
			findMany: async (input) => {
				if (input.model === "lease") leaseScans += 1;
				return inner.findMany(input);
			},
		};
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
		const store = createSqlEngineStore(counting);
		await seed(store, 4);

		await createSqlEngineWorker({
			store,
			runtime: createRuntime({ model: slowModel(0), tools: {} }),
			workerId: "w1",
		}).tickMany({ max: 4 });

		expect(leaseScans).toBe(1);
	});
});

describe("a task somebody else holds is not a candidate", () => {
	it("fills a batch past the held head of the queue", async () => {
		// Where the exclusion actually lives: `pendingWhere` filters `status = "pending"`, so a leased
		// task is never a candidate and cannot starve a batch behind it. Worth a test because it is
		// easy to assume the candidate WINDOW is what protects this — it is not, and a wider window
		// only covers the narrow read-then-CAS race.
		const built = await harness(slowModel(0));
		await seed(built.store, 10);

		// Another worker takes the five oldest and keeps them — claimed, not driven.
		const held = await built.store.claimDueTasks({ workerId: "w2", max: 5 });
		expect(held).toHaveLength(5);

		const mine = await worker(built).tickMany({ max: 5 });
		expect(mine).toHaveLength(5);
	});
});

describe("one bad task does not take out the batch", () => {
	it("returns the siblings' results when one slice throws", async () => {
		// `Promise.all` over the drives would reject on the first throw and lose every other result —
		// including slices that finished fine, whose leases are then held until they lapse.
		let call = 0;
		const built = await harness(
			slowModel(0, (n) => {
				call = n;
			}),
		);
		const poisoned: Runtime = {
			...built.runtime,
			generate: async (...args: Parameters<Runtime["generate"]>) => {
				call += 1;
				if (call === 2) throw new Error("this one is broken");
				return built.runtime.generate(...args);
			},
		};
		await seed(built.store, 3);

		const results = await createSqlEngineWorker({
			store: built.store,
			runtime: poisoned,
			workerId: "w1",
		}).tickMany({ max: 3 });

		expect(results).toHaveLength(3);
		expect(results.filter((r) => r.status === "completed")).toHaveLength(2);
		expect(results.filter((r) => r.status === "failed")).toHaveLength(1);
	});
});

describe("two workers on one queue", () => {
	it("executes each task EXACTLY once", async () => {
		// The property the whole lease protocol exists for, at the one moment it can actually be
		// tested: two claimants reading the same `dueAt` window at the same time, against a database
		// that arbitrates rather than a map that pre-checks.
		const seen: string[] = [];
		const built = await harness(
			slowModel(10, () => {
				seen.push("call");
			}),
		);
		await seed(built.store, 6);

		const [a, b] = await Promise.all([
			worker(built, "w1").tickMany({ max: 6 }),
			worker(built, "w2").tickMany({ max: 6 }),
		]);

		const drove = [...a, ...b].filter((r) => r.status === "completed");
		// Six tasks, six model calls, however the two workers split them.
		expect(drove).toHaveLength(6);
		expect(seen).toHaveLength(6);
		const runIds = drove.map((r) => ("task" in r ? r.task?.runId : undefined));
		expect(new Set(runIds).size).toBe(6);
	});
});
