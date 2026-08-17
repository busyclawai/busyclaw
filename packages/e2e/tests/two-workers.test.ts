/**
 * SCENARIO — two hosts, one queue, and work that must happen exactly once.
 *
 * A deployment with more than one instance is the normal case, not the exotic one, and it is the
 * case none of the product-level tests exercise: `sendMessage` drives its run inline on the calling
 * process, so every scenario built on it has the concurrency turned off by construction.
 *
 * `startRun` is the door that enqueues instead, which is what lets several runs sit in the queue at
 * once and lets two workers race for them. That race is the whole point: the lease, the claim CAS
 * and the reaper only mean anything when something else is trying to take the work, and the fix that
 * made `heartbeatLease` check whether it still holds its task is only observable here.
 *
 * The assertion is a count, deliberately. "It worked" is easy to satisfy while a task has been
 * executed twice — the run still completes, the transcript still reads correctly, and the only
 * evidence is a side effect that happened once too often. Counting the side effect is the only
 * thing that catches it.
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

/** Enough runs that a two-worker batch has to interleave, few enough to stay fast. */
const RUNS = 6;

describe("two workers, one queue — sqlite", () => {
	it("executes each run's side effect exactly once", async () => {
		const charged: string[] = [];
		const charge = govern(
			tool({
				description: "Charge the account.",
				inputSchema: jsonSchema<{ ref?: string }>({
					type: "object",
					properties: { ref: { type: "string" } },
				}),
				execute: async ({ ref }) => {
					charged.push(String(ref));
					return { charged: true };
				},
			}),
			{ access: "read" },
		);

		const w = await world({
			database: "sqlite",
			workers: 2,
			// Stateless by necessity: six runs share this one model instance and interleave across two
			// workers, so a step counter in a closure would hand run B run A's next move.
			model: reactive([{ tool: "charge" }, { text: "done" }]),
			tools: { charge },
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });

		// ENQUEUED, NOT DRIVEN. `startRun` hands back a handle and leaves the work in the queue, which
		// is the only way to get several runs pending at the same instant.
		const started = await Promise.all(
			Array.from({ length: RUNS }, (_, i) =>
				w.api.startRun({
					clawId: "claw-1",
					prompt: `charge job ${i}`,
				}),
			),
		);
		expect(started).toHaveLength(RUNS);

		await w.settle();

		// EXACTLY ONCE PER RUN. Not "at least once" — a lease that lies, or a heartbeat that confirms
		// after its task was requeued, shows up here as a seventh charge and nowhere else.
		//
		// The side effect itself is the evidence, not the `effect` ledger: a read-access tool writes
		// no ledger row, and giving this one `access: "write"` to get one would park it on the floor
		// and turn a concurrency scenario into an approval scenario.
		expect(charged).toHaveLength(RUNS);
		expect(new Set(charged).size).toBe(1); // every run charged the same (absent) ref exactly once

		const runs = await w.rows("run");
		expect(runs).toHaveLength(RUNS);
		expect(runs.every((run) => run.status === "completed")).toBe(true);
	});

	it("leaves no task claimed once the queue has settled", async () => {
		// The other half of "exactly once": work must not be left held. A task still `leased` after a
		// settle is one whose worker died holding it — invisible until the lease expires and a reaper
		// notices, which in a scenario is never.
		const w = await world({
			database: "sqlite",
			workers: 2,
			model: reactive([{ text: "ok" }]),
		});
		open = w;

		await w.api.createClaw({ id: "claw-1", name: "Assistant" });
		await Promise.all(
			Array.from({ length: RUNS }, (_, i) =>
				w.api.startRun({ clawId: "claw-1", prompt: `job ${i}` }),
			),
		);
		await w.settle();

		const tasks = await w.rows("runtime_task");
		expect(tasks.filter((task) => task.status === "leased")).toEqual([]);
		expect(tasks.filter((task) => task.status === "pending")).toEqual([]);
	});
});
