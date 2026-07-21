import type { JsonObject } from "@euroclaw/contracts";
import { redactionContextFrom, stateError } from "@euroclaw/contracts";
import type { Governance } from "@euroclaw/core";
import type { LanguageModelMiddleware } from "ai";
import type { RunState } from "./run-state";
import type { RuntimeModel } from "./runtime";

/**
 * AI SDK middleware for the model boundary: redact the prompt before provider egress, then run the
 * core model boundary. When `rawPii` (the selected model opted out of redaction — a local/trusted
 * model), the boundary TRANSLATES instead: it rehydrates the prompt so the model sees real values,
 * and re-redacts the model's output so everything the loop persists stays tokenized. Durable state
 * is never raw — only the model, in-flight, is.
 */
export function modelMiddleware(
	core: Governance,
	model: RuntimeModel,
	ctx: Record<string, unknown> | undefined,
	resolvedCtx: Record<string, unknown>,
	state: RunState,
	rawPii: boolean,
): LanguageModelMiddleware {
	return {
		transformParams: async ({ params }) => ({
			...params,
			prompt: rawPii
				? await core.redactor.rehydrateValue(
						params.prompt,
						redactionContextFrom(resolvedCtx),
					)
				: await core.redactor.redactValue(
						params.prompt,
						redactionContextFrom(resolvedCtx),
					),
		}),
		wrapGenerate: async ({ doGenerate, params }) => {
			state.currentModelRunner = doGenerate;
			try {
				const candidate = model as { provider?: unknown; modelId?: unknown };
				const source = params as Record<string, unknown>;
				const parameters: JsonObject = {};
				for (const key of [
					"maxOutputTokens",
					"temperature",
					"topP",
					"topK",
					"seed",
				]) {
					const value = source[key];
					if (typeof value === "number" && Number.isFinite(value)) {
						parameters[key] = value;
					}
				}
				const messages = (
					Array.isArray(params.prompt)
						? params.prompt
						: [{ role: "user", content: params.prompt }]
				).map((message) => {
					const value = message as { role?: unknown; content?: unknown };
					const parts = Array.isArray(value.content)
						? value.content
						: [value.content];
					return {
						role: typeof value.role === "string" ? value.role : "user",
						content: parts
							.map((part) => {
								if (typeof part === "string") return part;
								const p = part as { text?: unknown };
								return typeof p?.text === "string" ? p.text : "";
							})
							.filter(Boolean)
							.join("\n"),
					};
				});
				const result = await core.handleModelCall(
					{
						provider:
							typeof candidate.provider === "string"
								? candidate.provider
								: undefined,
						model:
							typeof candidate.modelId === "string"
								? candidate.modelId
								: undefined,
						parameters,
						messages,
					},
					ctx,
				);
				if (result.status === "ok") {
					const output = result.output as Awaited<
						ReturnType<typeof doGenerate>
					>;
					// A rawPii model saw raw values and may have emitted raw PII — re-redact its output
					// so what the loop persists (assistant text, tool-call args) stays tokenized, and
					// any new value gets its own placeholder + subject.
					return rawPii
						? await core.redactor.redactValue(
								output,
								redactionContextFrom(resolvedCtx),
							)
						: output;
				}
				throw stateError("model boundary gate denied model call", {
					status: result.status,
					gateId: result.gateId,
					reason: result.reason,
					reasonCode: result.reasonCode,
				});
			} finally {
				state.currentModelRunner = undefined;
			}
		},
	};
}
