// Multi-model routing: a named pool + per-run selection. A model whose output text IS its own id
// lets each test assert which model actually ran. Construction-time validation (mutually-exclusive
// model/models, exactly one default, non-empty) is the runtime backstop for the compile-time
// createClaw guard; the fail-closed unknown-name guard protects JS callers past the type system.
import type { Detector, PiiSpan } from "@euroclaw/contracts";
import { createMemoryRedactor } from "@euroclaw/core";
import type { wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createRuntime, type RuntimeEvent } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+/g)) {
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

/** A model that records the prompt it was handed — so a test can see redacted vs raw. */
function capturePromptModel(sink: { prompt: string }): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "capture",
		supportedUrls: {},
		doGenerate: async (options) => {
			sink.prompt = JSON.stringify(options.prompt);
			return {
				content: [{ type: "text", text: "ok" }],
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
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

/** A model that answers with its own id — so `result.text` names the model that ran. */
function taggedModel(id: string): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: id,
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text: id }],
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
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

describe("model routing", () => {
	it("run({ model }) picks the named model; unpinned falls to the default", async () => {
		const rt = createRuntime({
			models: {
				fast: taggedModel("fast"),
				smart: {
					model: taggedModel("smart"),
					default: true,
					tags: ["reasoning"],
				},
			},
		});
		expect(await rt.generate("hi", undefined, { model: "fast" })).toMatchObject({
			text: "fast",
		});
		expect(await rt.generate("hi", undefined, { model: "smart" })).toMatchObject({
			text: "smart",
		});
		expect(await rt.generate("hi")).toMatchObject({ text: "smart" }); // default
	});

	it("a sole-entry pool is the default with no flag", async () => {
		const rt = createRuntime({ models: { only: taggedModel("only") } });
		expect(await rt.generate("hi")).toMatchObject({ text: "only" });
	});

	it("mixes bare-model and descriptor entries", async () => {
		const rt = createRuntime({
			models: {
				bare: taggedModel("bare"),
				full: { model: taggedModel("full"), default: true },
			},
		});
		expect(await rt.generate("hi", undefined, { model: "bare" })).toMatchObject({
			text: "bare",
		});
	});

	it("the single-`model` shorthand still works unchanged", async () => {
		const rt = createRuntime({ model: taggedModel("solo") });
		expect(await rt.generate("hi")).toMatchObject({ text: "solo" });
	});

	describe("noPiiRedaction (raw to the model, tokenized at rest)", () => {
		it("a flagged model receives RAW pii; a normal model receives placeholders", async () => {
			const cloudSink = { prompt: "" };
			const localSink = { prompt: "" };
			const rt = createRuntime({
				redactor: createMemoryRedactor(emailDetector),
				models: {
					cloud: capturePromptModel(cloudSink),
					local: { model: capturePromptModel(localSink), noPiiRedaction: true },
				},
			});

			await rt.generate("email a@b.com", undefined, { model: "cloud" });
			expect(cloudSink.prompt).not.toContain("a@b.com");
			expect(cloudSink.prompt).toMatch(/\{\{pii:email:/);

			await rt.generate("email a@b.com", undefined, { model: "local" });
			expect(localSink.prompt).toContain("a@b.com"); // the local model sees raw
			expect(localSink.prompt).not.toMatch(/\{\{pii:email:/);
		});

		it("keeps durable state tokenized for the flagged model — subjects/erasure preserved", async () => {
			const events: RuntimeEvent[] = [];
			const rt = createRuntime({
				redactor: createMemoryRedactor(emailDetector),
				events: { emit: (event) => void events.push(event) },
				models: {
					local: {
						model: capturePromptModel({ prompt: "" }),
						noPiiRedaction: true,
						default: true,
					},
				},
			});
			await rt.generate("email a@b.com");
			// The model saw raw, but the persisted transcript (run.started) is tokenized — so the
			// value still lives in the mapping and can be erased later.
			const started = JSON.stringify(
				events.find((event) => event.type === "run.started"),
			);
			expect(started).not.toContain("a@b.com");
			expect(started).toMatch(/\{\{pii:email:/);
		});
	});

	describe("construction-time validation", () => {
		it("rejects model + models together", () => {
			expect(() =>
				createRuntime({
					model: taggedModel("x"),
					models: { a: taggedModel("a") },
				}),
			).toThrow(/mutually exclusive/);
		});

		it("rejects an empty pool", () => {
			expect(() => createRuntime({ models: {} })).toThrow(/empty/);
		});

		it("allows a multi-entry pool with no default — selection just becomes mandatory", async () => {
			const rt = createRuntime({
				models: { a: taggedModel("a"), b: taggedModel("b") },
			});
			// Construction succeeds; picking a model works…
			expect(await rt.generate("hi", undefined, { model: "a" })).toMatchObject({
				text: "a",
			});
			// …but an unpinned run fails closed (the run-time backstop for the compile-time rule).
			await expect(rt.generate("hi")).rejects.toThrow(/no default/);
		});

		it("rejects more than one default", () => {
			expect(() =>
				createRuntime({
					models: {
						a: { model: taggedModel("a"), default: true },
						b: { model: taggedModel("b"), default: true },
					},
				}),
			).toThrow(/more than one/);
		});

		it("rejects neither model nor models", () => {
			expect(() => createRuntime({})).toThrow(/no model configured/);
		});
	});

	describe("fail-closed run-time guards (JS callers past the types)", () => {
		it("rejects an unknown model name", async () => {
			const rt = createRuntime({ models: { a: taggedModel("a") } });
			await expect(
				rt.generate("hi", undefined, { model: "nope" } as never),
			).rejects.toThrow(/unknown model/);
		});

		it("rejects a run-level model when only a single `model` is configured", async () => {
			const rt = createRuntime({ model: taggedModel("solo") });
			await expect(
				rt.generate("hi", undefined, { model: "solo" } as never),
			).rejects.toThrow(/no `models` pool/);
		});
	});
});
