// RESUMING A PARKED RUN IS THE SAME KIND OF WORK AS STARTING ONE, and for a long time it was not
// done the same way. `claw.api.continueRun` called `runtime.continueRun` directly — the runtime knows
// about approvals and nothing about runs — so an approved turn executed OUTSIDE the durable run it
// belonged to.
//
// Three things followed. Nothing fenced it, so a granted approval could resume a CANCELLED run and
// execute the tool call the stop existed to prevent. No chunk of the resumed answer reached a
// watcher, because every chunk is written by `driveClaim`. And no terminal lifecycle was written
// either — so `watchRun` waited forever for a turn that had finished, leaking a connection per
// resumed run.
//
// It goes through the engine now, with `drive`, so the caller still awaits the answer.

import type {
	Adapter,
	RunStreamChunk,
	SchemaDeclaration,
} from "@busyclaw/contracts";
import { threadStreamKey, userPrincipal } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import {
	memorySecondaryStorage,
	secondaryStorageStream,
} from "@busyclaw/storage-core";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
	approvalToolModel,
	drivenResult,
	emailDetector,
	emailTool,
	owned,
} from "./fixtures";

const openDatabases: (() => void)[] = [];
afterEach(() => {
	for (const close of openDatabases.splice(0)) close();
});

async function harness(onTool?: () => void) {
	const sqlite = new Database(":memory:");
	openDatabases.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const store = createSqlEngineStore(adapter);
	const runStream = secondaryStorageStream(memorySecondaryStorage());
	const claw = owned({
		cronHandler: false,
		database: adapter,
		engine: sqlEngine({ store, workerId: "w1", cron: false, runStream }),
		runStream,
		model: approvalToolModel(),
		tools: {
			send_email: emailTool({
				onExecute: () => {
					onTool?.();
					return { sent: true };
				},
			}),
		},
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
	await claw.api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Chat",
	});

	const chunks = async (): Promise<RunStreamChunk[]> => {
		const out: RunStreamChunk[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 20; i++) {
			const page = await runStream.read(threadStreamKey("thread-1"), cursor);
			out.push(...page.chunks);
			if (page.chunks.length === 0) break;
			cursor = page.cursor;
		}
		return out;
	};
	const lifecycles = async () =>
		(await chunks())
			.filter((chunk) => chunk.kind === "lifecycle")
			.map((chunk) => [chunk.event, chunk.reason]);

	/** Send a message that parks on an approval, and hand back the pending approval's id. */
	const parkOnApproval = async () => {
		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			threadId: "thread-1",
		});
		expect(drivenResult(sent).status).toBe("waiting_approval");
		const approvalId = (await claw.api.listApprovals({ status: "pending" }))[0]
			?.id;
		if (!approvalId) throw new Error("expected a pending approval");
		return { approvalId, runId: sent.runId };
	};

	return { agent, chunks, claw, lifecycles, parkOnApproval, store };
}

describe("continueRun goes through the engine", () => {
	it("tells the watcher the turn ended", async () => {
		// THE LEAK. `watchRun` closes on a terminal lifecycle and nothing else, so a resume that wrote
		// none held its subscription open for a run that had been finished for hours.
		const { claw, lifecycles, parkOnApproval } = await harness();
		const { approvalId } = await parkOnApproval();
		expect(await lifecycles()).toEqual([["parked", "approval"]]);

		await claw.api.grantApproval({ approvalId });
		await claw.api.continueRun({ approvalId });

		expect(await lifecycles()).toEqual([
			["parked", "approval"],
			["completed", undefined],
		]);
	});

	it("still hands the caller its answer, synchronously", async () => {
		// `drive` is what keeps this a resume rather than a schedule. Without it the door would return
		// a handle and the answer would arrive whenever cron next ran — a different verb wearing this
		// one's name.
		const { claw, parkOnApproval, store } = await harness();
		const { approvalId, runId } = await parkOnApproval();

		await claw.api.grantApproval({ approvalId });
		const resumed = await claw.api.continueRun({ approvalId });

		expect(resumed).toMatchObject({ status: "completed", text: "done" });
		expect((await store.getRun(runId))?.status).toBe("completed");
	});

	it("writes the resumed answer into the same thread, once", async () => {
		const { claw, parkOnApproval } = await harness();
		const { approvalId } = await parkOnApproval();
		await claw.api.grantApproval({ approvalId });
		await claw.api.continueRun({ approvalId });

		const answers = (
			await claw.api.listMessages({
				threadId: "thread-1",
				visibility: ["user"],
			})
		).filter((message) => message.role === "assistant");
		expect(answers).toHaveLength(1);
		expect(JSON.stringify(answers[0]?.content)).toContain("done");
	});

	it("refuses to resume a run somebody cancelled", async () => {
		// The engine's own fence, reached now rather than approximated by a read at the door. G6 makes
		// this reachable on purpose: revoking a member cancels their parked runs, and every one of
		// those is parked ON an approval somebody can still grant.
		let toolCalls = 0;
		const { claw, parkOnApproval, store } = await harness(() => {
			toolCalls += 1;
		});
		const { approvalId, runId } = await parkOnApproval();

		await claw.api.controlRun({ runId, intent: "stop" });
		expect((await store.getRun(runId))?.status).toBe("cancelled");

		await claw.api.grantApproval({ approvalId });
		await expect(claw.api.continueRun({ approvalId })).rejects.toThrow();
		expect(toolCalls).toBe(0);
	});

	it("stores a DENIED resume instead of throwing at the task write", async () => {
		// A denied result is built straight off the approval record, so a denial with no reason code
		// carries `reasonCode: undefined` — which the type permits and JSON refuses. Every terminal
		// branch persists the result, so this threw `task output invalid` and killed the slice; a
		// GRANTED approval returns `completed`, which has no optional fields, which is why it was
		// only reachable through the door nobody had pointed at the engine yet.
		const { claw, parkOnApproval, store } = await harness();
		const { approvalId, runId } = await parkOnApproval();

		await claw.api.denyApproval(
			{ approvalId, reason: "not allowed" },
			{ principal: userPrincipal("actor-1") },
		);
		const denied = await claw.api.continueRun({ approvalId });

		expect(denied).toMatchObject({ status: "denied" });
		// The run's own status is `completed`: the vocabulary has no `denied` member on purpose, and a
		// refused run did finish.
		expect((await store.getRun(runId))?.status).toBe("completed");
	});

	it("tells the watcher a denial is a DENIAL, not a completion", async () => {
		// The engine used to settle both outcomes through one branch and call both `run.completed` —
		// so its history contradicted the runtime's, which emits `run.denied` for the same result, and
		// the transcript, which records the denial as its own state (D10). One fact, three doors, and
		// the one a UI reads was the one that lied.
		const { claw, lifecycles, parkOnApproval, store } = await harness();
		const { approvalId, runId } = await parkOnApproval();

		await claw.api.denyApproval(
			{ approvalId, reason: "not allowed" },
			{ principal: userPrincipal("actor-1") },
		);
		await claw.api.continueRun({ approvalId });

		expect(await lifecycles()).toEqual([
			["parked", "approval"],
			["denied", undefined],
		]);
		// And the operational history says it too.
		expect((await store.events(runId)).map((event) => event.type)).toContain(
			"run.denied",
		);
	});
});
