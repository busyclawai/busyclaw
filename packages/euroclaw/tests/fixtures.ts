import type { Detector, PiiSpan } from "@euroclaw/contracts";
import { createStoredRedactor } from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";

export type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

export const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const match of text.matchAll(/\S+@\S+/g)) {
		const value = match[0];
		if (value === undefined) continue;
		const start = match.index ?? 0;
		spans.push({
			start,
			end: start + value.length,
			kind: "email",
			source: "regex",
			value,
		});
	}
	return spans;
};

export function textModel(
	text: string,
	options: { modelId?: string } = {},
): V2Model {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: options.modelId ?? "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
		}),
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

export function approvalToolModel(): V2Model {
	let step = 0;
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
			if (step++ === 0) {
				const promptText = JSON.stringify(options.prompt);
				const token =
					promptText.match(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/)?.[0] ?? "NOTOKEN";
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "send_email",
							input: JSON.stringify({ to: token }),
						},
					],
					finishReason: "tool-calls",
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: "stop",
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

export function emailTool(input: {
	onExecute: (to: string) => unknown | Promise<unknown>;
}) {
	return tool({
		description: "Send email.",
		inputSchema: jsonSchema<{ to: string }>({
			type: "object",
			properties: { to: { type: "string" } },
			required: ["to"],
		}),
		execute: async ({ to }) => input.onExecute(to),
	});
}

export function durableRedactor(db = memoryAdapter()) {
	return {
		db,
		redactor: createStoredRedactor({
			detector: emailDetector,
			mappings: createPiiMappingStore(db),
		}),
	};
}
