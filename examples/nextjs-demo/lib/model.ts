// The model behind the demo: Azure OpenAI, with a scripted stand-in when it isn't configured.
//
// The stand-in exists so `pnpm dev` always boots and the UI is always explorable — but it is
// SCRIPTED, never a silent downgrade: the app badges which one is live so nobody films a demo
// believing a real model answered. Env names match the repo's existing live test
// (packages/busyclaw/tests/azure-live.test.ts).

import { createAzure } from "@ai-sdk/azure";

// The provider's own model type, not `ai`'s `LanguageModel` — that union also admits a bare model-id
// string, which createClaw rightly refuses (it needs an instantiated model, not a name to resolve).
type ClawModel = ReturnType<ReturnType<typeof createAzure>>;

const resourceName = process.env.AZURE_OPENAI_RESOURCE_NAME ?? "";
const apiKey = process.env.AZURE_OPENAI_API_KEY ?? "";
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "";

export const modelIsLive =
	resourceName !== "" && apiKey !== "" && deployment !== "";

export const modelLabel = modelIsLive
	? `azure:${deployment}`
	: "scripted (no Azure credentials)";

/**
 * A model that streams a canned answer word by word. It satisfies the same v4 spec the runtime
 * drives, so every governed step is REAL — redaction, the model boundary, the streaming
 * rehydrator — only the intelligence is fake.
 */
function scriptedModel(): ClawModel {
	const reply = (prompt: string): string => {
		const sawToken = prompt.includes("{{pii:");
		return sawToken
			? "I can see this request references a person, but the identifying details reached me as opaque placeholders — I never received the raw values. Ask me to act on it and the tool doing the work will see the real data; I will not."
			: "This is the scripted model: no Azure credentials are configured, so nothing was sent to a provider. Set AZURE_OPENAI_RESOURCE_NAME, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT_NAME to talk to a real model.";
	};

	const usage = {
		inputTokens: {
			total: 1,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: undefined, reasoning: undefined },
	};

	const promptText = (options: unknown): string => {
		try {
			return JSON.stringify(options ?? {});
		} catch {
			return "";
		}
	};

	return {
		specificationVersion: "v4",
		provider: "busyclaw-demo",
		modelId: "scripted",
		supportedUrls: {},
		doGenerate: async (options: unknown) => ({
			content: [{ type: "text" as const, text: reply(promptText(options)) }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage,
			warnings: [],
		}),
		doStream: async (options: unknown) => {
			const words = reply(promptText(options)).split(" ");
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: "text-start", id: "0" });
						let index = 0;
						const push = () => {
							if (index >= words.length) {
								controller.enqueue({ type: "text-end", id: "0" });
								controller.enqueue({
									type: "finish",
									finishReason: { unified: "stop", raw: undefined },
									usage,
								});
								controller.close();
								return;
							}
							const word = words[index];
							index += 1;
							controller.enqueue({
								type: "text-delta",
								id: "0",
								delta: index === 1 ? word : ` ${word}`,
							});
							setTimeout(push, 28);
						};
						push();
					},
				}),
				warnings: [],
			};
		},
		// The scripted model is shaped by hand; the cast is the one place that admits it.
	} as unknown as ClawModel;
}

export function resolveModel(): ClawModel {
	if (!modelIsLive) return scriptedModel();
	return createAzure({ resourceName, apiKey })(deployment);
}
