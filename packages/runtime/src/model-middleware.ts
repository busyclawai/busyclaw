import type { JsonObject } from "@euroclaw/contracts";
import { redactionContextFrom, stateError } from "@euroclaw/contracts";
import type { Governance } from "@euroclaw/core";
import type { LanguageModelMiddleware } from "ai";
import type { RunState } from "./run-state";
import type { RuntimeModel } from "./runtime";

type ModelCallShape = {
	provider: string | undefined;
	model: string | undefined;
	parameters: JsonObject;
	messages: { role: string; content: string }[];
};

/** Build the governance ModelCall (provider/model/params/flattened messages) from the AI SDK call
 *  params — shared by the generate (wrapGenerate) and stream (wrapStream) boundaries. */
function buildModelCall(model: RuntimeModel, params: unknown): ModelCallShape {
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
	const prompt = source.prompt;
	const messages = (
		Array.isArray(prompt) ? prompt : [{ role: "user", content: prompt }]
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
	return {
		provider:
			typeof candidate.provider === "string" ? candidate.provider : undefined,
		model:
			typeof candidate.modelId === "string" ? candidate.modelId : undefined,
		parameters,
		messages,
	};
}

/**
 * AI SDK middleware for the model boundary: redact the prompt before provider egress, then run the
 * core model boundary. When `rawPii` (the selected model opted out of redaction — a local/trusted
 * model), the boundary TRANSLATES instead: it rehydrates the prompt so the model sees real values,
 * and re-redacts the model's output so everything the loop persists stays tokenized. Durable state
 * is never raw — only the model, in-flight, is.
 *
 * `wrapGenerate` and `wrapStream` both gate the call; generate bundles the gate with running the
 * model (handleModelCall), while stream gates only (checkModelBoundary) and passes the real stream
 * through — the loop drives the stream itself.
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
				const result = await core.handleModelCall(
					buildModelCall(model, params),
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
		wrapStream: async ({ doStream, params }) => {
			// Gate-only: the model-boundary before-gates decide permit/deny on the request, then the
			// real stream passes through unchanged (the loop consumes it and emits rehydrated deltas).
			const gate = await core.checkModelBoundary(
				buildModelCall(model, params),
				ctx,
			);
			if (gate.status !== "ok") {
				throw stateError("model boundary gate denied model call", {
					status: gate.status,
					gateId: gate.gateId,
					reason: gate.reason,
					reasonCode: gate.reasonCode,
				});
			}
			return doStream();
		},
	};
}
