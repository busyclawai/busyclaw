import { type Adapter, memoryAdapter } from "@busyclaw/storage-core";
import { kyselyAdapter } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createRunCheckpointStore } from "../src/run-checkpoint";

// The stored metadata is the REDACTED resume envelope — what a continuation replays.
const base = {
	runId: "run-1",
	metadata: {
		version: "runtime.ai-sdk.yield.v1",
		nextStep: 3,
		messages: [{ role: "user", content: "email {{pii:abc}}" }],
	},
	createdAt: "2026-01-01T00:00:00Z",
};

// Run the same suite over every adapter — the store is adapter-agnostic.
function suite(
	name: string,
	makeAdapter: () => Adapter,
	teardown?: () => void,
): void {
	describe(`createRunCheckpointStore over ${name}`, () => {
		afterEach(() => teardown?.());

		it("create → pending, and the envelope round-trips through storage", async () => {
			const store = createRunCheckpointStore(makeAdapter());
			const rec = await store.create(base);
			expect(rec.status).toBe("pending");
			expect(rec.id).toMatch(/^[0-9a-f]{32}$/);
			const read = await store.get(rec.id);
			expect(read?.runId).toBe("run-1");
			expect(read?.metadata).toEqual(base.metadata); // parsed back from JSON, not a string
		});

		it("claim → complete is single-use and stamps consumedAt", async () => {
			const store = createRunCheckpointStore(makeAdapter(), {
				now: () => "2026-01-01T00:05:00Z",
			});
			const rec = await store.create(base);
			const claim = await store.claim(rec.id);
			expect(claim?.record.metadata).toEqual(base.metadata); // the envelope to resume from
			expect((await store.get(rec.id))?.status).toBe("claimed");

			if (!claim) throw new Error("claim failed");
			const done = await store.complete(rec.id, claim.leaseId);
			expect(done?.status).toBe("consumed");
			const read = await store.get(rec.id);
			expect(read?.status).toBe("consumed"); // row retained for observability
			expect(read?.consumedAt).toBe("2026-01-01T00:05:00Z");
			expect(await store.claim(rec.id)).toBeNull(); // spent, and stays spent
		});

		it("claim of an unknown id returns null", async () => {
			const store = createRunCheckpointStore(makeAdapter());
			expect(await store.claim("missing")).toBeNull();
		});

		it("claim is race-safe — concurrent continuations, exactly one winner", async () => {
			const store = createRunCheckpointStore(makeAdapter());
			const rec = await store.create(base);
			const results = await Promise.all(
				Array.from({ length: 5 }, () => store.claim(rec.id)),
			);
			expect(results.filter((r) => r !== null)).toHaveLength(1);
		});

		it("a LIVE claim locks the row — a second attempt gets null", async () => {
			const store = createRunCheckpointStore(makeAdapter(), {
				now: () => "2026-01-01T00:00:00Z",
				claimLeaseMs: 60_000,
			});
			const rec = await store.create(base);
			expect(await store.claim(rec.id)).not.toBeNull();
			// Still inside the lease: exactly-once must hold even though the row is not `consumed`.
			expect(await store.claim(rec.id)).toBeNull();
		});

		// THE REGRESSION. Before claim/complete, `consume` flipped the row terminal BEFORE the resume
		// ran, so an attempt that died left the checkpoint permanently untakeable — every retry got
		// null, the task dead-lettered, and the engine marked a healthy run `failed` while its complete
		// transcript sat in this row. A lapsed claim must be recoverable or that kill comes back.
		it("a claim whose lease has LAPSED is re-claimable, with the envelope intact", async () => {
			let clock = "2026-01-01T00:00:00Z";
			const store = createRunCheckpointStore(makeAdapter(), {
				now: () => clock,
				claimLeaseMs: 60_000,
			});
			const rec = await store.create(base);
			const first = await store.claim(rec.id);
			expect(first).not.toBeNull();

			// …the process holding it dies here, having written nothing.
			clock = "2026-01-01T00:02:00Z"; // past the 60s lease

			const second = await store.claim(rec.id);
			expect(second).not.toBeNull();
			expect(second?.record.metadata).toEqual(base.metadata);
			expect(second?.leaseId).not.toBe(first?.leaseId);
		});

		it("complete is pinned to the claim — a lapsed attempt cannot retire the winner's row", async () => {
			let clock = "2026-01-01T00:00:00Z";
			const store = createRunCheckpointStore(makeAdapter(), {
				now: () => clock,
				claimLeaseMs: 60_000,
			});
			const rec = await store.create(base);
			const stale = await store.claim(rec.id);
			clock = "2026-01-01T00:02:00Z";
			const winner = await store.claim(rec.id);
			if (!stale || !winner) throw new Error("claim failed");

			// The stale attempt comes back from the dead and tries to finish. It must not.
			expect(await store.complete(rec.id, stale.leaseId)).toBeNull();
			expect((await store.get(rec.id))?.status).toBe("claimed");
			expect(await store.complete(rec.id, winner.leaseId)).not.toBeNull();
			expect((await store.get(rec.id))?.status).toBe("consumed");
		});

		// HAZARD P3(a). Every reader departure mints a permanent full-transcript checkpoint, and
		// nothing collected any of them — a turn suspended and resumed twenty times left twenty copies
		// of a growing conversation, nineteen of which no code path can reach: `latestPendingForRun`
		// takes the newest pending row, so an older one is not a fallback, it is dead weight.
		it("retires the checkpoints the run has moved past", async () => {
			const adapter = makeAdapter();
			const store = createRunCheckpointStore(adapter);
			const rows = () =>
				adapter.findMany({ model: "run_checkpoint", where: [] });

			// Twenty suspend/resume cycles, each writing its successor before retiring its own —
			// the order the runtime actually uses (`persistYieldCheckpoint` inside the loop,
			// `complete` after it returns).
			let current = await store.create({
				...base,
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			for (let cycle = 1; cycle <= 20; cycle++) {
				const claim = await store.claim(current.id);
				if (!claim) throw new Error("expected to claim");
				const next = await store.create({
					...base,
					createdAt: `2026-01-01T00:00:${String(cycle).padStart(2, "0")}.000Z`,
				});
				await store.complete(current.id, claim.leaseId);
				current = next;
			}

			// TWO rows, not twenty: the one just consumed, and the successor it wrote. The successor is
			// the whole reason this deletes only what is OLDER — "delete the others" would have taken
			// the run's only way forward.
			expect(await rows()).toHaveLength(2);
			const pending = await store.latestPendingForRun("run-1");
			expect(pending?.id).toBe(current.id);

			// And when the last slice completes without writing a successor, ONE remains.
			const last = await store.claim(current.id);
			if (!last) throw new Error("expected to claim");
			await store.complete(current.id, last.leaseId);
			expect(await rows()).toHaveLength(1);
			expect(await store.latestPendingForRun("run-1")).toBeNull();
		});

		it("leaves another run's checkpoints alone", async () => {
			// Scoped by runId, because two conversations park independently and one finishing says
			// nothing about the other.
			const adapter = makeAdapter();
			const store = createRunCheckpointStore(adapter);
			const mine = await store.create(base);
			const theirs = await store.create({ ...base, runId: "run-2" });

			const claim = await store.claim(mine.id);
			if (!claim) throw new Error("expected to claim");
			await store.complete(mine.id, claim.leaseId);

			expect(await store.get(theirs.id)).not.toBeNull();
		});

		it("rejects malformed stored checkpoint rows", async () => {
			const adapter = makeAdapter();
			const store = createRunCheckpointStore(adapter);
			await adapter.create({
				model: "run_checkpoint",
				data: {
					id: "bad",
					status: "pending",
					createdAt: "2026-01-01T00:00:00Z",
				},
			});
			await expect(store.get("bad")).rejects.toThrow(
				"run_checkpoint record invalid",
			);
		});
	});
}

let sqlite: Database.Database | undefined;

suite("memory adapter", () => memoryAdapter());

suite(
	"kysely (sqlite)",
	() => {
		sqlite = new Database(":memory:");
		const db = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		// The `run_checkpoint` table `busyclaw generate` will emit from runCheckpointSchema
		// (`metadata` holds JSON).
		sqlite.exec(
			`CREATE TABLE run_checkpoint (
						id TEXT PRIMARY KEY, status TEXT, runId TEXT, metadata TEXT, createdAt TEXT,
						consumedAt TEXT, leaseId TEXT, leaseExpiresAt TEXT
					)`,
		);
		return kyselyAdapter(db);
	},
	() => sqlite?.close(),
);
