// `watchToUIMessageStreamResponse` — a watcher's view of a turn, in the protocol `useChat` speaks.
//
// Asserts the parts on the WIRE rather than the encoder's return value, because the failure mode
// here is not an exception: a part with a wrong name or a missing required field is simply ignored
// by the client, and the stream renders nothing while looking healthy.

import type { RunStreamChunk, RunStreamPage } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { watchToUIMessageStreamResponse } from "../../src/ai-sdk/index";

/** One page per chunk — the shape a live poll produces, rather than one convenient batch. */
function pagesOf(
	chunks: readonly RunStreamChunk[],
): AsyncIterable<RunStreamPage> {
	return (async function* () {
		let n = 0;
		for (const chunk of chunks) {
			n += 1;
			yield { chunks: [chunk], cursor: String(n), stale: false };
		}
	})();
}

function parseSse(body: string): Array<Record<string, unknown>> {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.filter((payload) => payload !== "" && payload !== "[DONE]")
		.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

const RUN = "run_abc";
const started = { kind: "run.started", runId: RUN, attempt: 1 } as const;
const text = (body: string) =>
	({ kind: "text", runId: RUN, attempt: 1, text: body }) as const;
const done = {
	kind: "lifecycle",
	runId: RUN,
	attempt: 1,
	event: "completed",
} as const;

async function encode(chunks: readonly RunStreamChunk[]) {
	const response = watchToUIMessageStreamResponse({
		runId: RUN,
		pages: pagesOf(chunks),
	});
	return parseSse(await response.text());
}

describe("watchToUIMessageStreamResponse", () => {
	/**
	 * THE MAPPING THAT MAKES "RUN" A SERVER WORD: `runId` becomes `messageId`, so a client watching a
	 * turn is watching an assistant message and never has to learn our vocabulary.
	 */
	it("carries the run id as the message id, and brackets the text", async () => {
		const parts = await encode([started, text("one "), text("two"), done]);

		expect(parts.map((p) => p["type"])).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
			"finish",
		]);
		expect(parts[0]).toMatchObject({ type: "start", messageId: RUN });
		expect(
			parts
				.filter((p) => p["type"] === "text-delta")
				.map((p) => p["delta"])
				.join(""),
		).toBe("one two");
	});

	/**
	 * TOOL PARTS CLOSE THE TEXT FIRST. Nesting them inside an open text part puts two things the
	 * protocol treats as siblings inside one another, and the answer resumes afterwards as a new
	 * text part — which is also how a turn actually reads: prose, a tool call, more prose.
	 */
	it("closes text around a tool call and reopens it after", async () => {
		const parts = await encode([
			started,
			text("looking that up "),
			{
				kind: "tool",
				runId: RUN,
				step: 0,
				toolCallId: "c1",
				toolName: "send_email",
				status: "called",
			},
			{
				kind: "tool",
				runId: RUN,
				step: 0,
				toolCallId: "c1",
				toolName: "send_email",
				status: "completed",
			},
			text("done"),
			done,
		]);

		expect(parts.map((p) => p["type"])).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-end",
			"tool-input-available",
			"tool-output-available",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		expect(parts[4]).toMatchObject({
			toolCallId: "c1",
			toolName: "send_email",
		});
	});

	/** The chunk carries no arguments and no output by design; the encoder must not invent any. */
	it("sends the required tool fields without inventing arguments", async () => {
		const parts = await encode([
			started,
			{
				kind: "tool",
				runId: RUN,
				step: 0,
				toolCallId: "c1",
				toolName: "send_email",
				status: "called",
			},
			done,
		]);
		const call = parts.find((p) => p["type"] === "tool-input-available");
		// Present, because the protocol requires it — and empty, because a watcher is told which tool
		// runs, never what it was handed.
		expect(call).toMatchObject({ input: {} });
	});

	/**
	 * PARKED IS NOT FINISHED. A `finish` here would tell the client the answer is complete while it
	 * waits on an approval that may be granted minutes later — and the rest of the turn would then
	 * arrive after a message the client had closed.
	 */
	it("does not finish a message when the run only parked", async () => {
		const parts = await encode([
			started,
			text("about to ask"),
			{
				kind: "lifecycle",
				runId: RUN,
				attempt: 1,
				event: "parked",
				reason: "approval",
			},
		]);

		expect(parts.map((p) => p["type"])).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-end",
		]);
		expect(parts.some((p) => p["type"] === "finish")).toBe(false);
	});

	/** A failed run still ends the message — with a reason, so the client renders an error rather
	 *  than a turn that simply stopped. */
	it("finishes with an error reason when the run failed", async () => {
		const parts = await encode([
			started,
			{ kind: "lifecycle", runId: RUN, attempt: 1, event: "failed" },
		]);
		expect(parts.at(-1)).toMatchObject({
			type: "finish",
			finishReason: "error",
		});
	});

	/**
	 * A STALE PAGE ends the stream: the client's cursor points past the log, so there is nothing
	 * further this can honestly say. The text part is still closed — an unterminated one would leave
	 * a message rendering forever.
	 */
	it("closes cleanly on a stale page rather than hanging", async () => {
		const response = watchToUIMessageStreamResponse({
			runId: RUN,
			pages: (async function* () {
				yield {
					chunks: [started, text("half an ")],
					cursor: "2",
					stale: false,
				};
				yield { chunks: [], cursor: "2", stale: true };
			})(),
		});
		const parts = parseSse(await response.text());

		expect(parts.map((p) => p["type"])).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-end",
		]);
	});

	/** A supersede means a NEW generation of the same run follows. The protocol cannot say "discard
	 *  what I sent", so it is dropped rather than mistranslated into something that ends the message. */
	it("ignores supersede and resume, which this protocol cannot express", async () => {
		const parts = await encode([
			started,
			{ kind: "lifecycle", runId: RUN, attempt: 2, event: "superseded" },
			text("second attempt"),
			{ kind: "lifecycle", runId: RUN, attempt: 2, event: "resumed" },
			done,
		]);
		expect(parts.map((p) => p["type"])).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
	});
});
