// `claw.api.stream` — the shape of the thing it hands back.
//
// This exists because that shape broke and nothing noticed. The only test that touched streaming
// was azure-live.test.ts, which is `skipIf`-gated on real Azure credentials and therefore never
// runs — so when the app-authz PEP began wrapping every api method in an async function, `stream`
// started returning a PROMISE of the stream while `ClawApi` still declared it returned the stream
// itself. Every governed caller broke, and the suite stayed green. It surfaced by pointing the demo
// at a real database and watching the SSE body carry one opaque "An error occurred".
//
// So the assertion that matters is the boring one: it is awaitable, and what you get after awaiting
// actually streams.

import { createMemoryAudit } from "@busyclaw/core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import {
	durableRedactor,
	owned,
	type V2Model,
	withPrincipal,
} from "./fixtures";

/** A v4 model that really streams: one chunk per word, then a finish. */
function streamingModel(text: string): V2Model {
	const usage = {
		inputTokens: {
			total: 1,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: undefined, reasoning: undefined },
	};
	const words = text.split(" ");
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock-streaming",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text" as const, text }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage,
			warnings: [],
		}),
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "text-start", id: "0" });
					words.forEach((word, index) => {
						controller.enqueue({
							type: "text-delta",
							id: "0",
							delta: index === 0 ? word : ` ${word}`,
						});
					});
					controller.enqueue({ type: "text-end", id: "0" });
					controller.enqueue({
						type: "finish",
						finishReason: { unified: "stop", raw: undefined },
						usage,
					});
					controller.close();
				},
			}),
			warnings: [],
		}),
	} as unknown as V2Model;
}

describe("claw.api.stream", () => {
	it("returns a PROMISE of the stream — the PEP wraps every method, so it cannot be synchronous", async () => {
		const claw = owned({ model: streamingModel("hello there") });

		const pending = claw.api.stream({ prompt: "hi" });
		// The contract that regressed. Authorizing is asynchronous — it evaluates policy and can load
		// the resource — so handing back a live-looking stream before the decision is impossible.
		expect(typeof (pending as { then?: unknown }).then).toBe("function");

		const stream = await pending;
		expect(typeof stream.textStream[Symbol.asyncIterator]).toBe("function");
		await stream.result;
	});

	it("streams deltas that reconstruct the final text", async () => {
		const claw = owned({ model: streamingModel("one two three four") });

		const { textStream, result } = await claw.api.stream({ prompt: "count" });
		const deltas: string[] = [];
		for await (const delta of textStream) deltas.push(delta);
		const final = await result;

		expect(final.status).toBe("completed");
		// It genuinely streamed rather than emitting one blob at the end...
		expect(deltas.length).toBeGreaterThan(1);
		// ...and the pieces are the whole answer, nothing dropped or duplicated.
		expect(deltas.join("")).toBe(final.text);
		expect(final.text).toBe("one two three four");
	});

	it("REJECTS rather than handing back a stream when the caller is not authorized", async () => {
		// A denial must yield nothing at all. Resolving with a stream whose iteration later throws
		// would give a caller an authorized-looking object for a call that was refused.
		const claw = owned({ model: streamingModel("secret") });

		await expect(
			(
				claw.api.stream as unknown as (
					input: { prompt: string },
					caller: unknown,
				) => Promise<unknown>
			)({ prompt: "hi" }, { principal: "" }),
		).rejects.toThrow();
	});
});

// `claw.api.sendMessageAndStream` — the same send, watched as it is written.
//
// This exists because `stream` alone could not serve a chat UI. It is ad-hoc: no claw, no thread,
// nothing persisted, so the reader IS the only copy of the answer — close the tab and it is gone,
// and the run is aborted because there would be nothing left to serve. A conversation needs the
// opposite: the reply belongs to the thread whether or not anyone is currently watching it arrive.

const ACTOR = "user:actor-1";

async function conversation(model: V2Model) {
	const { db, redactor } = durableRedactor();
	const claw = createClaw({ database: db, model, redaction: { redactor } });
	const api = withPrincipal(claw, ACTOR).api;
	const agent = await api.createClaw({
		id: "claw-1",
		createdBy: ACTOR,
		name: "Assistant",
	});
	const thread = await api.createThread({
		id: "thread-1",
		clawId: agent.id,
		title: "Chat",
	});
	return { claw, api, agent, thread };
}

describe("claw.api.sendMessageAndStream", () => {
	it("streams the reply AND leaves it in the transcript", async () => {
		const { api, agent, thread } = await conversation(
			streamingModel("one two three four"),
		);

		const { textStream, result, userMessage } = await api.sendMessageAndStream({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});
		// The user's turn is already persisted — a chat UI renders it beside the arriving reply.
		expect(userMessage.role).toBe("user");

		const deltas: string[] = [];
		for await (const delta of textStream) deltas.push(delta);
		const final = await result;

		expect(final.status).toBe("completed");
		expect(deltas.length).toBeGreaterThan(1);
		expect(deltas.join("")).toBe(final.text);

		const messages = await api.listMessages({ threadId: thread.id });
		expect(messages.map((m) => m.role)).toContain("assistant");
	});

	it("keeps the answer when the reader walks away mid-stream", async () => {
		// The whole reason this method exists. A closed tab must not destroy a nearly-finished
		// answer: the run detaches, finishes, and the reply is in the thread to be read back.
		const { api, agent, thread } = await conversation(
			streamingModel("one two three four"),
		);

		const { textStream, result } = await api.sendMessageAndStream({
			clawId: agent.id,
			threadId: thread.id,
			message: "hello",
		});
		for await (const _delta of textStream) break; // the tab closes after one delta

		// Not rejected — finished.
		const final = await result;
		expect(final.status).toBe("completed");
		expect(final.text).toBe("one two three four");

		// And it is where the reader will look for it when they come back.
		const messages = await api.listMessages({ threadId: thread.id });
		const assistant = messages.filter((m) => m.role === "assistant");
		expect(assistant).toHaveLength(1);
		expect(JSON.stringify(assistant[0]?.content)).toContain(
			"one two three four",
		);
	});

	it("DENIES a principal who does not reach the claw", async () => {
		// It writes to a shared row, so it authorizes against the CLAW — like sendMessage, and unlike
		// the ad-hoc `stream`, which is caller-only. Anchoring it on the caller would have put it in
		// the group the sealed baseline permits for anyone authenticated, and this test would pass
		// while the method was in fact open to every account. Only a cross-principal call can tell.
		const { claw, agent, thread } = await conversation(
			streamingModel("secret"),
		);
		const stranger = withPrincipal(claw, "user:actor-2").api;

		await expect(
			stranger.sendMessageAndStream({
				clawId: agent.id,
				threadId: thread.id,
				message: "let me in",
			}),
		).rejects.toThrow();
	});
});

// M-09: a streamed prompt is egress, and egress is audited.
//
// `handleModelCall` runs the after-gates in a `finally`, so a GENERATED call is recorded whatever
// becomes of it. Streaming had no equivalent moment — the gate said yes and the middleware handed
// the stream back — so the audit gate, which is an after-gate, never fired. The identical prompt
// was recorded through `generate` and unrecorded through `stream`, which made the audit trail a
// statement about which API the caller reached for rather than about what left the deployment.

describe("M-09 — streamed model egress reaches the audit", () => {
	function entries(audit: ReturnType<typeof createMemoryAudit>) {
		return audit.entries().filter((entry) => entry.boundary === "model");
	}

	it("records a streamed model call, as a generated one already was", async () => {
		const audit = createMemoryAudit();
		const claw = owned({ model: streamingModel("one two three"), audit });

		const { textStream, result } = await claw.api.stream({ prompt: "hi" });
		for await (const _delta of textStream) {
			// drain
		}
		await result;

		expect(entries(audit).length).toBeGreaterThan(0);
	});

	it("records it even when the reader walks away mid-stream", async () => {
		// The prompt was SENT the moment the provider was called. Recording only the streams that
		// ended tidily would leave the trail quietest about exactly the calls worth looking at.
		const audit = createMemoryAudit();
		const claw = owned({ model: streamingModel("one two three four"), audit });

		const { textStream, result } = await claw.api.stream({ prompt: "hi" });
		for await (const _delta of textStream) break;
		await result.catch(() => {});
		for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);

		expect(entries(audit).length).toBeGreaterThan(0);
	});

	// TWO GUARDS HERE ARE NOT PROVEN BY THESE TESTS, and mutation says so: removing the `cancel`
	// handler, or the once-only latch, leaves all three green.
	//
	// The cancel handler covers the SDK cancelling the stream from inside. The test above reaches the
	// same end by a different road — an ad-hoc stream ABORTS its run when the reader leaves, so the
	// read throws and the catch settles instead. The latch guards `done` and `cancel` both firing,
	// which no path here does. Both stay: a missed cancel loses a record of egress that already
	// happened, and a double settle writes the same call into the chain twice. Neither is held in
	// place by a test.
	it("writes ONE record per streamed call, not one per delta", async () => {
		const audit = createMemoryAudit();
		const claw = owned({ model: streamingModel("a b c d e f g"), audit });

		const { textStream, result } = await claw.api.stream({ prompt: "hi" });
		const deltas: string[] = [];
		for await (const delta of textStream) deltas.push(delta);
		await result;

		expect(deltas.length).toBeGreaterThan(1);
		expect(entries(audit)).toHaveLength(1);
	});
});
