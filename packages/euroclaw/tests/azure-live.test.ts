// Live model integration for the branded `euroclaw` package — this SPENDS TOKENS, so it is doubly
// gated: it runs only when `AI_TESTS_ENABLED=1` is set AND the Azure OpenAI creds are present. The
// explicit flag means creds sitting in the shell can never trigger a paid call by accident; without
// it the suite skips entirely (CI stays green). Proves a claw generates against a REAL LLM end to
// end: the api → redaction → model-boundary gate → the generateText loop → a completed result.
//
//   AI_TESTS_ENABLED=1 AZURE_OPENAI_RESOURCE_NAME=… AZURE_OPENAI_DEPLOYMENT_NAME=… \
//     AZURE_OPENAI_API_KEY=… pnpm --filter euroclaw exec vitest run tests/azure-live.test.ts
import { createAzure } from "@ai-sdk/azure";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";

const aiTestsEnabled =
	process.env.AI_TESTS_ENABLED === "1" ||
	process.env.AI_TESTS_ENABLED === "true";
const resourceName = process.env.AZURE_OPENAI_RESOURCE_NAME ?? "";
const apiKey = process.env.AZURE_OPENAI_API_KEY ?? "";
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "";
const configured =
	aiTestsEnabled && resourceName !== "" && apiKey !== "" && deployment !== "";

describe.skipIf(!configured)("claw × Azure OpenAI (live)", () => {
	const model = createAzure({ resourceName, apiKey })(deployment);

	it("generates a completion through claw.api.generate", async () => {
		const claw = createClaw({ model });
		const result = await claw.api.generate({
			prompt: "Reply with exactly one word: pong",
		});
		expect(result.status).toBe("completed");
		expect(result.text.toLowerCase()).toContain("pong");
	}, 60_000);

	it("streams text deltas through claw.api.stream, reconstructing the final text", async () => {
		const claw = createClaw({ model });
		const { textStream, result } = claw.api.stream({
			prompt: "Say hello in one short friendly sentence.",
		});
		const deltas: string[] = [];
		for await (const delta of textStream) deltas.push(delta);
		const final = await result;
		expect(final.status).toBe("completed");
		// It actually streamed (deltas arrived) and they reconstruct the final text.
		expect(deltas.length).toBeGreaterThan(0);
		expect(deltas.join("")).toBe(final.text);
	}, 60_000);
});
