// A policy can tell a subagent from its parent — which, until this landed, it could not.
//
// A child is otherwise indistinguishable at the floor: authority is COPIED, so the principal is the
// same string; it runs in the same claw with the same tools under the same policies. The only thing
// that says "this is a subordinate" is an `agent_edge` row, and the runtime cannot read plugin tables.
// So "a subagent may not send email" was unwriteable, and every child carried its parent's full
// authority whether anyone wanted that or not.
//
// The fact is DERIVED from the edge, not carried on the run's ctx or its task payload. Those are
// channels a caller writes, and a fact the caller can set is not a control — a child would claim
// depth 0 and the rule would evaporate. The edge is written by this plugin, keyed on the child's own
// run id, and nothing outside can forge one.

import type { Adapter, SchemaDeclaration } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { kyselyAdapter, planMigrations } from "@busyclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { spawningClaw } from "./harness";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

const alice = userPrincipal("alice");

async function harness() {
	const sqlite = new Database(":memory:");
	closers.push(() => sqlite.close());
	const kdb = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	const adapter: Adapter = kyselyAdapter(kdb);
	const claw = spawningClaw({ adapter });
	const plan = await planMigrations({
		db: kdb,
		schema: claw.$tables as SchemaDeclaration,
		dialect: "sqlite",
		warn: () => undefined,
	});
	await plan.runMigrations();
	return claw;
}

/** The facts the plugin offers for one run, as the runtime would collect them. */
async function factsFor(
	claw: Awaited<ReturnType<typeof harness>>,
	runId: string,
): Promise<Record<string, string | number | boolean>> {
	const resolve = claw.plugin.runFacts;
	if (resolve === undefined) throw new Error("the plugin offers no run facts");
	return resolve({ runId, principal: alice });
}

describe("a subagent says so, and its parent does not", () => {
	it("reports depth for a child and NOTHING for a run that is nobody's child", async () => {
		// ABSENT, not zero. A policy guards on `has "agentDepth"`, and that reads as "is this a
		// subagent at all" — where a defaulted 0 would make every run in the deployment look like one.
		const claw = await harness();
		const parentRunId = await claw.openRun(alice);
		const { childRunId } = await claw.spawnFrom({
			principal: alice,
			alias: "helper",
			prompt: "go",
			parentRunId,
		});

		expect(await factsFor(claw, parentRunId)).toEqual({});
		expect(await factsFor(claw, childRunId)).toMatchObject({
			agentDepth: 1,
			agentRoot: parentRunId,
		});
	});

	it("counts depth down the tree, so a grandchild is not a child", async () => {
		// The whole reason it is a number rather than a flag: "no subagent may spawn past depth 2" and
		// "no subagent may send email" are different rules, and only one of them needs the count.
		const claw = await harness();
		const rootRunId = await claw.openRun(alice);
		const { childRunId } = await claw.spawnFrom({
			principal: alice,
			alias: "helper",
			prompt: "go",
			parentRunId: rootRunId,
		});
		const { childRunId: grandchild } = await claw.spawnFrom({
			principal: alice,
			alias: "assistant",
			prompt: "go",
			parentRunId: childRunId,
		});

		expect(await factsFor(claw, grandchild)).toMatchObject({
			agentDepth: 2,
			// INHERITED, so a rule can be scoped to one delegation rather than to subagents in general —
			// and so the subtree stays one indexed query at any depth.
			agentRoot: rootRunId,
		});
	});

	it("cannot be talked out of it by the run's own context", async () => {
		// THE REASON THIS IS NOT ON THE TASK PAYLOAD. The capability writes `agentParentRunId` into the
		// child's `ctx` as a convenience for gates, and `ctx` is the kind of thing a model or a caller
		// can end up influencing. The FACT comes from the edge instead, so whatever the ctx says, the
		// answer is the same.
		const claw = await harness();
		const parentRunId = await claw.openRun(alice);
		const { childRunId } = await claw.spawnFrom({
			principal: alice,
			alias: "helper",
			prompt: "go",
			parentRunId,
		});

		// Ask for the child's facts under a DIFFERENT principal — the resolver takes a run id and reads
		// rows; it has no channel by which a caller could describe the run to it.
		const facts = await claw.plugin.runFacts?.({
			runId: childRunId,
			principal: userPrincipal("mallory"),
		});
		expect(facts).toMatchObject({ agentDepth: 1 });
	});
});
