// RETENTION, ON THE HOST'S SCHEDULE — the operational exhaust of finished runs.
//
// Making a chat turn a durable run put four tables on the chat path that grow at chat rate and that
// nothing prunes: `run_event` (3-6 rows a turn), `runtime_task` (payload and output retained by
// `completeTask`), `run_message`, and `run_checkpoint` (bounded per run by supersession, unbounded
// across them).
//
// NOT a job this library runs. A retention window is host policy — 30 days is wrong for a regulated
// tenant and seven years is wrong for a chat toy — so the window is an argument and the host's own
// cron decides the cadence. What ships is the primitive.
//
// And it deletes EXHAUST, never record: the run rows stay, so `message.runId` still resolves and
// `getRun` still answers; the transcript stays, because it is the product.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createClawApi } from "../src/api";
import { emailDetector, owned, textModel } from "./fixtures";

const openDatabases: (() => void)[] = [];
afterEach(() => {
	for (const close of openDatabases.splice(0)) close();
});

async function harness() {
	const sqlite = new Database(":memory:");
	openDatabases.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const store = createSqlEngineStore(adapter);
	const claw = owned({
		cronHandler: false,
		database: adapter,
		engine: sqlEngine({ store, workerId: "w1", cron: false }),
		model: textModel("done"),
		redaction: {
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(adapter),
			}),
		},
	} as Parameters<typeof owned>[0]);
	const plan = await planMigrations({
		db: kdb,
		schema: claw.$tables as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	const agent = await claw.api.createClaw({ id: "claw-1", name: "Assistant" });
	const thread = await claw.api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Chat",
	});
	const rows = async (model: string) =>
		(await adapter.findMany({ model, where: [] })).length;
	const turn = (message: string) =>
		claw.api.sendMessage({ clawId: agent.id, message, threadId: thread.id });
	return { adapter, agent, claw, rows, store, thread, turn };
}

/** An ISO stamp far enough ahead that every run so far counts as old. */
const LATER = "2099-01-01T00:00:00.000Z";
const EARLIER = "2000-01-01T00:00:00.000Z";

describe("pruneRuns", () => {
	it("removes the exhaust and keeps the record", async () => {
		const { agent, claw, rows, turn } = await harness();
		const first = await turn("hello");
		await turn("again");

		expect(await rows("run")).toBe(2);
		expect(await rows("run_event")).toBeGreaterThan(0);
		expect(await rows("runtime_task")).toBe(2);

		const swept = await claw.api.pruneRuns({
			clawId: agent.id,
			before: LATER,
		});

		expect(swept.runs).toBe(2);
		expect(swept.events).toBeGreaterThan(0);
		expect(swept.tasks).toBe(2);
		expect(await rows("run_event")).toBe(0);
		expect(await rows("runtime_task")).toBe(0);

		// THE RECORD SURVIVES, which is what separates this from deleting the runs. `message.runId`
		// still resolves and the conversation still reads back in full.
		expect(await rows("run")).toBe(2);
		expect(await claw.api.getRun({ id: first.runId })).toMatchObject({
			id: first.runId,
			status: "completed",
		});
		const messages = await claw.api.listMessages({ threadId: "thread-1" });
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(JSON.stringify(messages)).toContain("done");
	});

	it("leaves a run that finished AFTER the cutoff alone", async () => {
		// The window is the whole point: a prune that ignored it would be "delete everything", which
		// is a different and much worse verb.
		const { agent, claw, rows, turn } = await harness();
		await turn("hello");

		const swept = await claw.api.pruneRuns({
			clawId: agent.id,
			before: EARLIER,
		});

		expect(swept).toMatchObject({ runs: 0, events: 0, tasks: 0 });
		expect(await rows("run_event")).toBeGreaterThan(0);
	});

	it("leaves an UNFINISHED run alone, whatever the cutoff says", async () => {
		// Its task is how it gets claimed and its checkpoint is how it resumes — pruning either would
		// strand it. Age is not the test; being over is.
		const { agent, claw, rows, store, turn } = await harness();
		await turn("hello");
		await store.createRun({
			input: {},
			recording: { clawId: agent.id, threadId: "thread-1" },
		});

		const swept = await claw.api.pruneRuns({
			clawId: agent.id,
			before: LATER,
		});

		expect(swept.runs).toBe(1);
		expect(await rows("run")).toBe(2);
	});

	it("does not reach into another claw", async () => {
		const { claw, rows, turn } = await harness();
		await turn("hello");
		const other = await claw.api.createClaw({ id: "claw-2", name: "Other" });

		const swept = await claw.api.pruneRuns({
			clawId: other.id,
			before: LATER,
		});

		expect(swept.runs).toBe(0);
		expect(await rows("run_event")).toBeGreaterThan(0);
	});

	it("is bounded, oldest first, so a host can loop until it comes back empty", async () => {
		// A year of chat cannot be swept inside one request. Oldest-first is what makes the loop
		// composable — each pass takes the next slice rather than re-scanning the same page.
		const { agent, claw, rows, turn } = await harness();
		for (let i = 0; i < 3; i++) await turn(`turn ${i}`);

		const first = await claw.api.pruneRuns({
			clawId: agent.id,
			before: LATER,
			limit: 2,
		});
		expect(first.runs).toBe(2);
		expect(await rows("runtime_task")).toBe(1);

		const second = await claw.api.pruneRuns({
			clawId: agent.id,
			before: LATER,
			limit: 2,
		});
		expect(second.runs).toBe(1);
		expect(await rows("runtime_task")).toBe(0);

		const third = await claw.api.pruneRuns({
			clawId: agent.id,
			before: LATER,
			limit: 2,
		});
		expect(third.runs).toBe(0);
	});

	it("sweeps the checkpoints too, which live behind a different port", async () => {
		const { agent, claw, rows, store, turn } = await harness();
		const done = await turn("hello");
		// A consumed checkpoint is what a finished multi-slice run leaves behind.
		await store.updateRun(done.runId, { status: "completed" });
		const checkpoints = claw.$context.runtime.checkpoints;
		if (!checkpoints) throw new Error("expected a checkpoint store");
		await checkpoints.create({
			runId: done.runId,
			metadata: {
				version: "runtime.ai-sdk.yield.v1",
				nextStep: 1,
				messages: [],
			},
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		expect(await rows("run_checkpoint")).toBe(1);

		const swept = await claw.api.pruneRuns({
			clawId: agent.id,
			before: LATER,
		});

		expect(swept.checkpoints).toBe(1);
		expect(await rows("run_checkpoint")).toBe(0);
	});

	it("takes the OLDEST first, which is what makes a bounded call composable", async () => {
		// A bounded prune that took the newest first would sweep the recent end and re-scan forever
		// without ever reaching the backlog the host is trying to clear.
		const { adapter, agent, claw, turn } = await harness();
		const oldest = await turn("first");
		const newest = await turn("second");

		await claw.api.pruneRuns({ clawId: agent.id, before: LATER, limit: 1 });

		const tasks = await adapter.findMany({ model: "runtime_task", where: [] });
		expect(tasks.map((task) => (task as { runId: string }).runId)).toEqual([
			newest.runId,
		]);
		expect(
			tasks.map((task) => (task as { runId: string }).runId),
		).not.toContain(oldest.runId);
	});

	it("is idempotent — a second pass over swept runs reports nothing", async () => {
		// THE CONVERGENCE THE CONTRACT PROMISES. The run rows survive a prune, so without a mark the
		// next call selects the same runs, reports the same count, and "loop until 0" spins forever.
		const { agent, claw, turn } = await harness();
		await turn("hello");
		await turn("again");

		expect(
			(await claw.api.pruneRuns({ clawId: agent.id, before: LATER })).runs,
		).toBe(2);
		expect(
			(await claw.api.pruneRuns({ clawId: agent.id, before: LATER })).runs,
		).toBe(0);
	});

	it("says so rather than reporting zero when the engine cannot prune", async () => {
		// "Nothing to prune" and "this engine cannot prune" are different facts, and a host scheduling
		// this has to learn the second at the first call rather than from a disk graph six months on.
		// The case is real: `pruneRuns` is optional on the handle, because an engine over a backend
		// that owns its own durability prunes differently or not at all.
		const { claw } = await harness();
		const engine = claw.$context.engine;
		if (!engine) throw new Error("expected an engine");
		const { pruneRuns: _omitted, ...cannotPrune } = engine;
		const api = createClawApi({
			context: { ...claw.$context, engine: cannotPrune },
			newId: () => "x",
		});

		await expect(
			api.pruneRuns({ clawId: "claw-1", before: LATER }),
		).rejects.toThrow(/cannot prune/);
	});
});
