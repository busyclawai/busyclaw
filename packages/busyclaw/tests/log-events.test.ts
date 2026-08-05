import type { Event, EventSink } from "@busyclaw/contracts";
import type { RuntimeEvent } from "@busyclaw/runtime";
import { describe, expect, it } from "vitest";
import { type createClaw, logEvents } from "../src/index";
import {
	approvalToolModel,
	drivenResult,
	durableRedactor,
	emailTool,
	floorPermitsWrites,
	owned,
	textModel,
} from "./fixtures";

/** Typed by the two methods it calls, not by `ReturnType<typeof createClaw>`. That alias is the claw
 *  of the DEFAULT config; a claw built with a concrete one (plugins, events, a real model) is a
 *  different `Claw<…>` and does not fit it. */
async function createAgentThread(claw: {
	api: {
		createClaw: (input: {
			id: string;
			name: string;
		}) => Promise<{ id: string }>;
		createThread: (input: {
			id: string;
			clawId: string;
			title: string;
		}) => Promise<{ id: string }>;
	};
}) {
	const agent = await claw.api.createClaw({
		id: "claw-1",
		name: "Recruiting assistant",
	});
	const thread = await claw.api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Candidate Alice",
	});
	return { agent, thread };
}

describe("logEvents", () => {
	it("prints one line per event over a real 2-step tool run — tool duration and model tokens on their lines", async () => {
		const lines: string[] = [];
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			events: logEvents({ log: (line) => lines.push(line) }),
			model: approvalToolModel(),
			plugins: [floorPermitsWrites],
			redaction: { redactor },
			tools: {
				send_email: emailTool({ onExecute: async () => ({ sent: true }) }),
			},
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			threadId: thread.id,
		});

		expect(drivenResult(sent)).toMatchObject({
			status: "completed",
			text: "done",
		});
		// One line per event, in emission order: the run id rides every line as its first 8 chars.
		// DERIVED from the returned id rather than pinned — a caller cannot choose a run id any more
		// (D1), and asserting a literal here would only prove the mint's prefix.
		const run = sent.runId.slice(0, 8);
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe(`run.started run=${run}`);
		expect(lines[1]).toMatch(
			new RegExp(
				`^model\\.completed run=${run} step=0 \\d+ms tool-calls tokens=1/1$`,
			),
		);
		expect(lines[2]).toBe(`tool.called run=${run} step=0 send_email`);
		expect(lines[3]).toMatch(
			new RegExp(`^tool\\.completed run=${run} step=0 send_email \\d+ms$`),
		);
		expect(lines[4]).toMatch(
			new RegExp(
				`^model\\.completed run=${run} step=1 \\d+ms stop tokens=1/1$`,
			),
		);
		expect(lines[5]).toBe(`run.completed run=${run} steps=2 tokens=2/2`);
	});

	it("tolerates an unknown plugin-emitted event through the configure-context door — prints its type, never throws", async () => {
		const lines: string[] = [];
		let door: EventSink | undefined;
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			events: logEvents({ log: (line) => lines.push(line) }),
			model: textModel("done"),
			plugins: [
				{
					id: "emitter",
					configure(ctx) {
						door = ctx.events;
						return undefined;
					},
				},
			],
			redaction: { redactor },
		});

		expect(claw.api).toBeDefined();
		await door?.emit({ type: "skill.loaded" });

		expect(lines).toEqual(["skill.loaded"]);
	});
});

describe("cost ledger example", () => {
	it("cost accounting is just a sink — run.completed usage accumulates per claw over two runs", async () => {
		const ledger: Record<
			string,
			{ inputTokens: number; outputTokens: number }
		> = {};
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			events: {
				emit(event: RuntimeEvent) {
					if (event.type !== "run.completed") return;
					const clawId = event.recording?.clawId;
					if (clawId === undefined) return;
					const row = ledger[clawId] ?? { inputTokens: 0, outputTokens: 0 };
					ledger[clawId] = row;
					row.inputTokens += event.usage?.inputTokens ?? 0;
					row.outputTokens += event.usage?.outputTokens ?? 0;
				},
			},
			model: textModel("done"),
			redaction: { redactor },
		});
		const { agent, thread } = await createAgentThread(claw);

		// TWO turns, so the ledger is proved to accumulate rather than to have been written once. The
		// run ids used to be pinned here; the server mints them now (D1), and the assertion never
		// needed them — it is about the claw the usage is attributed to.
		for (const _turn of [1, 2]) {
			await claw.api.sendMessage({
				clawId: agent.id,
				message: "hello",
				threadId: thread.id,
			});
		}

		expect(ledger).toEqual({
			"claw-1": { inputTokens: 2, outputTokens: 2 },
		});
	});
});
