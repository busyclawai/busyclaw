import type { JsonObject, Outcome } from "@busyclaw/contracts";
import { errorMessage, redactionContextFrom, stateError } from "@busyclaw/contracts";
import type { Governance } from "@busyclaw/core";
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
			// The before-gates decide permit/deny on the request, then the real stream passes through
			// (the loop consumes it and emits rehydrated deltas).
			const call = buildModelCall(model, params);
			const gate = await core.checkModelBoundary(call, ctx);
			if (gate.status !== "ok") {
				// checkModelBoundary already closed the lifecycle for a denial — the refusal is the
				// record, and nothing will stream to end later.
				throw stateError("model boundary gate denied model call", {
					status: gate.status,
					gateId: gate.gateId,
					reason: gate.reason,
					reasonCode: gate.reasonCode,
				});
			}

			// M-09. `handleModelCall` runs the after-gates in a `finally`, so a generated call is
			// audited whatever becomes of it. Streaming had no such moment: the gate said yes and the
			// middleware handed the stream back, so the audit gate — an after-gate — never fired, and
			// a prompt sent through `stream` left the deployment unrecorded while the same prompt
			// through `generate` was audited. The end of the stream IS that moment; it just arrives in
			// the consumer's loop rather than here, so the lifecycle is closed from a transform the
			// stream carries with it.
			let settled = false;
			const settle = async (outcome: Outcome): Promise<void> => {
				if (settled) return; // flush AND cancel can both fire; the record is written once
				settled = true;
				await core.finishModelBoundary(call, outcome, ctx);
			};

			try {
				const streamed = await doStream();
				type Part = Awaited<ReturnType<typeof doStream>>["stream"] extends
					| ReadableStream<infer P>
					| undefined
					? P
					: never;
				const source = (
					streamed.stream as ReadableStream<Part>
				).getReader();
				let finishReason: unknown;
				let usage: unknown;
				// Read explicitly rather than `pipeThrough` a TransformStream: a transformer sees a
				// clean close but not a CANCEL, and a reader who walks away still sent the prompt.
				// Recording only the calls that ended tidily would leave the audit trail quietest
				// about exactly the ones worth looking at.
				const stream = new ReadableStream<Part>({
					async pull(controller) {
						try {
							const next = await source.read();
							if (next.done) {
								await settle({
									status: "ok",
									output: { finishReason, usage },
								});
								controller.close();
								return;
							}
							// The provider's own end-of-stream part is what the record reports — the
							// deltas themselves are the reader's, not the auditor's.
							const part = next.value as {
								type?: string;
								finishReason?: unknown;
								usage?: unknown;
							};
							if (part.type === "finish") {
								finishReason = part.finishReason;
								usage = part.usage;
							}
							controller.enqueue(next.value);
						} catch (err) {
							await settle({
								status: "error",
								reason: errorMessage(err),
							});
							controller.error(err);
						}
					},
					async cancel(reason) {
						await settle({
							status: "error",
							reason: `stream cancelled: ${errorMessage(reason)}`,
						});
						await source.cancel(reason);
					},
				});
				return { ...streamed, stream };
			} catch (err) {
				await settle({ status: "error", reason: errorMessage(err) });
				throw err;
			}
		},
	};
}
