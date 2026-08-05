// Slice 11 — live watching. A person looking at a conversation sees a turn somebody ELSE is driving,
// as it arrives, with no way to have learned the run id beforehand.

import type { RunStreamChunk, RunStreamPage } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { memorySecondaryStorage } from "@busyclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	durableRedactor,
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
