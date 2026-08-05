// REAL end-to-end for live watching: an assembled claw behind `toRequestHandler`, the SSE route it
// mounts, and `client.watchThread` reading the frames back — with zero network, but every byte of
// the wire in between (event framing, `id:` cursors, `Last-Event-ID` on reconnect).
//
// The point of testing it here rather than in busyclaw: the in-process `watchThread` is already
// covered there. What is unproven until this file runs is that the ADAPTER frames it correctly and
// the CLIENT parses back exactly what the server yielded.

import type { RunStreamChunk } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { memoryAdapter, memorySecondaryStorage } from "@busyclaw/storage-core";
import type { Claw } from "busyclaw";
import { createClaw } from "busyclaw";
import { createClawClient } from "busyclaw/client";
import { describe, expect, it } from "vitest";
import { toRequestHandler } from "../src/index";

const ALICE = userPrincipal("alice");

/** A model that really streams, so the deltas the watcher sees were genuinely produced piecewise. */
const streamingModel = {
	specificationVersion: "v4",
	provider: "mock",
	modelId: "mock",
	supportedUrls: {},
	doGenerate: async () => ({
		content: [{ type: "text", text: "one two three" }],
		finishReason: { unified: "stop", raw: undefined },
		usage: {
			inputTokens: {
				total: 1,
				noCache: undefined,
				cacheRead: undefined,
				cacheWrite: undefined,
			},
			outputTokens: { total: 1, text: undefined, reasoning: undefined },
		},
		warnings: [],
	}),
	doStream: async () => ({
		stream: new ReadableStream({
			start(controller) {
				controller.enqueue({ type: "text-start", id: "0" });
				for (const [index, word] of ["one", "two", "three"].entries()) {
					controller.enqueue({
						type: "text-delta",
						id: "0",
						delta: index === 0 ? word : ` ${word}`,
					});
				}
				controller.enqueue({ type: "text-end", id: "0" });
				controller.enqueue({
					type: "finish",
					finishReason: { unified: "stop", raw: undefined },
					usage: {
						inputTokens: {
							total: 1,
							noCache: undefined,
							cacheRead: undefined,
							cacheWrite: undefined,
						},
						outputTokens: { total: 1, text: undefined, reasoning: undefined },
					},
				});
				controller.close();
			},
		}),
		warnings: [],
	}),
};

function buildClawAndClient() {
	const claw = createClaw({
		database: memoryAdapter(),
		model: streamingModel as never,
		redaction: { posture: "raw" },
		secondaryStorage: memorySecondaryStorage(),
		// A TRANSPORT test — the SSE framing and the cursor round trip. Authorization has its own
		// case below, which builds a second claw with the PEP actually enforcing.
		appAuthz: { unsafeOpen: true },
	});
	const handler = toRequestHandler(claw as unknown as Claw, {
		resolveCaller: () => ({ principal: ALICE }),
	});
	const client = createClawClient<typeof claw>({
		baseUrl: "https://app.test/api/busyclaw",
		fetch: (input, init) => handler(new Request(input, init)),
	});
	return { claw, client };
}

/** A claw, a client, and a conversation to watch — all three, because typing a standalone seeding
 *  helper against a CONCRETE `Claw<…>` means restating its api, and restating it is what drifts. */
async function watchable() {
	const { claw, client } = buildClawAndClient();
	const agent = await claw.api.createClaw(
		{ name: "watched" },
		{ principal: ALICE },
	);
	const thread = await claw.api.createThread(
		{ clawId: agent.id },
		{ principal: ALICE },
	);
	return { claw, client, agent, thread };
}

describe("end-to-end: watchThread over SSE", () => {
	it("frames the server's pages and parses them back unchanged", async () => {
		const { claw, client, agent, thread } = await watchable();

		// A finished turn, so the log is already populated when the watcher attaches.
		const sent = await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "hello" },
			{ principal: ALICE },
		);

		const seen: RunStreamChunk[] = [];
		let lastCursor = "";
		for await (const page of client.watchThread(thread.id)) {
			seen.push(...page.chunks);
			lastCursor = page.cursor;
			if (seen.some((c) => c.kind === "lifecycle" && c.event === "completed")) {
				break;
			}
		}

		// The turn was announced, and every chunk belongs to the run the sender was told about — so a
		// second person watching this conversation learns the run id from the wire alone.
		expect(seen.some((c) => c.kind === "run.started")).toBe(true);
		expect(seen.every((c) => c.runId === sent.runId)).toBe(true);
		// The cursor survived the round trip as an `id:` line, which is what reconnect rides on.
		expect(lastCursor).not.toBe("");
	});

	/**
	 * THE RECONNECT PROPERTY, exercised for real: a second watch handed the first one's cursor gets
	 * nothing it has already seen. This is what `Last-Event-ID` buys, and it only works because the
	 * cursor is the core's, not the transport's — the client sends back exactly the string the server
	 * put in `id:`.
	 */
	it("resumes from a cursor without repeating what was already delivered", async () => {
		const { claw, client, agent, thread } = await watchable();
		await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "first" },
			{ principal: ALICE },
		);

		const first: RunStreamChunk[] = [];
		let cursor = "";
		for await (const page of client.watchThread(thread.id)) {
			first.push(...page.chunks);
			cursor = page.cursor;
			if (first.some((c) => c.kind === "lifecycle")) break;
		}
		expect(first.length).toBeGreaterThan(0);

		const second = await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "second" },
			{ principal: ALICE },
		);

		const resumed: RunStreamChunk[] = [];
		for await (const page of client.watchThread(thread.id, { since: cursor })) {
			resumed.push(...page.chunks);
			if (resumed.some((c) => c.kind === "lifecycle")) break;
		}
		// Only the SECOND turn came back — one cursor spanning a turn boundary, which a run-keyed
		// subscription could not do.
		expect(resumed.length).toBeGreaterThan(0);
		expect(resumed.every((c) => c.runId === second.runId)).toBe(true);
	});

	/**
	 * A DENIAL IS AN HTTP STATUS, not a 200 whose first event says "sorry".
	 *
	 * The route awaits `watchThread` before it starts framing precisely so the refusal still has a
	 * status line to be written into. A client that reconnected on a 403 would retry forever against
	 * a decision that has already been made, so it must surface instead.
	 */
	it("refuses a caller who cannot read the thread, and does not retry", async () => {
		const { thread } = await watchable();

		// A second mount whose seam resolves a stranger, with the PEP actually enforcing.
		const enforced = createClaw({
			database: memoryAdapter(),
			model: streamingModel as never,
			redaction: { posture: "raw" },
			secondaryStorage: memorySecondaryStorage(),
		});
		const handler = toRequestHandler(enforced as unknown as Claw, {
			resolveCaller: () => ({ principal: userPrincipal("stranger") }),
		});
		const strangerClient = createClawClient<typeof enforced>({
			baseUrl: "https://app.test/api/busyclaw",
			fetch: (input, init) => handler(new Request(input, init)),
		});

		await expect(
			(async () => {
				for await (const _page of strangerClient.watchThread(thread.id)) {
					break;
				}
			})(),
		).rejects.toThrow(/status 40\d/);
	});
});
