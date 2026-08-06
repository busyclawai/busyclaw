// THE RUN INBOX'S TWO WAYS OF LOSING A MESSAGE — docs/plans/one-run.md, hazards C3 and C6.
//
// Both end the same way: the message is admitted, the caller is told `admitted: true` with a seq, the
// row is stored — and nobody ever reads it. That acknowledgement is the part that makes it a bug
// rather than a limitation. A bounce is a fine answer; silence is not.
//
// C3 is a NUMBERING collision. `seq` was minted under `controlSeq`, a counter `controlRun` also wrote
// with a bare read-then-update — so a stop racing two admits drove it backwards and the next message
// landed at a seq the drain had already passed. `seq > afterSeq` skipped it forever.
//
// C6 is a TIMING one. The control point is at the top of a step, so a message arriving after the last
// step has nothing left to be seen at; and `at_turn_end` is excluded from the drain by definition, so
// every message ever sent in that mode sat pending with no reader at all.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { durableRedactor, emailDetector, owned, textModel } from "./fixtures";

const SENDER = userPrincipal("operator");

const openDatabases: (() => void)[] = [];
afterEach(() => {
	for (const close of openDatabases.splice(0)) close();
});

/** A claw over real SQLite — uniques are the subject here, and `memoryAdapter` declares it does not
 *  enforce them (`enforcesUnique: false`), so a green run there would certify nothing. */
async function sqliteClaw(reply = "done") {
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
		model: textModel(reply),
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
	return { adapter, agent, claw, store, thread };
}

describe("the message counter is the inbox's own", () => {
	it("keeps numbering messages after a control write, not before it", async () => {
		// THE C3 REGRESSION. `controlRun` writes its watermark from a value read at the top of its own
		// transaction; while the counters were shared, that write could land BELOW a seq an admit had
		// already minted, and the next message was numbered onto ground the drain had covered.
		const { claw, store, agent, thread } = await sqliteClaw();
		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			threadId: thread.id,
		});
		// A fresh run to admit into — the one above has finished.
		const run = await store.createRun({
			input: {},
			recording: { clawId: agent.id, threadId: thread.id },
		});

		const first = await claw.$context.engine?.deliverMessage?.({
			toRunId: run.id,
			body: { text: "one" },
			mode: "next_step",
			sender: SENDER,
			idempotencyKey: "k1",
		});
		expect(first).toMatchObject({ admitted: true, seq: 1 });

		// Two control writes in between, each bumping the CONTROL watermark.
		await claw.api.controlRun({ runId: run.id, intent: "suspend" });

		const second = await claw.$context.engine?.deliverMessage?.({
			toRunId: run.id,
			body: { text: "two" },
			mode: "next_step",
			sender: SENDER,
			idempotencyKey: "k2",
		});
		// STRICTLY AFTER the first, whatever the control watermark did. Shared, this used to be able
		// to come back as 1 again — stored, acknowledged, and skipped by `seq > afterSeq` forever.
		expect(second).toMatchObject({ admitted: true, seq: 2 });
		expect(sent.runId).not.toBe(run.id);
	});

	it("refuses a duplicate (toRunId, seq) at the database", async () => {
		// DEFENCE IN DEPTH for the above: if anything ever renumbers a message onto an occupied slot
		// again, it fails at the insert instead of becoming a row nobody reads.
		const { adapter, store } = await sqliteClaw();
		const run = await store.createRun({ input: {} });
		const row = {
			toRunId: run.id,
			mode: "next_step",
			body: JSON.stringify({ text: "one" }),
			sender: SENDER,
			seq: 1,
			status: "pending",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		await adapter.create({
			model: "run_message",
			data: { ...row, id: "m1" },
		});
		await expect(
			adapter.create({ model: "run_message", data: { ...row, id: "m2" } }),
		).rejects.toThrow();
	});

	it("seeds from the rows, not from zero, on a run that predates the column", async () => {
		// THE MIGRATION TRAP. `planMigrations` emits no UPDATE, so a run created before `messageSeq`
		// existed has no value in it — while its `run_message` rows are already numbered from the old
		// shared counter. Seeding 0 mints seq=1 onto an occupied slot, and `admitMessage`'s catch reads
		// ANY conflict as a redelivery: the message would be acknowledged as already-seen and dropped.
		const { adapter, claw, store } = await sqliteClaw();
		const run = await store.createRun({ input: {} });
		// The shape a pre-split row set has: messages numbered 1..2, and no `messageSeq` on the run.
		for (const seq of [1, 2]) {
			await adapter.create({
				model: "run_message",
				data: {
					id: `legacy-${seq}`,
					toRunId: run.id,
					mode: "next_step",
					body: JSON.stringify({ text: `old ${seq}` }),
					sender: SENDER,
					seq,
					status: "delivered",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			});
		}
		await adapter.update({
			model: "run",
			where: [{ field: "id", value: run.id }],
			update: { messageSeq: null },
		});

		const admitted = await claw.$context.engine?.deliverMessage?.({
			toRunId: run.id,
			body: { text: "new" },
			mode: "next_step",
			sender: SENDER,
			idempotencyKey: "k1",
		});

		// Past the rows that already exist, and genuinely stored.
		expect(admitted).toMatchObject({ admitted: true, seq: 3 });
		const rows = await adapter.findMany({
			model: "run_message",
			where: [{ field: "toRunId", value: run.id }],
		});
		expect(rows).toHaveLength(3);
	});
});

describe("a message the run never read reaches the next turn", () => {
	it("delivers an at_turn_end message to the NEXT run on the thread", async () => {
		// `at_turn_end` is excluded from the drain by definition — it is wake fuel for the next turn —
		// and until now nothing read it, so every message ever sent in that mode sat pending forever.
		//
		// Admitted while the run is LIVE, which is the case that loses a message. One admitted after
		// the run went terminal bounces instead (`admitted: false, bounced: "completed"`), and a bounce
		// is a fine answer — the caller is told. Silence is what this is about.
		const { claw, store, agent, thread } = await sqliteClaw();
		const live = await store.createRun({
			input: {},
			recording: { clawId: agent.id, threadId: thread.id },
		});
		await claw.$context.engine?.deliverMessage?.({
			toRunId: live.id,
			body: { text: "and one more thing" },
			mode: "at_turn_end",
			sender: SENDER,
			idempotencyKey: "k1",
		});
		// That turn ends without ever reading it — which for `at_turn_end` is not a failure, it is
		// the mode's entire meaning.
		await store.updateRun(live.id, { status: "completed" });

		// The next turn on this conversation adopts it at creation.
		const second = await claw.api.sendMessage({
			clawId: agent.id,
			message: "still there?",
			threadId: thread.id,
		});

		const adopted = await store.drainMessages({
			toRunId: second.runId,
			afterSeq: -1,
			step: 0,
		});
		expect(adopted.delivered.map((entry) => entry.body)).toEqual([
			{ text: "and one more thing" },
		]);
		// And the original is retired, so a THIRD turn does not adopt it again.
		const third = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello again",
			threadId: thread.id,
		});
		expect(
			(
				await store.drainMessages({
					toRunId: third.runId,
					afterSeq: -1,
					step: 0,
				})
			).delivered,
		).toEqual([]);
	});

	it("bounces a message that arrives after the run has finished", async () => {
		// The OTHER half of C6, and it was already right: a message into a terminal run is refused by
		// the same write that would have admitted it, so the caller learns immediately rather than
		// being told `admitted: true` about a message nobody will read.
		const { claw, store, agent, thread } = await sqliteClaw();
		const done = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			threadId: thread.id,
		});
		expect((await store.getRun(done.runId))?.status).toBe("completed");

		expect(
			await claw.$context.engine?.deliverMessage?.({
				toRunId: done.runId,
				body: { text: "too late" },
				mode: "at_turn_end",
				sender: SENDER,
				idempotencyKey: "k1",
			}),
		).toMatchObject({ admitted: false, bounced: "completed" });
	});

	it("does not take a LIVE run's messages", async () => {
		// A sibling run still in flight owns its inbox. Adopting from it would deliver one person's
		// words to a turn they were not addressed to.
		const { claw, store, agent, thread } = await sqliteClaw();
		const live = await store.createRun({
			input: {},
			recording: { clawId: agent.id, threadId: thread.id },
		});
		await claw.$context.engine?.deliverMessage?.({
			toRunId: live.id,
			body: { text: "for the live one" },
			mode: "next_step",
			sender: SENDER,
			idempotencyKey: "k1",
		});

		const mine = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			threadId: thread.id,
		});

		expect(
			(
				await store.drainMessages({
					toRunId: mine.runId,
					afterSeq: -1,
					step: 0,
				})
			).delivered,
		).toEqual([]);
		// Still waiting for the run it was sent to.
		expect(
			(await store.drainMessages({ toRunId: live.id, afterSeq: -1, step: 0 }))
				.delivered,
		).toHaveLength(1);
	});

	it("leaves another THREAD's leftovers alone", async () => {
		// Scoped by thread, not by claw. Two conversations in one claw leave their own messages behind
		// and neither should inherit the other's.
		const { claw, store, agent } = await sqliteClaw();
		const other = await claw.api.createThread({
			id: "thread-2",
			clawId: agent.id,
			title: "Elsewhere",
		});
		// LIVE when the message is admitted, then finished — the orphaning shape. Admitted to a
		// terminal run it would merely bounce, and this test would pass with nothing to inherit.
		const elsewhere = await store.createRun({
			input: {},
			recording: { clawId: agent.id, threadId: other.id },
		});
		await claw.$context.engine?.deliverMessage?.({
			toRunId: elsewhere.id,
			body: { text: "not yours" },
			mode: "at_turn_end",
			sender: SENDER,
			idempotencyKey: "k1",
		});
		await store.updateRun(elsewhere.id, { status: "completed" });

		const mine = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			threadId: "thread-1",
		});

		expect(
			(
				await store.drainMessages({
					toRunId: mine.runId,
					afterSeq: -1,
					step: 0,
				})
			).delivered,
		).toEqual([]);
		// And it is still waiting for whoever picks up THAT conversation.
		const nextThere = await claw.api.sendMessage({
			clawId: agent.id,
			message: "back",
			threadId: other.id,
		});
		expect(
			(
				await store.drainMessages({
					toRunId: nextThere.runId,
					afterSeq: -1,
					step: 0,
				})
			).delivered,
		).toHaveLength(1);
	});
});

describe("the memory adapter still runs the plain paths", () => {
	it("admits and numbers without a real database", async () => {
		// The suite above needs SQLite for the unique; this one exists so the ordinary admit path is
		// still covered on the adapter most tests use.
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
		});
		const agent = await claw.api.createClaw({ id: "c1", name: "A" });
		const thread = await claw.api.createThread({ id: "t1", clawId: agent.id });
		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			threadId: thread.id,
		});
		expect(sent.runId).toBeTruthy();
	});
});
