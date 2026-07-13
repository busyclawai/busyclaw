import { type Adapter, memoryAdapter } from "@euroclaw/storage-core";
import { kyselyAdapter } from "@euroclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovalStore } from "../src/approval";
import { createEffectStore } from "../src/effect";
import { createPiiMappingStore } from "../src/pii";

// The stored args are REDACTED (placeholders) — what resume replays.
const base = {
	gateId: "oversight",
	toolName: "send_email",
	args: { to: "{{pii:abc}}" },
	createdAt: "2026-01-01T00:00:00Z",
};

// Run the same suite over every adapter — the store is adapter-agnostic.
function suite(
	name: string,
	makeAdapter: () => Adapter,
	teardown?: () => void,
): void {
	describe(`createApprovalStore over ${name}`, () => {
		afterEach(() => teardown?.());

		it("create → pending, and the redacted args round-trip through storage", async () => {
			const store = createApprovalStore(makeAdapter());
			const rec = await store.create(base);
			expect(rec.status).toBe("pending");
			expect(rec.id).toMatch(/^[0-9a-f]{32}$/);
			const [listed] = await store.list({ status: "pending" });
			expect(listed?.id).toBe(rec.id);
			expect(listed?.args).toEqual({ to: "{{pii:abc}}" }); // parsed back from JSON, not a string
		});

		it("grant then consume is single-use, returning the replayable call", async () => {
			const store = createApprovalStore(makeAdapter());
			const rec = await store.create(base);
			expect(await store.consume(rec.id)).toBeNull(); // not granted yet
			expect((await store.grant(rec.id, "alice"))?.status).toBe("approved");
			const consumed = await store.consume(rec.id);
			expect(consumed?.toolName).toBe("send_email");
			expect(consumed?.args).toEqual({ to: "{{pii:abc}}" }); // the call to re-run
			expect(await store.consume(rec.id)).toBeNull(); // single-use
			expect((await store.get(rec.id))?.status).toBe("consumed"); // checkpoint retained
		});

		it("deny blocks consume, and a decided row can't be re-decided", async () => {
			const store = createApprovalStore(makeAdapter());
			const rec = await store.create(base);
			expect(await store.deny(rec.id, "alice", "not allowed")).toMatchObject({
				status: "denied",
				reason: "not allowed",
			});
			expect(await store.grant(rec.id, "bob")).toBeNull(); // no longer pending
			expect(await store.consume(rec.id)).toBeNull();
		});

		it("an expired approval can't be consumed", async () => {
			const store = createApprovalStore(makeAdapter(), {
				now: () => "2026-06-01T00:00:00Z",
			});
			const rec = await store.create({
				...base,
				expiresAt: "2026-01-01T00:00:00Z",
			});
			await store.grant(rec.id, "alice");
			expect(await store.consume(rec.id)).toBeNull();
		});

		it("consume is race-safe — concurrent resumes, exactly one winner", async () => {
			const store = createApprovalStore(makeAdapter());
			const rec = await store.create(base);
			await store.grant(rec.id, "alice");
			const results = await Promise.all(
				Array.from({ length: 5 }, () => store.consume(rec.id)),
			);
			expect(results.filter((r) => r !== null)).toHaveLength(1);
		});

		it("rejects malformed stored approval rows", async () => {
			const adapter = makeAdapter();
			const store = createApprovalStore(adapter);
			await adapter.create({
				model: "approval",
				data: {
					id: "bad",
					status: "pending",
					gateId: "oversight",
					toolName: "send_email",
					args: "[]",
					createdAt: "2026-01-01T00:00:00Z",
				},
			});

			await expect(store.list()).rejects.toThrow(/approval record invalid/);
		});
	});
}

suite("memory adapter", () => memoryAdapter());

describe("createPiiMappingStore", () => {
	it("contains rehydration to a container and forgets a subject across containers", async () => {
		const store = createPiiMappingStore(memoryAdapter());
		await store.save(
			{
				placeholder: "{{pii:aaa}}",
				original: "alice@example.com",
				kind: "email",
				scope: "claw",
				scopeId: "a",
				createdAt: "2026-01-01T00:00:00Z",
			},
			["u1"],
		);
		await store.save(
			{
				placeholder: "{{pii:bbb}}",
				original: "bob@example.com",
				kind: "email",
				scope: "claw",
				scopeId: "b",
				createdAt: "2026-01-01T00:00:00Z",
			},
			["u2"],
		);
		// One value about TWO subjects (a shared address), in container claw:a.
		await store.save(
			{
				placeholder: "{{pii:ccc}}",
				original: "123 Main St",
				kind: "address",
				scope: "claw",
				scopeId: "a",
				createdAt: "2026-01-01T00:00:00Z",
			},
			["u1", "u2"],
		);

		// Rehydration only within the SAME container.
		expect(
			await store.resolve("{{pii:aaa}}", { scope: "claw", scopeId: "a" }),
		).toBe("alice@example.com");
		expect(
			await store.resolve("{{pii:aaa}}", { scope: "claw", scopeId: "b" }),
		).toBeNull();
		expect(await store.resolve("{{pii:aaa}}")).toBeNull();
		expect(
			await store.resolve("{{pii:bbb}}", { scope: "claw", scopeId: "b" }),
		).toBe("bob@example.com");

		// Erase u1 → alice's mapping AND the shared value (u1+u2) both gone; bob's untouched.
		await store.deleteForSubject("u1");
		expect(
			await store.resolve("{{pii:aaa}}", { scope: "claw", scopeId: "a" }),
		).toBeNull();
		expect(
			await store.resolve("{{pii:ccc}}", { scope: "claw", scopeId: "a" }),
		).toBeNull();
		expect(
			await store.resolve("{{pii:bbb}}", { scope: "claw", scopeId: "b" }),
		).toBe("bob@example.com");
	});
});

describe("createEffectStore", () => {
	it("claims one active lease and reports concurrent callers as in progress", async () => {
		const store = createEffectStore(memoryAdapter());
		const first = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:00.000Z",
			leaseTtlMs: 1_000,
		});
		expect(first.status).toBe("claimed");

		const second = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:00.500Z",
			leaseTtlMs: 1_000,
		});

		expect(second.status).toBe("in_progress");
		expect(second.record.leaseExpiresAt).toBe("2026-01-01T00:00:01.000Z");
	});

	it("reclaims expired leases and fences the old owner", async () => {
		const store = createEffectStore(memoryAdapter());
		const first = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:00.000Z",
			leaseTtlMs: 1_000,
		});
		if (first.status !== "claimed") throw new Error("expected first claim");

		const second = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:02.000Z",
			leaseTtlMs: 1_000,
		});
		if (second.status !== "claimed") throw new Error("expected reclaim");

		await expect(
			store.complete({
				id: "effect-1",
				leaseToken: first.leaseToken,
				output: { sent: true },
				now: "2026-01-01T00:00:02.100Z",
			}),
		).rejects.toThrow(/lease is not active/);

		const completed = await store.complete({
			id: "effect-1",
			leaseToken: second.leaseToken,
			output: { sent: true },
			now: "2026-01-01T00:00:02.100Z",
		});
		expect(completed.status).toBe("completed");

		const replay = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:03.000Z",
		});
		expect(replay).toMatchObject({
			status: "completed",
			record: { output: { sent: true } },
		});
	});

	it("marks expired non-idempotent effects as uncertain instead of reclaiming", async () => {
		const store = createEffectStore(memoryAdapter());
		const first = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:00.000Z",
			leaseTtlMs: 1_000,
		});
		if (first.status !== "claimed") throw new Error("expected first claim");

		const uncertain = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:02.000Z",
			reclaimExpired: false,
		});

		expect(uncertain).toMatchObject({
			status: "uncertain",
			leaseExpiresAt: "2026-01-01T00:00:01.000Z",
		});
		expect((await store.get("effect-1"))?.status).toBe("started");
	});

	it("rejects reusing an effect id for different input", async () => {
		const store = createEffectStore(memoryAdapter());
		await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:00.000Z",
		});

		await expect(
			store.claim({
				id: "effect-1",
				toolName: "send_email",
				inputHash: "h2",
				now: "2026-01-01T00:00:02.000Z",
			}),
		).rejects.toThrow(/different input/);
	});

	it("rejects non-JSON effect outputs", async () => {
		const store = createEffectStore(memoryAdapter());
		const claim = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:00.000Z",
		});
		if (claim.status !== "claimed") throw new Error("expected claim");

		await expect(
			store.complete({
				id: "effect-1",
				leaseToken: claim.leaseToken,
				output: { nested: { fn: () => "nope" } },
				now: "2026-01-01T00:00:01.000Z",
			}),
		).rejects.toThrow(/effect\.output invalid/);
	});
});

describe("createEffectStore over kysely (sqlite)", () => {
	let effectSqlite: Database.Database;

	afterEach(() => effectSqlite?.close());

	function effectStore() {
		effectSqlite = new Database(":memory:");
		const db = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: new SqliteDialect({ database: effectSqlite }),
		});
		effectSqlite.exec(
			`CREATE TABLE effect (
					id TEXT PRIMARY KEY, status TEXT, toolName TEXT, inputHash TEXT, output TEXT, error TEXT,
					compensation TEXT, compensationEffectId TEXT, leaseTokenHash TEXT, leaseExpiresAt TEXT,
					createdAt TEXT, updatedAt TEXT
				)`,
		);
		return createEffectStore(kyselyAdapter(db));
	}

	it("claims, completes, and replays completed effects", async () => {
		const store = effectStore();
		const claim = await store.claim({
			id: "effect-1",
			toolName: "send_email",
			inputHash: "h1",
			now: "2026-01-01T00:00:00.000Z",
		});
		if (claim.status !== "claimed") throw new Error("expected claim");

		await expect(
			store.claim({
				id: "effect-1",
				toolName: "send_email",
				inputHash: "h1",
				now: "2026-01-01T00:00:01.000Z",
			}),
		).resolves.toMatchObject({ status: "in_progress" });

		await store.complete({
			id: "effect-1",
			leaseToken: claim.leaseToken,
			output: { sent: true },
			now: "2026-01-01T00:00:02.000Z",
		});

		await expect(
			store.claim({
				id: "effect-1",
				toolName: "send_email",
				inputHash: "h1",
				now: "2026-01-01T00:00:03.000Z",
			}),
		).resolves.toMatchObject({
			status: "completed",
			record: { output: { sent: true } },
		});
	});
});

// And over a real SQLite database via Kysely.
let sqlite: Database.Database;
suite(
	"kysely (sqlite)",
	() => {
		sqlite = new Database(":memory:");
		const db = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		// The `approval` table `euroclaw generate` will emit from approvalSchema (`args` holds JSON).
		sqlite.exec(
			`CREATE TABLE approval (
						id TEXT PRIMARY KEY, status TEXT, gateId TEXT, toolName TEXT, args TEXT, reasonCode TEXT, metadata TEXT,
						principal TEXT, reason TEXT, decidedBy TEXT, createdAt TEXT, expiresAt TEXT
					)`,
		);
		return kyselyAdapter(db);
	},
	() => sqlite?.close(),
);
