import type { EventSink } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { type createClaw, logEvents } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	owned,
	textModel,
} from "./fixtures";

async function createAgentThread(claw: ReturnType<typeof createClaw>) {
	const agent = await claw.api.createClaw({
		id: "claw-1",
		createdBy: "user:actor-1",
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
			redaction: { redactor },
			tools: {
				send_email: emailTool({ onExecute: async () => ({ sent: true }) }),
			},
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-log-events",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		// One line per event, in emission order: the run id rides every line as its first 8 chars.
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe("run.started run=run-log-");
		expect(lines[1]).toMatch(
			/^model\.completed run=run-log- step=0 \d+ms tool-calls tokens=1\/1$/,
		);
		expect(lines[2]).toBe("tool.called run=run-log- step=0 send_email");
		expect(lines[3]).toMatch(
			/^tool\.completed run=run-log- step=0 send_email \d+ms$/,
		);
		expect(lines[4]).toMatch(
			/^model\.completed run=run-log- step=1 \d+ms stop tokens=1\/1$/,
		);
		expect(lines[5]).toBe("run.completed run=run-log- steps=2 tokens=2/2");
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
				emit(event) {
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

		for (const runId of ["run-ledger-1", "run-ledger-2"]) {
			await claw.api.sendMessage({
				clawId: agent.id,
				message: "hello",
				runId,
				threadId: thread.id,
			});
		}

		expect(ledger).toEqual({
			"claw-1": { inputTokens: 2, outputTokens: 2 },
		});
	});
});
