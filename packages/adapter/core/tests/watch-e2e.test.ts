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
	// The handler rides along for the cases that need the raw HTTP response rather than the client's
	// parsed view — built here, where the claw's concrete type is already in hand.
	return { claw, client, handler };
}

/** A claw, a client, and a conversation to watch — all three, because typing a standalone seeding
 *  helper against a CONCRETE `Claw<…>` means restating its api, and restating it is what drifts. */
async function watchable() {
	const { claw, client, handler } = buildClawAndClient();
	const agent = await claw.api.createClaw(
		{ name: "watched" },
		{ principal: ALICE },
	);
	const thread = await claw.api.createThread(
		{ clawId: agent.id },
		{ principal: ALICE },
	);
	return { claw, client, handler, agent, thread };
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
	 * `GET /runs/:runId/watch` — the same framing on the other subscription unit, and the ONLY wire
	 * form for a run with no conversation behind it.
	 */
	it("frames a single run's chunks on the run endpoint", async () => {
		const { claw, client, agent, thread } = await watchable();
		const first = await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "one" },
			{ principal: ALICE },
		);
		const second = await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "two" },
			{ principal: ALICE },
		);

		const seen: RunStreamChunk[] = [];
		for await (const page of client.watchRun(second.runId)) {
			seen.push(...page.chunks);
			if (seen.some((c) => c.kind === "lifecycle" && c.event === "completed")) {
				break;
			}
		}
		// Narrowed to the run that was asked for, across the wire — the thread's log carries both.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((c) => c.runId === second.runId)).toBe(true);
		expect(seen.some((c) => c.runId === first.runId)).toBe(false);
	});

	/**
	 * THE DEFAULT on a run watch, so `useChat({ api })` pointed straight at the mounted route works
	 * with no parameter, no endpoint and no adapter code. A chat client that had to opt in would
	 * otherwise receive chunk JSON it does not recognise and render nothing, silently.
	 */
	it("serves a run as the AI SDK UI message stream by default", async () => {
		const { claw, handler, agent, thread } = await watchable();
		const sent = await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "hello" },
			{ principal: ALICE },
		);

		// NO PARAMETER: the UI protocol is what this endpoint serves by default.
		const response = await handler(
			new Request(`https://app.test/api/busyclaw/runs/${sent.runId}/watch`),
		);
		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

		const parts = (await response.text())
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.filter((payload) => payload !== "" && payload !== "[DONE]")
			.map((payload) => JSON.parse(payload) as Record<string, unknown>);

		// The run id IS the message id — which is what lets a client speak only of messages.
		expect(parts[0]).toMatchObject({ type: "start", messageId: sent.runId });
		expect(parts.map((p) => p["type"])).toContain("text-delta");
		expect(parts.at(-1)).toMatchObject({ type: "finish" });
	});

	/** The chunk view is still reachable on the same route, which is what the first-party client
	 *  asks for — the default serves the protocol that cannot ask for itself. */
	it("still serves chunks on the run route when asked", async () => {
		const { claw, handler, agent, thread } = await watchable();
		const sent = await claw.api.sendMessage(
			{ clawId: agent.id, threadId: thread.id, message: "hello" },
			{ principal: ALICE },
		);

		const response = await handler(
			new Request(
				`https://app.test/api/busyclaw/runs/${sent.runId}/watch?protocol=chunks`,
			),
		);
		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBeNull();
		// Terminates on its own, because the run is terminal — see `watchRun`.
		const body = await response.text();
		expect(body).toContain("run.started");
		// Our framing carries the cursor as an `id:` line; the UI protocol carries none.
		expect(body).toMatch(/^id: /m);
	});

	/**
	 * A CONVERSATION CANNOT BE ONE MESSAGE, so asking for it is refused rather than quietly served
	 * as chunks. The protocol's consumer keeps a single `state.message` and a second `start` renames
	 * it — honouring this would merge every turn in the thread into one.
	 */
	it("refuses the UI protocol on a thread, and says which endpoint has it", async () => {
		const { handler, thread } = await watchable();
		const response = await handler(
			new Request(
				`https://app.test/api/busyclaw/threads/${thread.id}/watch?protocol=ui`,
			),
		);
		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toMatch(/watch a run/);
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
