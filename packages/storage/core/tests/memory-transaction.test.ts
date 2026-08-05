import { describe, expect, it } from "vitest";
import { memoryAdapter } from "../src/index";

/** A gate the test opens by hand, so "while the body is running" is an ORDERING rather than a race
 *  against a timer. No `setTimeout` here — this package's lib has none, and a sleep would only make
 *  the same assertion slower and flakier. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open: () => void = () => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

describe("memoryAdapter.transaction — copy on write", () => {
	/**
	 * THE BUG THIS EXISTS FOR. The old implementation snapshotted the whole database, ran the body
	 * against the copy, and committed with `state.clear()` + refill — so every write that landed on
	 * the real state while the body was running was annihilated. Not conflicted, not retried: erased.
	 *
	 * That was survivable while this adapter meant "one driver, dev only". It stopped being survivable
	 * when a defaulted engine put a caller and a cron drain in one process, because the writes being
	 * erased include another run's heartbeat renewal — which then reads as a lost lease and aborts
	 * work that was perfectly healthy.
	 */
	it("keeps a concurrent write that lands while the body is running", async () => {
		const db = memoryAdapter();
		if (!db.transaction) throw new Error("memoryAdapter has a transaction");
		await db.create({ model: "lease", data: { id: "a", beats: 0 } });
		await db.create({ model: "lease", data: { id: "b", beats: 0 } });

		const opened = gate();
		const proceed = gate();
		const tx = db.transaction(async (t) => {
			await t.update({
				model: "lease",
				where: [{ field: "id", value: "a" }],
				update: { beats: 1 },
			});
			opened.open();
			await proceed.wait;
		});

		// A DIFFERENT row, written outside the transaction while it is open — the heartbeat case.
		await opened.wait;
		await db.update({
			model: "lease",
			where: [{ field: "id", value: "b" }],
			update: { beats: 99 },
		});
		proceed.open();
		await tx;

		expect(
			await db.findOne({
				model: "lease",
				where: [{ field: "id", value: "a" }],
			}),
		).toMatchObject({ beats: 1 });
		// Under snapshot-and-replace this read `0` — the concurrent write was gone.
		expect(
			await db.findOne({
				model: "lease",
				where: [{ field: "id", value: "b" }],
			}),
		).toMatchObject({ beats: 99 });
	});

	it("merges per FIELD, so an untouched column survives a concurrent write", async () => {
		const db = memoryAdapter();
		if (!db.transaction) throw new Error("memoryAdapter has a transaction");
		await db.create({
			model: "run",
			data: { id: "r", status: "queued", seq: 0 },
		});

		const opened = gate();
		const proceed = gate();
		const tx = db.transaction(async (t) => {
			await t.update({
				model: "run",
				where: [{ field: "id", value: "r" }],
				update: { status: "running" },
			});
			opened.open();
			await proceed.wait;
		});
		await opened.wait;
		// Same ROW, different COLUMN. A whole-row commit would clobber this back to 0 — the same bug
		// one scope smaller, and the reason the overlay tracks touched FIELDS rather than rows.
		await db.update({
			model: "run",
			where: [{ field: "id", value: "r" }],
			update: { seq: 7 },
		});
		proceed.open();
		await tx;

		expect(
			await db.findOne({ model: "run", where: [{ field: "id", value: "r" }] }),
		).toMatchObject({ status: "running", seq: 7 });
	});

	it("discards everything when the body throws", async () => {
		const db = memoryAdapter();
		if (!db.transaction) throw new Error("memoryAdapter has a transaction");
		await db.create({ model: "run", data: { id: "r", status: "queued" } });

		await expect(
			db.transaction(async (t) => {
				await t.update({
					model: "run",
					where: [{ field: "id", value: "r" }],
					update: { status: "running" },
				});
				await t.create({ model: "run", data: { id: "ghost" } });
				await t.delete({ model: "run", where: [{ field: "id", value: "r" }] });
				throw new Error("nope");
			}),
		).rejects.toThrow(/nope/);

		// Untouched: the patch, the insert and the delete all die with the layer.
		expect(
			await db.findOne({ model: "run", where: [{ field: "id", value: "r" }] }),
		).toMatchObject({ status: "queued" });
		expect(
			await db.findOne({
				model: "run",
				where: [{ field: "id", value: "ghost" }],
			}),
		).toBeNull();
	});

	it("nests, instead of deadlocking on a mutex it can never release", async () => {
		const db = memoryAdapter();
		if (!db.transaction) throw new Error("memoryAdapter has a transaction");
		await db.create({ model: "run", data: { id: "r", status: "queued" } });

		// The shape `claimDueTask` needs: a store verb that opens its own transaction, called from
		// inside one. Under the serialized snapshot version this hung forever — the inner call awaited
		// a promise only its own caller could resolve.
		await db.transaction(async (t) => {
			if (!t.transaction) throw new Error("a layer nests");
			await t.transaction(async (inner) => {
				await inner.update({
					model: "run",
					where: [{ field: "id", value: "r" }],
					update: { status: "running" },
				});
			});
			// The outer layer sees the inner layer's commit.
			expect(
				await t.findOne({ model: "run", where: [{ field: "id", value: "r" }] }),
			).toMatchObject({ status: "running" });
		});

		expect(
			await db.findOne({ model: "run", where: [{ field: "id", value: "r" }] }),
		).toMatchObject({ status: "running" });
	});
});
