import type {
	EventSink,
	PiiMapping,
	PiiMappingStore,
} from "@euroclaw/contracts";
import {
	createMemoryPiiMappingStore,
	createStoredRedactor,
} from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailDetector,
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

describe("plugin.eventSinks", () => {
	it("a plugin sink receives runtime lifecycle events and another plugin's door-emitted events", async () => {
		const seen: string[] = [];
		let doorEmit: Promise<void> | undefined;
		const { db, redactor } = durableRedactor();
		const claw = owned({
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
		const claw = owned({
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
		const claw = owned({
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
		const claw = owned({
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

describe("door redaction", () => {
	const TOKEN = /\{\{pii:email:[a-z0-9-]+\}\}/;

	function observed() {
		const received: Record<string, unknown>[] = [];
		const sink: EventSink = {
			emit(event) {
				received.push(event);
			},
		};
		return { received, sink };
	}

	/** A memory mapping store with `save` spied, so tests can assert WHICH container a door
	 *  redaction minted into. `durable` is claimable for the database-backed boot guard. */
	function spiedMappings(options: { durable?: boolean } = {}) {
		const saved: PiiMapping[] = [];
		const base = createMemoryPiiMappingStore();
		const mappings: PiiMappingStore = {
			...base,
			...(options.durable === true ? { durable: true } : {}),
			save(mapping, subjectIds) {
				saved.push(mapping);
				return base.save(mapping, subjectIds);
			},
		};
		return { mappings, saved };
	}

	it("strict: a plugin-emitted payload is tokenized before ANY observer sees it", async () => {
		const host = observed();
		const pluginSeen: Record<string, unknown>[] = [];
		let doorEmit: Promise<void> | undefined;
		createClaw({
			database: memoryAdapter(),
			model: textModel("done"),
			events: host.sink,
			plugins: [
				{
					id: "listener",
					eventSinks: [
						{
							emit(event) {
								pluginSeen.push(event);
							},
						},
					],
				},
				{
					id: "notifier",
					configure(ctx) {
						doorEmit = Promise.resolve(
							ctx.events?.emit({
								type: "notifier.pinged",
								note: "reach alice@personal.com",
							}),
						);
						return undefined;
					},
				},
			],
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		await doorEmit;

		const everything = [...host.received, ...pluginSeen];
		expect(everything).toHaveLength(2);
		for (const event of everything) {
			expect(event["type"]).toBe("notifier.pinged");
			expect(event["note"]).toMatch(TOKEN);
		}
		expect(JSON.stringify(everything)).not.toContain("alice@personal.com");
	});

	it("envelope integrity: type/id/createdAt/runId/recording arrive verbatim while the payload tokenizes", async () => {
		const host = observed();
		let doorEmit: Promise<void> | undefined;
		const recording = {
			clawId: "claw-1",
			threadId: "thread-1",
			runId: "run-door",
		};
		createClaw({
			database: memoryAdapter(),
			model: textModel("done"),
			events: host.sink,
			plugins: [
				{
					id: "notifier",
					configure(ctx) {
						doorEmit = Promise.resolve(
							ctx.events?.emit({
								type: "notifier.pinged",
								id: "evt-1",
								createdAt: "2026-07-14T00:00:00.000Z",
								runId: "run-door",
								recording,
								note: "reach alice@personal.com",
							}),
						);
						return undefined;
					},
				},
			],
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		await doorEmit;

		expect(host.received).toHaveLength(1);
		expect(host.received[0]).toMatchObject({
			type: "notifier.pinged",
			id: "evt-1",
			createdAt: "2026-07-14T00:00:00.000Z",
			runId: "run-door",
			recording,
		});
		expect(host.received[0]?.["note"]).toMatch(TOKEN);
	});

	it('posture "raw" and the no-redaction recipe pass door events through byte-identical', async () => {
		const sent = {
			type: "notifier.pinged",
			note: "reach alice@personal.com",
			nested: { emails: ["alice@personal.com"] },
		};

		const raw = observed();
		let rawEmit: Promise<void> | undefined;
		createClaw({
			database: memoryAdapter(),
			model: textModel("done"),
			events: raw.sink,
			plugins: [
				{
					id: "notifier",
					configure(ctx) {
						rawEmit = Promise.resolve(ctx.events?.emit(sent));
						return undefined;
					},
				},
			],
			redaction: { posture: "raw" },
			warn: () => {}, // the expected raw-posture boot warning is not this test's subject
		});
		await rawEmit;
		// The SAME object reference: the door never even walked the payload.
		expect(raw.received[0]).toBe(sent);

		const none = observed();
		let noneEmit: Promise<void> | undefined;
		createClaw({
			model: textModel("done"),
			events: none.sink,
			plugins: [
				{
					id: "notifier",
					configure(ctx) {
						noneEmit = Promise.resolve(ctx.events?.emit(sent));
						return undefined;
					},
				},
			],
		});
		await noneEmit;
		expect(none.received[0]).toBe(sent);
	});

	it("per-claw with recording: the claw's birth posture decides — strict claw tokenized, raw claw passes", async () => {
		const host = observed();
		let door: EventSink | undefined;
		const claw = owned({
			database: memoryAdapter(),
			model: textModel("done"),
			events: host.sink,
			plugins: [
				{
					id: "notifier",
					configure(ctx) {
						door = ctx.events;
						return undefined;
					},
				},
			],
			redaction: {
				posture: "per-claw",
				detectors: [emailDetector],
				indexKey: "test-key",
			},
		});
		await claw.api.createClaw({
			id: "strict-claw",
			createdBy: "user:actor-1",
			name: "strict",
			redaction: "strict",
		});
		await claw.api.createClaw({
			id: "raw-claw",
			createdBy: "user:actor-1",
			name: "raw",
			redaction: "raw",
		});

		await door?.emit({
			type: "notifier.pinged",
			recording: { clawId: "strict-claw", threadId: "thread-1" },
			note: "reach alice@personal.com",
		});
		await door?.emit({
			type: "notifier.pinged",
			recording: { clawId: "raw-claw", threadId: "thread-1" },
			note: "reach alice@personal.com",
		});

		expect(host.received).toHaveLength(2);
		expect(host.received[0]?.["note"]).toMatch(TOKEN);
		expect(host.received[1]?.["note"]).toBe("reach alice@personal.com");
	});

	it("claw-less strict emit redacts into the emitting plugin's own container", async () => {
		const { mappings, saved } = spiedMappings();
		const host = observed();
		let doorEmit: Promise<void> | undefined;
		createClaw({
			model: textModel("done"),
			events: host.sink,
			plugins: [
				{
					id: "notifier",
					configure(ctx) {
						doorEmit = Promise.resolve(
							ctx.events?.emit({
								type: "notifier.pinged",
								note: "reach alice@personal.com",
							}),
						);
						return undefined;
					},
				},
			],
			redaction: {
				redactor: createStoredRedactor({
					detector: emailDetector,
					indexKey: "test-key",
					mappings,
				}),
			},
		});
		await doorEmit;

		expect(host.received[0]?.["note"]).toMatch(TOKEN);
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			kind: "email",
			original: "alice@personal.com",
			scope: "plugin",
			scopeId: "notifier",
		});
	});

	it("per-claw claw-less emit FAILS CLOSED: redacted, into the per-plugin container", async () => {
		const { mappings, saved } = spiedMappings({ durable: true });
		const host = observed();
		let doorEmit: Promise<void> | undefined;
		createClaw({
			database: memoryAdapter(),
			model: textModel("done"),
			events: host.sink,
			plugins: [
				{
					id: "notifier",
					configure(ctx) {
						doorEmit = Promise.resolve(
							ctx.events?.emit({
								type: "notifier.pinged",
								note: "reach alice@personal.com",
							}),
						);
						return undefined;
					},
				},
			],
			redaction: {
				posture: "per-claw",
				redactor: createStoredRedactor({
					detector: emailDetector,
					indexKey: "test-key",
					mappings,
				}),
			},
		});
		await doorEmit;

		expect(host.received[0]?.["note"]).toMatch(TOKEN);
		expect(saved[0]).toMatchObject({ scope: "plugin", scopeId: "notifier" });
	});

	// core/redact.ts findByHash filters by the (scope, scopeId) container, so lookup-or-mint is
	// container-LOCAL: the same value shares one token within a container and mints a fresh one
	// across containers. Both directions asserted here against the real transcript write.
	it("token coherence: a claw-attributed door token equals the transcript token; the plugin container mints its own", async () => {
		const host = observed();
		let door: EventSink | undefined;
		const claw = owned({
			database: memoryAdapter(),
			model: textModel("noted"),
			events: host.sink,
			plugins: [
				{
					id: "notifier",
					configure(ctx) {
						door = ctx.events;
						return undefined;
					},
				},
			],
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		const agent = await claw.api.createClaw({
			id: "claw-1",
			createdBy: "user:actor-1",
			name: "assistant",
		});
		const thread = await claw.api.createThread({
			id: "thread-1",
			clawId: agent.id,
			title: "t",
		});
		await claw.api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "reach alice@personal.com",
		});
		const stored = await claw.api.listMessages({ threadId: thread.id });
		const transcriptToken = JSON.stringify(stored).match(TOKEN)?.[0];
		expect(transcriptToken).toBeDefined();

		await door?.emit({
			type: "notifier.pinged",
			recording: { clawId: agent.id, threadId: thread.id },
			note: "reach alice@personal.com",
		});
		await door?.emit({
			type: "notifier.pinged",
			note: "reach alice@personal.com",
		});

		const doorEvents = host.received.filter(
			(event) => event["type"] === "notifier.pinged",
		);
		expect(doorEvents).toHaveLength(2);
		// Same container as the transcript write → the SAME token…
		expect(doorEvents[0]?.["note"]).toBe(`reach ${transcriptToken}`);
		// …the plugin's own container → a DIFFERENT token for the same value.
		expect(doorEvents[1]?.["note"]).toMatch(TOKEN);
		expect(doorEvents[1]?.["note"]).not.toBe(`reach ${transcriptToken}`);
	});
});
