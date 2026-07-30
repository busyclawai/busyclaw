// What actually bounds a sandbox's reach, end to end through a real claw.
//
// The spec-import ceiling does NOT do it, and the brief that said it would was wrong. That ceiling
// names `Action::"source:<name>"`; a guest fetch is `busyclaw.fetch` and belongs to no source group.
// Worse, per-source slices compose as INTERSECTION — two imported specs each forbidding the sandbox
// outside their own origins would forbid everything.
//
// The bound that does exist is `allow` on the governed fetch tool: the DEPLOYMENT saying which
// destinations exist at all. These prove the property that makes it worth having — policy can narrow
// it and cannot widen it — because that is precisely the job a cross-source generated ceiling was
// being considered for, and it is already done by something that does not depend on inferring a
// claw's business from which specs happen to be imported.

import type { JsonObject } from "@busyclaw/contracts";
import { fetchTool } from "@busyclaw/egress/tool";
import { cedar } from "@busyclaw/policy-cedar";
import { runtimeRunOptionsWithCaller } from "@busyclaw/runtime";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, type V2Model } from "./fixtures";

const DECLARED = "https://93.184.216.34";
const OTHER = "https://93.184.216.35";

/** Calls `busyclaw.fetch` once at `url`, then reports what it got back. */
function fetchModel(url: string): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options: unknown) => {
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
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "busyclaw__fetch",
							input: JSON.stringify({ url }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				};
			}
			// Step two carries the tool RESULT, which is what the redaction case reads.
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify((options as { prompt: unknown }).prompt),
					},
				],
				finishReason: { unified: "stop", raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	} as unknown as V2Model;
}

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

type RunResult = { status: string; text?: string };
type Claw = {
	$context: {
		runtime: {
			generate: (
				prompt: string,
				ctx: Record<string, unknown>,
				options: unknown,
			) => Promise<RunResult>;
		};
	};
};

const run = (claw: Claw): Promise<RunResult> =>
	claw.$context.runtime.generate(
		"fetch it",
		{},
		runtimeRunOptionsWithCaller(undefined, "alice"),
	);

describe("what bounds a sandbox's reach", () => {
	// A blanket permit is the worst case an operator can write, and the one a cross-source ceiling
	// would have been defending against. `allow` holds under it: policy decides IF the action may run,
	// the deployment decides WHERE it may land, and the second is not reachable from the first.
	it("a blanket PERMIT cannot reach an origin the deployment did not declare", async () => {
		const seen: string[] = [];
		const claw = createClaw({
			model: fetchModel(`${OTHER}/collect`),
			tools: {
				"busyclaw.fetch": fetchTool({
					allow: [DECLARED],
					lookup,
					transport: async (input) => {
						seen.push(String(input));
						return new Response("ok");
					},
				}),
			},
			plugins: [cedar({ policies: `permit(principal, action, resource);` })],
		});
		// Permitted by policy, refused by the deployment's list beneath it — and refused LOUD. A
		// direct tool call propagates the throw as a run failure; the sandbox path converts the same
		// refusal into an error the guest catches. Either way the request never left, which is the
		// property: policy said yes and it still did not go.
		await expect(run(claw)).rejects.toMatchObject({
			code: "BUSYCLAW_CONFIGURATION_ERROR",
		});
		expect(seen).toEqual([]);
	});

	it("the same permit DOES reach a declared origin — the bound is the list, not the policy", async () => {
		const seen: string[] = [];
		const claw = createClaw({
			model: fetchModel(`${DECLARED}/thing`),
			tools: {
				"busyclaw.fetch": fetchTool({
					allow: [DECLARED],
					lookup,
					transport: async (input) => {
						seen.push(String(input));
						return new Response("ok");
					},
				}),
			},
			plugins: [cedar({ policies: `permit(principal, action, resource);` })],
		});
		await expect(run(claw)).resolves.toMatchObject({ status: "completed" });
		expect(seen).toEqual([`${DECLARED}/thing`]);
	});

	// The other direction: policy NARROWS within the declared list. Both layers are real, and this is
	// the pair that shows neither is doing the other's job.
	it("policy narrows within the declared list", async () => {
		const seen: string[] = [];
		const claw = createClaw({
			model: fetchModel(`${DECLARED}/thing`),
			tools: {
				"busyclaw.fetch": fetchTool({
					allow: [DECLARED],
					lookup,
					transport: async (input) => {
						seen.push(String(input));
						return new Response("ok");
					},
				}),
			},
			plugins: [
				cedar({
					policies: `permit(principal, action, resource);
forbid(principal, action == Action::"busyclaw.fetch", resource)
unless { context has server && context.server == "https://somewhere.else" };`,
				}),
			],
		});
		await expect(run(claw)).resolves.toMatchObject({ status: "completed" });
		expect(seen).toEqual([]);
	});
});

// A third party's response flows straight into the context window, which is the strongest
// untrusted-input boundary in the system. This is the DIRECT path — the model calling the tool
// itself — so what it pins is ordinary tool-output redaction.
//
// The nested path a sandbox guest takes adds a SECOND pass (`subInvoke` re-redacts before the value
// crosses back to untrusted brain), and that belongs where subInvoke lives: see
// `runtime/tests/subinvoke.test.ts` → "re-redacts what a nested tool RETURNS". Worth saying out loud
// because this test was first written claiming to prove that, and did not: it passed with nested
// re-redaction disabled, because a direct call never reaches it.
describe("a fetch response crosses the boundary redacted", () => {
	it("PII in a third-party response does not reach the model verbatim", async () => {
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			redaction: { redactor },
			model: fetchModel(`${DECLARED}/user`),
			tools: {
				"busyclaw.fetch": fetchTool({
					allow: [DECLARED],
					lookup,
					transport: async () =>
						new Response(
							JSON.stringify({
								email: "alice@example.com",
							} satisfies JsonObject),
						),
				}),
			},
			plugins: [cedar({ policies: `permit(principal, action, resource);` })],
		});
		const result = await run(claw);
		expect(result.status).toBe("completed");
		// `text` is the step-two prompt the model saw, which contains the tool result.
		expect(result.text).not.toContain("alice@example.com");
	});
});
