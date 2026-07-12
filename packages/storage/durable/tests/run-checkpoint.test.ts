import { type Adapter, memoryAdapter } from "@euroclaw/storage-core";
import { kyselyAdapter } from "@euroclaw/storage-kysely";
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

		it("consume is single-use and stamps consumedAt", async () => {
			const store = createRunCheckpointStore(makeAdapter(), {
				now: () => "2026-01-01T00:05:00Z",
			});
			const rec = await store.create(base);
			const consumed = await store.consume(rec.id);
			expect(consumed?.metadata).toEqual(base.metadata); // the envelope to resume from
			expect(await store.consume(rec.id)).toBeNull(); // single-use
			const read = await store.get(rec.id);
			expect(read?.status).toBe("consumed"); // row retained for observability
			expect(read?.consumedAt).toBe("2026-01-01T00:05:00Z");
		});

		it("consume of an unknown id returns null", async () => {
			const store = createRunCheckpointStore(makeAdapter());
			expect(await store.consume("missing")).toBeNull();
		});

		it("consume is race-safe — concurrent continuations, exactly one winner", async () => {
			const store = createRunCheckpointStore(makeAdapter());
			const rec = await store.create(base);
			const results = await Promise.all(
				Array.from({ length: 5 }, () => store.consume(rec.id)),
			);
			expect(results.filter((r) => r !== null)).toHaveLength(1);
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
		// The `run_checkpoint` table `euroclaw generate` will emit from runCheckpointSchema
		// (`metadata` holds JSON).
		sqlite.exec(
			`CREATE TABLE run_checkpoint (
						id TEXT PRIMARY KEY, status TEXT, runId TEXT, metadata TEXT, createdAt TEXT, consumedAt TEXT
					)`,
		);
		return kyselyAdapter(db);
	},
	() => sqlite?.close(),
);
