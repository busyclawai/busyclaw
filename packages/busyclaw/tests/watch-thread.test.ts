// Slice 11 — live watching. A person looking at a conversation sees a turn somebody ELSE is driving,
// as it arrives, with no way to have learned the run id beforehand.

import type { RunStreamChunk, RunStreamPage } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { memorySecondaryStorage } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	approvalToolModel,
	durableRedactor,
	emailTool,
	floorPermitsWrites,
	streamingModel,
	textModel,
	withPrincipal,
} from "./fixtures";

const OWNER = userPrincipal("actor-1");
const STRANGER = { principal: userPrincipal("stranger") } as const;

/** Drain a watch until it has seen `event`, or until `limit` pages pass without it. Bounded so a
 *  broken stream fails the test rather than hanging the suite. */
async function collectUntil(
	pages: AsyncIterable<RunStreamPage>,
	done: (chunk: RunStreamChunk) => boolean,
	limit = 200,
): Promise<RunStreamChunk[]> {
	const seen: RunStreamChunk[] = [];
	let pageCount = 0;
	for await (const page of pages) {
		seen.push(...page.chunks);
		if (seen.some(done)) return seen;
		if (++pageCount > limit) break;
	}
	return seen;
}

async function watchedClaw(model = streamingModel("the answer")) {
	const { db, redactor } = durableRedactor();
	const claw = createClaw({
		database: db,
		model,
		redaction: { redactor },
		// The only thing a host has to configure: `runStream` is defaulted from it.
		secondaryStorage: memorySecondaryStorage(),
	});
	const api = withPrincipal(claw, OWNER).api;
	const agent = await api.createClaw({ name: "shared" });
	const thread = await api.createThread({ clawId: agent.id });
	return { claw, api, agent, thread };
}

describe("watchThread", () => {
	/**
	 * THE POINT OF THE THREAD KEY. Bob never learns a run id from anywhere — he subscribes to the
	 * CONVERSATION, and `run.started` is the chunk that tells him a turn began. Keyed by run, this
	 * test could not be written: he would have to be told the id out of band first.
	 */
	it("announces a turn to a watcher who was never told the run id", async () => {
		const { api, agent, thread } = await watchedClaw();
		const watching = await api.watchThread({ threadId: thread.id });

		const sent = await api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});

		const chunks = await collectUntil(
			watching,
			(c) => c.kind === "lifecycle" && c.event === "completed",
		);
		const started = chunks.find((c) => c.kind === "run.started");
		expect(started).toMatchObject({ runId: sent.runId, by: OWNER });
		// And the id the watcher learned is the one the sender got back — same turn, two views.
		expect(chunks.every((c) => c.runId === sent.runId)).toBe(true);
	});

	/** Watching is `read` on the thread — the same permission `listMessages` carries. A stranger is
	 *  refused before any chunk is served, not shown an empty stream. */
	it("denies a stranger, and permits the claw's owner", async () => {
		const { claw, thread } = await watchedClaw();
		await expect(
			claw.api.watchThread({ threadId: thread.id }, STRANGER),
		).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED/);
	});

	/**
	 * A LATE JOINER sees the whole answer, not the tail. Deltas go to shared state from the first
	 * one precisely because you cannot know in advance whether somebody will watch.
	 */
	it("serves a watcher who attaches after the turn finished the same text the sender saw", async () => {
		const { api, agent, thread } = await watchedClaw();

		const streamed = await api.sendMessageAndStream({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});
		const deltas: string[] = [];
		for await (const delta of streamed.textStream) deltas.push(delta);
		await streamed.result;

		// Attaching from offset zero AFTER everything landed.
		const late = await api.watchThread({ threadId: thread.id });
		const chunks = await collectUntil(
			late,
			(c) => c.kind === "lifecycle" && c.event === "completed",
		);
		const watched = chunks
			.filter((c) => c.kind === "text")
			.map((c) => (c.kind === "text" ? c.text : ""))
			.join("");
		expect(watched).toBe(deltas.join(""));
		expect(watched).toContain("the answer");
	});

	/** The cursor is the resume point, and it is what `Last-Event-ID` rides on: reconnecting with it
	 *  yields no duplicates and loses nothing. */
	it("resumes from a cursor without a gap or a repeat", async () => {
		const { api, agent, thread } = await watchedClaw();
		await api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "first",
		});

		const first = await api.watchThread({ threadId: thread.id });
		const seen: RunStreamChunk[] = [];
		let cursor: string | undefined;
		for await (const page of first) {
			seen.push(...page.chunks);
			cursor = page.cursor;
			if (seen.some((c) => c.kind === "lifecycle")) break;
		}

		// A SECOND turn while the watcher is away — the cursor has to span the turn boundary, which is
		// the property a run-keyed subscription could not have.
		const second = await api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "second",
		});

		const resumed = await api.watchThread({
			threadId: thread.id,
			since: cursor,
		});
		const after = await collectUntil(
			resumed,
			(c) => c.kind === "lifecycle" && c.runId === second.runId,
		);
		// Nothing from the first turn came back...
		expect(after.every((c) => c.runId === second.runId)).toBe(true);
		// ...and the second turn's start was not missed in the handover.
		expect(after.some((c) => c.kind === "run.started")).toBe(true);
	});

	/**
	 * MULTIPLAYER. Two people mid-turn in one conversation is two runs whose chunks interleave, and a
	 * client separates them by `runId`. This is the case the thread key exists to serve and the one a
	 * shared counter is required for.
	 */
	it("carries two concurrent turns on one subscription, separable by run", async () => {
		const { claw, agent, thread } = await watchedClaw();
		const owner = withPrincipal(claw, OWNER).api;
		await owner.shareResource({
			resourceKind: "claw",
			resourceId: agent.id,
			principalRef: userPrincipal("bob"),
			permission: "use",
		});
		const bob = withPrincipal(claw, userPrincipal("bob")).api;

		const watching = await owner.watchThread({ threadId: thread.id });
		const [a, b] = await Promise.all([
			owner.sendMessage({
				clawId: agent.id,
				threadId: thread.id,
				message: "from alice",
			}),
			bob.sendMessage({
				clawId: agent.id,
				threadId: thread.id,
				message: "from bob",
			}),
		]);

		// Both turns are finished by the time this drains, so wait for BOTH lifecycle chunks rather
		// than for a page count — an empty poll yields nothing, so counting pages would hang.
		const ended = new Set<string>();
		const chunks = await collectUntil(watching, (c) => {
			if (c.kind === "lifecycle") ended.add(c.runId);
			return ended.size === 2;
		});
		const runs = new Set(chunks.map((c) => c.runId));
		expect(runs.has(a.runId)).toBe(true);
		expect(runs.has(b.runId)).toBe(true);
		// Two distinct turns, each announced — not one merged stream.
		expect(chunks.filter((c) => c.kind === "run.started")).toHaveLength(2);
	});

	/**
	 * THE CRON SLICE REACHES THE SAME WATCHER — the reason the sink lives in the worker rather than
	 * at the door.
	 *
	 * A turn that parks for approval ends its first slice there. The SECOND slice is driven by the
	 * drain: another process, minutes later, with no door and no reader attached. A watcher who saw
	 * the first half would simply stop receiving if only the door wrote chunks — the conversation
	 * would appear to hang at "waiting for approval" forever while the answer quietly landed in the
	 * transcript.
	 */
	it("keeps writing when the drain finishes a parked turn, not just when a door drives it", async () => {
		const { db, redactor } = durableRedactor();
		const claw = withPrincipal(
			createClaw({
				database: db,
				model: approvalToolModel(),
				redaction: { redactor },
				secondaryStorage: memorySecondaryStorage(),
				tools: {
					send_email: emailTool({ onExecute: (to) => ({ sent: true, to }) }),
				},
			}),
			OWNER,
		);
		const agent = await claw.api.createClaw({ name: "parks" });
		const thread = await claw.api.createThread({ clawId: agent.id });

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "email alice@personal.com",
		});
		if (!sent.driven)
			throw new Error("expected the door to drive the first slice");
		if (
			sent.result.status !== "waiting_approval" ||
			!sent.result.approvalIds?.[0]
		) {
			throw new Error("expected the turn to park for approval");
		}

		// Everything the DOOR wrote: the turn began and then parked.
		const beforeResume = await collectUntil(
			await claw.api.watchThread({ threadId: thread.id }),
			(c) => c.kind === "lifecycle" && c.event === "parked",
		);
		expect(beforeResume.some((c) => c.kind === "run.started")).toBe(true);
		expect(beforeResume.some((c) => c.kind === "text")).toBe(false);

		// Approve, enqueue the continuation, and let the DRAIN drive it — no door involved.
		await claw.api.grantApproval({ approvalId: sent.result.approvalIds[0] });
		await claw.api.proceedRun({
			runId: sent.runId,
			proceed: { kind: "approval", approvalId: sent.result.approvalIds[0] },
		});
		await claw.$context.engine?.work?.();

		const after = await collectUntil(
			await claw.api.watchThread({ threadId: thread.id }),
			(c) => c.kind === "lifecycle" && c.event === "completed",
		);
		// The drain's slice announced its ending on the SAME run, in the SAME thread log...
		expect(
			after.some(
				(c) =>
					c.kind === "lifecycle" &&
					c.event === "completed" &&
					c.runId === sent.runId,
			),
		).toBe(true);
		// ...and carried the answer, which nothing streamed because nobody was reading.
		expect(
			after.some((c) => c.kind === "text" && c.text.includes("done")),
		).toBe(true);
	});

	/**
	 * THE CASE `watchThread` CANNOT SERVE. A run started through `startRun` has no thread — cron
	 * work, a subagent — so there is no conversation to subscribe to and the run is its own
	 * subscription. Without `watchRun` a scheduled job is unwatchable by construction.
	 */
	it("watches a run that has no thread at all", async () => {
		const { db, redactor } = durableRedactor();
		const claw = withPrincipal(
			createClaw({
				database: db,
				model: textModel("the scheduled answer"),
				redaction: { redactor },
				secondaryStorage: memorySecondaryStorage(),
			}),
			OWNER,
		);
		// No claw, no thread — `startRun` is the door cron work comes through.
		const started = await claw.api.startRun({ prompt: "nightly report" });
		await claw.$context.engine?.work?.();

		const chunks = await collectUntil(
			await claw.api.watchRun({ runId: started.id }),
			(c) => c.kind === "lifecycle" && c.event === "completed",
		);
		expect(chunks.some((c) => c.kind === "run.started")).toBe(true);
		expect(
			chunks.some(
				(c) => c.kind === "text" && c.text.includes("the scheduled answer"),
			),
		).toBe(true);
		expect(chunks.every((c) => c.runId === started.id)).toBe(true);
	});

	/**
	 * A CONVERSATIONAL run writes into its THREAD's log — that is what lets a watcher who knows only
	 * the conversation find it — so watching ONE such run means reading that log and keeping this
	 * run's chunks. Not a privilege boundary (both climb to the same claw); it is what the method's
	 * name promises.
	 */
	it("narrows a thread's log to one run when asked for that run", async () => {
		const { claw, agent, thread } = await watchedClaw();
		const owner = withPrincipal(claw, OWNER).api;
		const first = await owner.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "one",
		});
		const second = await owner.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "two",
		});

		const chunks = await collectUntil(
			await owner.watchRun({ runId: second.runId }),
			(c) => c.kind === "lifecycle" && c.event === "completed",
		);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.every((c) => c.runId === second.runId)).toBe(true);
		expect(chunks.some((c) => c.runId === first.runId)).toBe(false);
	});

	/**
	 * A RUN WATCH ENDS WHEN THE RUN DOES, and a THREAD watch does not. A terminal run will never
	 * produce another chunk, so a subscription that kept polling would hold an HTTP connection open
	 * forever for a turn that finished — which is what the chunk encoding did until an e2e test
	 * hung on `response.text()`. A thread must keep waiting: the next turn is still to come.
	 */
	it("ends a run watch at the terminal chunk, and keeps a thread watch open", async () => {
		const { claw, agent, thread } = await watchedClaw();
		const api = withPrincipal(claw, OWNER).api;
		const sent = await api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});

		// Drains to completion on its own — no break, no timeout.
		const seen: RunStreamChunk[] = [];
		for await (const page of await api.watchRun({ runId: sent.runId })) {
			seen.push(...page.chunks);
		}
		expect(
			seen.some((c) => c.kind === "lifecycle" && c.event === "completed"),
		).toBe(true);

		// The thread's own watch is still live after the same turn ended: bounded here only because
		// the test must stop, which is the point — nothing else stops it.
		const threadPages = await api.watchThread({ threadId: thread.id });
		let pagesSeen = 0;
		for await (const _page of threadPages) {
			if (++pagesSeen >= 1) break;
		}
		expect(pagesSeen).toBe(1);
	});

	it("denies a stranger a run they cannot read", async () => {
		const { claw, agent, thread } = await watchedClaw();
		const sent = await withPrincipal(claw, OWNER).api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});
		await expect(
			claw.api.watchRun({ runId: sent.runId }, STRANGER),
		).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED/);
	});

	/**
	 * A TOOL CALL IS WHERE A TURN GOES QUIET — ten seconds of no text while something runs. Without
	 * these chunks a watcher cannot tell a working turn from a hung one.
	 *
	 * Sourced from the runtime's own event stream rather than from the delta path, which is why
	 * `textStream` stays `AsyncIterable<string>` and the AI SDK response bridges keep working.
	 */
	it("shows which tool a run is on, and what became of it", async () => {
		const { db, redactor } = durableRedactor();
		const claw = withPrincipal(
			createClaw({
				database: db,
				model: approvalToolModel(),
				plugins: [floorPermitsWrites],
				redaction: { redactor },
				secondaryStorage: memorySecondaryStorage(),
				tools: {
					send_email: emailTool({ onExecute: (to) => ({ sent: true, to }) }),
				},
			}),
			OWNER,
		);
		const agent = await claw.api.createClaw({ name: "tools" });
		const thread = await claw.api.createThread({ clawId: agent.id });

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "email alice@personal.com",
		});

		const chunks = await collectUntil(
			await claw.api.watchThread({ threadId: thread.id }),
			(c) => c.kind === "lifecycle" && c.event === "completed",
		);
		const tools = chunks.filter((c) => c.kind === "tool");
		expect(tools.map((c) => (c.kind === "tool" ? c.status : ""))).toEqual([
			"called",
			"completed",
		]);
		expect(tools[0]).toMatchObject({
			toolName: "send_email",
			runId: sent.runId,
		});

		// NO ARGUMENTS AND NO OUTPUT ride along. A watcher needs to know which tool is running, not
		// what it was handed — and tool arguments are the richest source of PII in a run, so the
		// address here must not appear anywhere in the stream.
		const serialized = JSON.stringify(chunks);
		expect(serialized).not.toContain("alice@personal.com");
		expect(serialized).not.toContain("args");
		expect(serialized).not.toContain("output");
	});

	/** No stream configured is a CONFIGURATION answer, not an empty subscription — which would be
	 *  indistinguishable from a conversation where nothing is happening. */
	it("refuses loudly when the deployment has no run stream", async () => {
		const { db, redactor } = durableRedactor();
		const claw = withPrincipal(
			createClaw({
				database: db,
				model: textModel("hi"),
				redaction: { redactor },
			}),
			OWNER,
		);
		const agent = await claw.api.createClaw({ name: "unwatched" });
		const thread = await claw.api.createThread({ clawId: agent.id });

		await expect(claw.api.watchThread({ threadId: thread.id })).rejects.toThrow(
			/no run stream/,
		);
	});

	/** The buffer is ADVISORY: a stream that throws on every write must not be able to fail a turn. */
	it("completes the turn and keeps the transcript when every stream write throws", async () => {
		const { db, redactor } = durableRedactor();
		const claw = withPrincipal(
			createClaw({
				database: db,
				model: textModel("the answer"),
				redaction: { redactor },
				runStream: {
					append: async () => {
						throw new Error("stream is down");
					},
					read: async () => ({ chunks: [], cursor: "0", stale: false }),
				},
			}),
			OWNER,
		);
		const agent = await claw.api.createClaw({ name: "broken-stream" });
		const thread = await claw.api.createThread({ clawId: agent.id });

		const sent = await claw.api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});

		expect(sent.driven).toBe(true);
		if (!sent.driven) throw new Error("unreachable");
		expect(sent.result.status).toBe("completed");
		const messages = await claw.api.listMessages({ threadId: thread.id });
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});
});
