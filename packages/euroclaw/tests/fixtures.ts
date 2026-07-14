import type { Detector, PiiSpan } from "@euroclaw/contracts";
import { createStoredRedactor } from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";
import { jsonSchema, type Tool, tool, type wrapLanguageModel } from "ai";
import { createClaw } from "../src/index";

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
		specificationVersion: "v4",
		provider: "mock",
		modelId: options.modelId ?? "mock",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text }],
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

export function approvalToolModel(): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const usage = {
				inputTokens: {
					total: 1,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			};
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
}

export function emailTool(input: {
	onExecute: (to: string) => unknown | Promise<unknown>;
	// Explicit annotation: the inferred type reaches into `ai` internals that aren't exported
	// (non-portable under vitest typecheck on v7).
}): Tool<{ to: string }, unknown> {
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

function bindCaller(api: object, principal: string): object {
	return new Proxy(api, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value === "function") {
				// The app-authz caller rides at arg index 1, beside the single domain input — inject the
				// fixed principal when the test didn't pass one (its existing `method(input)` calls).
				return (...args: unknown[]) =>
					(value as (...a: unknown[]) => unknown).call(
						target,
						args[0],
						args[1] ?? { principal },
					);
			}
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value)
			) {
				return bindCaller(value, principal);
			}
			return value;
		},
	});
}

/**
 * Bind a fixed caller principal onto every governed `claw.api` call (flat + nested plugin namespaces)
 * so a test's existing `claw.api.method(input)` calls satisfy the app-authz actor floor without a
 * per-call edit. Pass the claw's `createdBy` so the owner rule permits its claw-scoped reads/writes.
 */
export function withPrincipal<T extends { readonly api: object }>(
	claw: T,
	principal: string,
): T {
	return new Proxy(claw, {
		get(target, prop, receiver) {
			if (prop === "api") {
				return bindCaller(Reflect.get(target, prop, receiver), principal);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

/** `createClaw` + a bound `user:actor-1` owner caller in one — for the common test whose api calls all
 *  act as the claw owner. `owned(config).api.method(input)` reads exactly like the pre-PEP call. */
export const owned: typeof createClaw = (config) =>
	withPrincipal(createClaw(config), "user:actor-1");
