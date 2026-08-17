/**
 * SCENARIO — the agent wants to do something consequential, and a human decides.
 *
 * This is the product's whole reason to exist, and it is the journey with the most seams in it: the
 * floor classes the call as a write, the run parks rather than acting, an approval row outlives the
 * turn, a person grants it, the engine resumes the ORIGINAL run, and the tool finally executes.
 *
 * Each of those is covered somewhere. The composition is not, and the composition is where the
 * expensive failures live — a resume that forks a second run, a grant that executes the tool twice,
 * a park that never resumes at all.
 *
 * The assertion that matters most is the LAST one: exactly one send. Everything else can look right
 * while the effect ledger has admitted a second charge.
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

const BACKENDS: Backend[] = ["memory", "sqlite"];

describe.each(BACKENDS)("approval journey — %s", (database) => {
	it("parks the write, resumes the SAME run on a grant, and sends exactly once", async () => {
		const sent: string[] = [];
		const send = govern(
			tool({
				description: "Send an email.",
				inputSchema: jsonSchema<{ to: string }>({
					type: "object",
					properties: { to: { type: "string" } },
					required: ["to"],
				}),
				execute: async ({ to }) => {
					sent.push(to);
					return { sent: true };
				},
			}),
			// A REAL write, declared as one. Relabelling it a read to avoid the gate would hide the
			// same hole one layer up, where the next reader cannot see it.
			{ access: "write" },
		);

		const w = await world({
			database,
			model: script([
				{ tool: "send", args: { to: "ops@example.com" } },
				{ text: "Sent." },
			]),
			tools: { send },
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w.api.createThread({
			id: "thread-1",
			clawId: "claw-1",
			title: "Chat",
		});

		const turn = await w.api.sendMessage({
			clawId: "claw-1",
			threadId: "thread-1",
			message: "email ops and tell them we shipped",
		});

		// NOTHING HAPPENED YET, and that is the point of the floor. A park that lets the side effect
		// through first is not a park.
		expect(sent).toEqual([]);

		const pending = await w.api.listApprovals({ status: "pending" });
		expect(pending).toHaveLength(1);
		const approvalId = pending[0]?.id;
		if (approvalId === undefined)
			throw new Error("expected a pending approval");

		// TWO STEPS, because they are two decisions. `grantApproval` records what the human decided;
		// `continueRun` is what puts the run back on the engine. A deployment with cron running would
		// have the second happen on its own — driving it here is what keeps the scenario synchronous
		// and its interleaving repeatable.
		await w.api.grantApproval({ approvalId });
		await w.api.continueRun({ approvalId });
		await w.settle();

		// THE SAME RUN, not a second one. A resume that forks its own run leaves the original parked
		// forever and hands the answer to a thread nobody is watching.
		const runs = await w.rows("run");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe(turn.runId);

		// EXACTLY ONCE. The effect ledger exists so that a replayed or re-claimed slice cannot charge
		// twice; this is the journey that would spend it.
		expect(sent).toEqual(["ops@example.com"]);

		const effects = await w.rows("effect");
		expect(effects).toHaveLength(1);
	});
});
