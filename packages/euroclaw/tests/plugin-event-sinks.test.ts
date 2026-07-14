import type { EventSink } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
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

describe("plugin.eventSinks", () => {
	it("a plugin sink receives runtime lifecycle events and another plugin's door-emitted events", async () => {
		const seen: string[] = [];
		let doorEmit: Promise<void> | undefined;
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			plugins: [
				{
					id: "listener",
					eventSinks: [
						{
							emit(event) {
								seen.push(event.type);
							},
						},
					],
				},
				{
					id: "emitter",
					configure(ctx) {
						doorEmit = Promise.resolve(
							ctx.events?.emit({ type: "emitter.ready" }),
						);
						return undefined;
					},
				},
			],
			redaction: { redactor },
		});
		const { agent, thread } = await createAgentThread(claw);
		await doorEmit;

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			runId: "run-plugin-sink",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		// Another plugin's configure-time door emit reached the sink…
		expect(seen).toContain("emitter.ready");
		// …and so did the runtime's own lifecycle events.
		expect(seen).toContain("run.started");
		expect(seen).toContain("run.completed");
	});

	it("a throwing plugin sink never breaks the run — warned, run completes, transcript persists", async () => {
		const warnings: string[] = [];
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			plugins: [
				{
					id: "broken-telemetry",
					eventSinks: [
						{
							emit() {
								throw new Error("plugin sink exploded");
							},
						},
					],
				},
			],
			redaction: { redactor },
			warn: (message) => warnings.push(message),
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			runId: "run-broken-sink",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		// The recording sink still persisted the transcript — only the plugin observer failed.
		const messages = await claw.api.listMessages({ threadId: thread.id });
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(
			warnings.some(
				(message) =>
					message.includes("observer event sink failed") &&
					message.includes("plugin sink exploded"),
			),
		).toBe(true);
	});

	it("a sink collected pre-configure reads the state its own configure assigns by the time events fire", async () => {
		let mode = "unconfigured";
		const seen: string[] = [];
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: textModel("done"),
			plugins: [
				{
					id: "closure",
					eventSinks: [
						{
							emit(event) {
								seen.push(`${mode}:${event.type}`);
							},
						},
					],
					configure() {
						mode = "configured";
						return undefined;
					},
				},
			],
			redaction: { redactor },
		});
		const { agent, thread } = await createAgentThread(claw);

		await claw.api.sendMessage({
			clawId: agent.id,
			message: "hello",
			runId: "run-closure",
			threadId: thread.id,
		});

		expect(seen).toContain("configured:run.started");
		expect(seen.every((entry) => entry.startsWith("configured:"))).toBe(true);
	});

	it("one merged observer list feeds both pipelines — a single plugin sink sees a runtime event and a mid-run door event", async () => {
		const seen: string[] = [];
		let door: EventSink | undefined;
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			model: approvalToolModel(),
			plugins: [
				{
					id: "notifier",
					eventSinks: [
						{
							emit(event) {
								seen.push(event.type);
							},
						},
					],
					configure(ctx) {
						door = ctx.events;
						return undefined;
					},
				},
			],
			redaction: { redactor },
			tools: {
				send_email: emailTool({
					onExecute: async () => {
						// The plugin's captured door, used mid-run (a tool, not a sink, emits).
						await door?.emit({ type: "notifier.pinged" });
						return { sent: true };
					},
				}),
			},
		});
		const { agent, thread } = await createAgentThread(claw);

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			message: "email alice@personal.com",
			runId: "run-both-pipelines",
			threadId: thread.id,
		});

		expect(sent.result).toMatchObject({ status: "completed", text: "done" });
		// Both pipelines reached the SAME sink instance within one run: the runtime's own emit path…
		expect(seen).toContain("run.started");
		expect(seen).toContain("tool.called");
		expect(seen).toContain("run.completed");
		// …and the plugin emit door, interleaved exactly where the tool fired it.
		const pinged = seen.indexOf("notifier.pinged");
		expect(pinged).toBeGreaterThan(seen.indexOf("tool.called"));
		expect(pinged).toBeLessThan(seen.indexOf("tool.completed"));
	});
});
