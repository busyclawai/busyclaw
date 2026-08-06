// REVOKING ACCESS WHILE THE ACCESS IS BEING USED — docs/plans/one-run.md, hazard G6.
//
// Authority is resolved ONCE per slice, from `run.principal`. So deleting a grant row stopped new
// runs and did nothing at all to the ones already in flight: a member removed from a claw kept
// executing tool calls in it under the authority they had just lost, until their run happened to
// finish on its own. That is the moment revocation matters most, and it was the moment it did least.
//
// The case is not hypothetical and not brief. A turn parked on an approval sits `waiting`
// indefinitely — that is the whole point of parking — so "until it finishes" can mean days, and the
// thing waiting to happen is a governed write.
//
// A claw-ANCHORED run is what this reaches, which means a conversational one: `claw.api.startRun`
// takes no recording, so a run started that way has no `clawId` and no claw to be revoked from.

import type {
	Adapter,
	Principal,
	SchemaDeclaration,
} from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { createStoredRedactor } from "@busyclaw/core";
import { createSqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import type { RuntimeModel } from "@busyclaw/runtime";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { drivenResult, emailDetector, emailTool, owned } from "./fixtures";

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/**
 * Asks to send an email whenever it has not already been given a tool result.
 *
 * STATELESS across runs, deliberately: the shared fixture counts calls on the model object, so a
 * second turn in the same claw answers in text and never parks — which is the case this file needs
 * two of. Keyed on the conversation it is handed instead, which is a property of the run.
 */
function parksOnApproval(): RuntimeModel {
	const hasToolResult = (prompt: unknown): boolean =>
		Array.isArray(prompt) &&
		prompt.some(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				(message as { role?: unknown }).role === "tool",
		);
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options: { prompt?: unknown }) => ({
			content: hasToolResult(options.prompt)
				? [{ type: "text" as const, text: "done" }]
				: [
						{
							type: "tool-call" as const,
							toolCallId: "c1",
							toolName: "send_email",
							input: JSON.stringify({
								to: "alice@personal.com",
								body: "hi",
							}),
						},
					],
			finishReason: {
				unified: hasToolResult(options.prompt)
					? ("stop" as const)
					: ("tool-calls" as const),
				raw: undefined,
			},
			usage,
			warnings: [],
		}),
	} as unknown as RuntimeModel;
}

const OWNER = userPrincipal("actor-1");
const GUEST = userPrincipal("guest-1");

const openDatabases: (() => void)[] = [];
afterEach(() => {
	for (const close of openDatabases.splice(0)) close();
});

/** A claw whose one tool is a governed write, so every turn parks on an approval and stays parked. */
async function harness(onTool?: () => void) {
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
		model: parksOnApproval(),
		redaction: {
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(adapter),
			}),
		},
		tools: {
			send_email: emailTool({
				onExecute: () => {
					onTool?.();
					return { sent: true };
				},
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
	const share = (principal: Principal) =>
		claw.api.shareResource({
			resourceKind: "claw",
			resourceId: agent.id,
			principalRef: principal,
			permission: "use",
		});
	const revoke = (
		principal: Principal,
		target: { resourceKind: string; resourceId: string } = {
			resourceKind: "claw",
			resourceId: agent.id,
		},
	) => claw.api.unshareResource({ ...target, principalRef: principal });
	/** A turn that parks on an approval, driven by whoever sends it. */
	const parkedTurnFrom = async (principal: Principal) => {
		const sent = await claw.api.sendMessage(
			{
				clawId: agent.id,
				message: "email alice@personal.com",
				threadId: thread.id,
			},
			{ principal },
		);
		expect(drivenResult(sent).status).toBe("waiting_approval");
		expect((await store.getRun(sent.runId))?.status).toBe("waiting");
		return sent.runId;
	};
	return { agent, claw, parkedTurnFrom, revoke, share, store, thread };
}

describe("revocation reaches the runs it authorized", () => {
	it("stops the guest's parked run in the claw they were just removed from", async () => {
		const { parkedTurnFrom, revoke, share, store } = await harness();
		await share(GUEST);
		const runId = await parkedTurnFrom(GUEST);

		await revoke(GUEST);

		// Settled, not merely latched: a `waiting` run has no holder to observe a latch, and leaving
		// it parked would be the hang the synchronous branch of `controlRun` exists to prevent.
		expect((await store.getRun(runId))?.status).toBe("cancelled");
		expect(
			(await store.events(runId)).some(
				(event) => event.type === "run.cancelled",
			),
		).toBe(true);
	});

	it("executes zero further tool calls, even when the approval is granted afterwards", async () => {
		// THE PROPERTY, rather than the status write that implies it. The write this run is parked on
		// is the thing revocation has to prevent, and an approval granted a minute later is exactly how
		// it would otherwise still happen.
		let toolCalls = 0;
		const { claw, parkedTurnFrom, revoke, share } = await harness(() => {
			toolCalls += 1;
		});
		await share(GUEST);
		await parkedTurnFrom(GUEST);
		const approvalId = (await claw.api.listApprovals({ status: "pending" }))[0]
			?.id;
		if (!approvalId) throw new Error("expected a pending approval");

		await revoke(GUEST);

		await claw.api.grantApproval({ approvalId });
		await expect(claw.api.continueRun({ approvalId })).rejects.toThrow();
		expect(toolCalls).toBe(0);
	});

	it("leaves everybody ELSE's runs alone", async () => {
		// Scoped to the principal who lost access. A sweep of the claw's runs would take the owner's
		// with them — which is the same outage, caused by the fix.
		const { parkedTurnFrom, revoke, share, store } = await harness();
		await share(GUEST);
		const mine = await parkedTurnFrom(OWNER);
		const theirs = await parkedTurnFrom(GUEST);

		await revoke(GUEST);

		expect((await store.getRun(theirs))?.status).toBe("cancelled");
		expect((await store.getRun(mine))?.status).toBe("waiting");
	});

	it("touches no run when the revoked resource is not a claw", async () => {
		// Threads, approvals and policy slices are all unshareable, and none of them names a claw. A
		// sweep that fired on every unshare would stop runs for a revocation that had nothing to do
		// with them.
		const { parkedTurnFrom, revoke, share, store, thread } = await harness();
		await share(GUEST);
		const runId = await parkedTurnFrom(GUEST);

		await revoke(GUEST, { resourceKind: "thread", resourceId: thread.id });

		expect((await store.getRun(runId))?.status).toBe("waiting");
	});
});
