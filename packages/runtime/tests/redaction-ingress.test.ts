// Redact-at-ingress coherence: one value wears ONE token across the model prompt, events, the
// transcript, and yield checkpoints — and the middleware stays as the fail-closed egress backstop.
// See docs/plans/redaction-coherence-plan.md (slice 2).
import type { Detector, PiiSpan } from "@euroclaw/contracts";
import {
	createMemoryPiiMappingStore,
	createStoredRedactor,
} from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime";

const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+\.\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			value,
			kind: "email",
			source: "regex",
		});
	}
	return spans;
};

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const TOKEN = /\{\{pii:email:[a-z0-9-]+\}\}/;
const TOKENS = /\{\{pii:email:[a-z0-9-]+\}\}/g;

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

function lookupTool(result: string) {
	return tool({
		description: "Look up a contact.",
		inputSchema: jsonSchema<Record<string, never>>({
			type: "object",
			properties: {},
		}),
		execute: async () => result,
	});
}

/** Step 0: call lookup_contact. Step 1+: echo the FIRST token visible in the prompt. */
function echoTokenModel(received: { prompts: string[] }): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const promptText = JSON.stringify(options.prompt);
			received.prompts.push(promptText);
			if (step++ === 0) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "lookup_contact",
							input: JSON.stringify({}),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			const token = promptText.match(TOKEN)?.[0] ?? "NOTOKEN";
			return {
				content: [{ type: "text", text: `sent to ${token}` }],
				finishReason: { unified: "stop", raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

describe("redact-at-ingress coherence", () => {
	it("one value, one token — across run.started, tool.completed, prompt, and final text", async () => {
		const events: unknown[] = [];
		const received = { prompts: [] as string[] };
		const runtime = createRuntime({
			model: echoTokenModel(received),
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createMemoryPiiMappingStore(),
				indexKey: "test-key",
			}),
			tools: { lookup_contact: lookupTool("reach bob@x.com today") },
			events: { emit: async (event) => void events.push(event) },
		});

		// The SAME address arrives via the user prompt AND the tool output.
		const result = await runtime.generate("email bob@x.com the offer");
		expect(result.status).toBe("completed");

		const eventsJson = JSON.stringify(events);
		const promptsJson = received.prompts.join("\n");
		expect(eventsJson).not.toContain("bob@x.com");
		expect(promptsJson).not.toContain("bob@x.com");

		// Every artifact wears the SAME token for that one value.
		const seen = new Set([
			...(eventsJson.match(TOKENS) ?? []),
			...(promptsJson.match(TOKENS) ?? []),
			...(result.text.match(TOKENS) ?? []),
		]);
		expect(result.text).toMatch(TOKEN);
		expect(seen.size).toBe(1);
	});

	it("middleware backstop: raw PII the model itself emits never reaches the next egress", async () => {
		const received = { prompts: [] as string[] };
		let step = 0;
		const leakyModel: V2Model = {
			specificationVersion: "v4",
			provider: "mock",
			modelId: "mock",
			supportedUrls: {},
			doGenerate: async (options) => {
				received.prompts.push(JSON.stringify(options.prompt));
				if (step++ === 0) {
					return {
						// The model spontaneously composes a RAW address in its own text.
						content: [
							{ type: "text", text: "let me contact leak@raw.com" },
							{
								type: "tool-call",
								toolCallId: "c1",
								toolName: "lookup_contact",
								input: JSON.stringify({}),
							},
						],
						finishReason: { unified: "tool-calls", raw: undefined },
						usage,
						warnings: [],
					};
				}
				return {
					content: [{ type: "text", text: "done" }],
					finishReason: { unified: "stop", raw: undefined },
					usage,
					warnings: [],
				};
			},
			doStream: async () => {
				throw new Error("stream not used");
			},
		};
		const runtime = createRuntime({
			model: leakyModel,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createMemoryPiiMappingStore(),
				indexKey: "test-key",
			}),
			tools: { lookup_contact: lookupTool("nothing found") },
		});

		await runtime.generate("hello");
		const secondPrompt = received.prompts[1] ?? "";
		expect(secondPrompt).not.toContain("leak@raw.com");
		expect(secondPrompt).toMatch(TOKEN);
	});

	it("yield → resume: the resumed transcript wears the SAME tokens (byte-stable checkpoint)", async () => {
		const db = memoryAdapter();
		const received = { prompts: [] as string[] };
		const events: unknown[] = [];
		const runtime = createRuntime({
			model: echoTokenModel(received),
			database: db,
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(db),
				indexKey: "test-key",
			}),
			tools: { lookup_contact: lookupTool("reach bob@x.com today") },
			events: { emit: async (event) => void events.push(event) },
		});

		// Deadline already past → the loop parks a checkpoint at the first resumable point.
		const yielded = await runtime.generate("email bob@x.com the offer", undefined, {
			deadlineAt: new Date(0).toISOString(),
		});
		expect(yielded.status).toBe("yielded");
		if (yielded.status !== "yielded") throw new Error("expected yield");

		const preYieldTokens = new Set(
			(JSON.stringify(events).match(TOKENS) ?? []).concat(
				received.prompts.join("\n").match(TOKENS) ?? [],
			),
		);
		expect(preYieldTokens.size).toBe(1);

		const resumed = await runtime.resumeRun(yielded.checkpointId);
		expect(resumed?.status).toBe("completed");
		// The resumed model saw the same token; the final text echoes it back.
		const [token] = [...preYieldTokens];
		expect(token).toBeDefined();
		expect(resumed?.text).toContain(token ?? "");
	});
});
