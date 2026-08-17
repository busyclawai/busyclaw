/**
 * SCENARIO — one chat turn, the whole way down.
 *
 * A person sends a message; the agent decides to call a tool; the tool answers; the agent replies.
 * That is the shortest path through the product that touches every layer, and it is the scenario
 * every other one is a variation of — so if this cannot run on a backend, nothing else will.
 *
 * Run against BOTH stores on purpose. The memory adapter is where twenty-one of busyclaw's own test
 * files live and it is not a database; SQLite is what `busyclaw db generate` produces for local
 * development. A scenario that passes on one and not the other is the finding.
 */

import { govern } from "@busyclaw/contracts";
import { jsonSchema, tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { script } from "../src/model";
import { type Backend, type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

const lookup = govern(
	tool({
		description: "Look up the balance.",
		inputSchema: jsonSchema<{ account?: string }>({
			type: "object",
			properties: { account: { type: "string" } },
		}),
		execute: async ({ account }) => ({ account, balance: 42 }),
	}),
	{ access: "read" },
);

const BACKENDS: Backend[] = ["memory", "sqlite"];

describe.each(BACKENDS)("one chat turn — %s", (database) => {
	it("answers, and leaves a run, a tool call and a tool result behind", async () => {
		const w = await world({
			database,
			model: script([
				{ tool: "lookup", args: { account: "current" } },
				{ text: "Your balance is 42." },
			]),
			tools: { lookup },
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w.api.createThread({
			id: "thread-1",
			clawId: "claw-1",
			title: "Chat",
		});

		const sent = await w.api.sendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			message: "what is my balance?",
		});
		expect(sent.runId).toBeDefined();

		// The DURABLE record, not just the return value — a scenario that only checks what the call
		// handed back cannot tell a finished turn from one that merely replied.
		const runs = await w.rows("run");
		expect(runs).toHaveLength(1);

		const calls = await w.rows("tool_call");
		expect(calls.map((c) => c.toolName)).toEqual(["lookup"]);

		const results = await w.rows("tool_result");
		expect(results).toHaveLength(1);
		expect(results[0]?.status).toBe("completed");
	});
});
