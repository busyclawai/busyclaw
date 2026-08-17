/**
 * SCENARIO — the provider dies mid-turn, and the run picks up where it stopped.
 *
 * THE ASSERTION IS THE TOOL-CALL COUNT, and everything else in this file is scaffolding around it.
 *
 * A run that fails after its first step has two possible futures. It can RESUME from the checkpoint
 * written at the failure, reaching the model with the tool result already in its transcript — one
 * tool call, total. Or it can be re-driven FROM ITS PROMPT, in which case the model starts over,
 * asks for the same tool again, and the side effect happens twice. Both futures end with the run
 * `completed` and a transcript that reads correctly; the only difference visible from outside is how
 * many times the tool ran.
 *
 * That is why this scenario is worth more than the unit tests underneath it. `failure-checkpoint`
 * proves a checkpoint gets written; `effect-replay` proves an effect id survives a replay. Neither
 * proves that a real crash, on a real queue, with a real retry backoff, ends with the work done
 * once — which is the property anybody actually cares about.
 */

import { govern } from "@busyclaw/contracts";
import { jsonSchema, tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { reactive } from "../src/model";
import { type World, world } from "../src/world";

let open: World | undefined;
afterEach(() => {
	open?.close();
	open = undefined;
});

describe("crash and resume — sqlite", () => {
	it("runs the tool ONCE when the model dies after it", async () => {
		const calls: string[] = [];
		const quote = govern(
			tool({
				description: "Fetch a metered price quote.",
				inputSchema: jsonSchema<Record<string, never>>({
					type: "object",
					properties: {},
				}),
				execute: async () => {
					calls.push("quote");
					return { price: 42 };
				},
			}),
			// ACCESS AND EFFECT ARE DIFFERENT AXES, and this tool is why the distinction earns its
			// keep. Fetching a quote READS — it changes nothing, so the floor has no reason to hold
			// it — but the upstream is metered and rate-limited, so it must not be called twice for
			// one turn. `idempotency: "required"` is that second statement, and it is what puts the
			// call in the effect ledger where a retry finds the completed record instead of acting
			// again. A tool declaring neither gets neither, by design.
			//
			// Deliberately not a write: `startRun` is AUTONOMOUS, and the floor's sealed forbid on an
			// unconfirmed autonomous write outranks any customer permit slice.
			// A queued write parks for a human, which is a different scenario than this one.
			{
				access: "read",
				effect: { kind: "external", idempotency: "required", output: "full" },
			},
		);

		const w = await world({
			database: "sqlite",
			// Step 0 calls the tool. Step 1 is the crash — once. Step 2 is what a RESUMED run reaches,
			// and what a replayed-from-prompt run never gets to, because it would be back at step 0.
			model: reactive([
				{ tool: "quote" },
				{ throw: "provider connection reset" },
				{ text: "It costs 42." },
			]),
			tools: { quote },
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w.api.startRun({ clawId: "claw-1", prompt: "what does it cost?" });

		// Waits out the retry backoff — a failed task is rescheduled a second into the future, and a
		// settle that only spun would assert against the state before the recovery.
		await w.settle();

		// THE ONE THAT MATTERS. Two calls here means the run was re-driven from its prompt and the
		// upstream was billed twice for one turn.
		expect(calls).toEqual(["quote"]);

		const runs = await w.rows("run");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("completed");
	});

	it("resumes from the CHECKPOINT, with no ledger involved", async () => {
		// THE SHARPER VERSION of the case above, and the one that says which mechanism is working.
		//
		// The tool here declares NO effect policy, so it gets no ledger entry and no dedup — any
		// second execution is a real one, visible. If the retry re-drove the run from its prompt the
		// model would start over, ask for the tool again, and this would be 2.
		//
		// The model turn count is the other half: 3 is the minimum a resumed run can spend (call the
		// tool, crash, come back and answer). A replay would spend more, having re-walked the steps it
		// already paid for. So this pins BOTH halves of the claim in `ai-sdk-loop` — that a failed call
		// is a resumable point, and that the ledger is the second line of defence rather than the first.
		const executed: string[] = [];
		let modelTurns = 0;
		const w0 = await world({
			database: "sqlite",
			// Counted through the model's OWN seam. Wrapping `doGenerate` from outside does not
			// typecheck — `RuntimeModel` is a union of provider spec versions with no single call
			// signature — and reaching for a cast to get past that would be inventing a problem.
			model: reactive(
				[
					{ tool: "peek" },
					{ throw: "provider connection reset" },
					{ text: "done" },
				],
				{ onTurn: () => void (modelTurns += 1) },
			),
			tools: {
				peek: govern(
					tool({
						description: "Peek at something cheap.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						execute: async () => {
							executed.push("peek");
							return { ok: true };
						},
					}),
					{ access: "read" },
				),
			},
		});
		open = w0;

		await w0.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w0.api.startRun({ clawId: "claw-1", prompt: "go" });
		await w0.settle();

		expect(executed).toEqual(["peek"]);
		expect(modelTurns).toBe(3);

		const consumed = await w0.rows("run_checkpoint");
		expect(consumed).toHaveLength(1);
		expect(consumed[0]?.status).toBe("consumed");
	});

	it("leaves a checkpoint at the failure rather than starting the run over", async () => {
		// The mechanism behind the count above, asserted directly so a regression says WHICH half
		// broke: no checkpoint at all means the recovery is riding on the effect ledger alone, which
		// stops the double charge but still pays for every step twice.
		const w = await world({
			database: "sqlite",
			model: reactive([
				{ tool: "noop" },
				{ throw: "provider connection reset" },
				{ text: "done" },
			]),
			tools: {
				noop: govern(
					tool({
						description: "Do nothing.",
						inputSchema: jsonSchema<Record<string, never>>({
							type: "object",
							properties: {},
						}),
						execute: async () => ({ ok: true }),
					}),
					{ access: "read" },
				),
			},
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w.api.startRun({ clawId: "claw-1", prompt: "go" });
		await w.settle();

		const checkpoints = await w.rows("run_checkpoint");
		expect(checkpoints.length).toBeGreaterThan(0);
	});

	it("spends the error budget and dead-letters when the provider never recovers", async () => {
		// The other side of the same machinery: retries are BOUNDED. A model that always fails must
		// end in a failed run, not an infinite requeue — and the scenario has to prove the loop stops
		// on its own rather than because the test gave up waiting.
		const w = await world({
			database: "sqlite",
			model: reactive([{ throw: "provider is down", times: 99 }]),
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await w.api.startRun({ clawId: "claw-1", prompt: "go" });
		await w.settle(30);

		const tasks = await w.rows("runtime_task");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.status).toBe("dead");

		const runs = await w.rows("run");
		expect(runs[0]?.status).toBe("failed");
	});
});
