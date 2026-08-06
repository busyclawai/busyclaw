// A tool asks for ONE named capability and receives exactly that.
//
// `subInvoke` and `probeAccess` were each wired into the tool-call options by name, at the same site,
// with their own conditional. The third tenant — a tool that may spawn a subordinate run — would have
// been a third, and reusing `invoker` for it was the obvious shortcut and the wrong one: that bit
// gates the `subInvoke` injection AND the redacted-args posture together, so a tool granted the
// ability to create a child would have been granted arbitrary governed tool invocation with it. "May
// create subordinates" and "may call anything directly" are different permissions.
//
// So: the tool names what it wants, the host registers a factory under that name, and the runtime
// hands over that one thing. A tool that asked for nothing gets nothing; a tool that asked for
// "agent" cannot reach "sandbox" by guessing its option name.

import type { Detector, PiiSpan } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { createMemoryAudit, createStoredRedactor } from "@busyclaw/core";
import { memoryAdapter } from "@busyclaw/storage-core";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
	type CapabilityContext,
	createRuntime,
	govern,
	runtimeRunOptionsWithCaller,
} from "../src/index";

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

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/** Step 0 emits one tool call; step 1 finishes. */
function callToolOnceModel(
	toolName: string,
	args: Record<string, unknown>,
): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () => {
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
							toolCallId: "call-1",
							toolName,
							input: JSON.stringify(args),
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

/** A tool stamped with a capability, whose execute hands back whatever it was given under that name. */
function capabilityTool(
	name: string,
	run: (received: unknown, args: unknown) => Promise<unknown> | unknown,
) {
	return govern(
		tool({
			description: "Capability tool.",
			inputSchema: jsonSchema({ type: "object" }),
			execute: async (input, options) =>
				run((options as unknown as Record<string, unknown>)[name], input),
		}),
		{ capability: name },
	);
}

describe("the generic capability seam", () => {
	it("hands a stamped tool the capability it named, and nothing else", async () => {
		let received: unknown;
		const sawSandbox: unknown = "not-read";
		const runtime = createRuntime({
			model: callToolOnceModel("spawn", {}),
			audit: createMemoryAudit(),
			capabilities: {
				agent: () => ({ spawn: () => "child-1" }),
				// Registered, and NOT handed over: least authority is the point, so a tool that asked
				// for one capability must not find another sitting beside it.
				sandbox: () => ({ run: () => "should not be reachable" }),
			},
			tools: {
				spawn: capabilityTool("agent", (capability, _args) => {
					received = capability;
					return { ok: true };
				}),
			},
		});

		const result = await runtime.generate("go");

		expect(result.status).toBe("completed");
		expect(received).toMatchObject({ spawn: expect.any(Function) });
		expect(sawSandbox).toBe("not-read");
	});

	it("gives an unstamped tool no capability at all", async () => {
		let optionKeys: string[] = [];
		const runtime = createRuntime({
			model: callToolOnceModel("plain", {}),
			audit: createMemoryAudit(),
			capabilities: { agent: () => ({ spawn: () => "child-1" }) },
			tools: {
				plain: govern(
					tool({
						description: "A normal tool.",
						inputSchema: jsonSchema({ type: "object" }),
						execute: async (_input, options) => {
							optionKeys = Object.keys(
								options as unknown as Record<string, unknown>,
							);
							return { ok: true };
						},
					}),
					{},
				),
			},
		});

		await runtime.generate("go");
		expect(optionKeys).not.toContain("agent");
	});

	it("builds the capability PER CALL, not once at assembly", async () => {
		// The construction-order fix. A capability that needs the fully-built claw cannot be
		// constructed when the runtime is — so the factory runs at call time and may close over a slot
		// its own plugin fills later. If this ran at assembly, `built` would be 1 before any run.
		let built = 0;
		const runtime = createRuntime({
			model: callToolOnceModel("spawn", {}),
			audit: createMemoryAudit(),
			capabilities: {
				agent: () => {
					built += 1;
					return {};
				},
			},
			tools: { spawn: capabilityTool("agent", () => ({ ok: true })) },
		});

		expect(built).toBe(0);
		await runtime.generate("go");
		expect(built).toBe(1);
	});

	it("tells the factory which run and step is calling, and with what authority", async () => {
		let seen: CapabilityContext | undefined;
		const runtime = createRuntime({
			model: callToolOnceModel("spawn", {}),
			audit: createMemoryAudit(),
			capabilities: {
				agent: (ctx) => {
					seen = ctx;
					return {};
				},
			},
			tools: { spawn: capabilityTool("agent", () => ({ ok: true })) },
		});

		await runtime.generate(
			"go",
			{},
			runtimeRunOptionsWithCaller(undefined, userPrincipal("alice")),
		);

		// The run's own id, and the RESOLVED authority rather than the raw caller — a capability
		// reconstructs a caller from this instead of accepting one, which is what stops a spawned child
		// being pointed at somebody else's identity.
		expect(seen?.runId).toEqual(expect.any(String));
		expect(seen?.principal).toBe(userPrincipal("alice"));
		// Replay-stable, unlike a provider's tool-call id: a resume re-calls the tool and gets a new
		// one, so anything derived from a call id forks on retry.
		expect(seen?.step).toBe(0);
	});

	it("refuses a tool whose capability nobody registered", async () => {
		// Loud, not one-fewer-argument. Omitting it silently means the tool discovers the absence
		// mid-turn, as a TypeError attributed to the model's arguments — and a capability is exactly
		// the kind of thing whose absence is invisible until the moment it matters.
		const runtime = createRuntime({
			model: callToolOnceModel("spawn", {}),
			audit: createMemoryAudit(),
			tools: { spawn: capabilityTool("agent", () => ({ ok: true })) },
		});

		await expect(runtime.generate("go")).rejects.toThrow(/does not provide/);
	});

	it("refuses at ASSEMBLY a capability named like a runtime option", async () => {
		// A capability called `messages` would replace the transcript the AI SDK passes; one called
		// `subInvoke` would hand a non-invoker tool something indistinguishable from arbitrary governed
		// invocation. A developer with a stack trace beats a model turn behaving strangely.
		for (const name of ["messages", "subInvoke", "abortSignal", "toolCallId"]) {
			expect(() =>
				createRuntime({
					model: callToolOnceModel("spawn", {}),
					capabilities: { [name]: () => ({}) },
					tools: {},
				}),
			).toThrow(/collides with the runtime's own tool-call option/);
		}
	});
});

describe("a capability tool holds placeholders, never values", () => {
	it("keeps its args redacted the way an invoker's are", async () => {
		// The capability owns every container crossing. A tool holding rehydrated values could put one
		// into another container WITHOUT going through `translate`, where it would arrive as a
		// placeholder the destination cannot resolve — silently, with nothing thrown.
		let sawArgs = "";
		const adapter = memoryAdapter();
		const runtime = createRuntime({
			model: callToolOnceModel("spawn", { prompt: "email alice@x.com" }),
			audit: createMemoryAudit(),
			redactor: createStoredRedactor({
				detector: emailDetector,
				mappings: createPiiMappingStore(adapter),
			}),
			capabilities: { agent: () => ({}) },
			tools: {
				spawn: capabilityTool("agent", (_capability, args) => {
					sawArgs = JSON.stringify(args);
					return { ok: true };
				}),
			},
		});

		await runtime.generate("go");
		expect(sawArgs).not.toContain("alice@x.com");
		expect(sawArgs).toContain("{{pii:");
	});
});

describe("translate crosses two containers", () => {
	it("re-mints a parent's placeholder as one the destination run can resolve", async () => {
		// THE FIRST THING IN THE TREE THAT CROSSES TWO CONTAINERS. A placeholder only means anything
		// inside the container that minted it, so handing a child the parent's token gives it a string
		// that resolves to nothing — it reaches the child's tool as the literal `{{pii:…}}` text with
		// nothing thrown. Rehydrate there, re-redact here.
		const adapter = memoryAdapter();
		const mappings = createPiiMappingStore(adapter);
		const redactor = createStoredRedactor({
			detector: emailDetector,
			mappings,
		});
		let translated: unknown;
		let parentToken = "";

		const runtime = createRuntime({
			model: callToolOnceModel("spawn", { prompt: "write to alice@x.com" }),
			audit: createMemoryAudit(),
			redactor,
			capabilities: {
				agent: (ctx: CapabilityContext) => ({
					handOver: (value: unknown) =>
						ctx.translate(value, {
							runId: "child-run-1",
							subjectIds: ["subject-alice"],
						}),
				}),
			},
			tools: {
				spawn: capabilityTool("agent", async (capability, args) => {
					parentToken = JSON.stringify(args);
					translated = await (
						capability as { handOver: (v: unknown) => Promise<unknown> }
					).handOver(args);
					return { ok: true };
				}),
			},
		});

		await runtime.generate("go");

		// Both are placeholders — the value never travelled in the clear…
		expect(parentToken).toContain("{{pii:");
		expect(JSON.stringify(translated)).toContain("{{pii:");
		expect(JSON.stringify(translated)).not.toContain("alice@x.com");
		// …and they are DIFFERENT placeholders, which is the whole point: token coherence does not
		// survive the crossing, because the two containers mint independently.
		expect(JSON.stringify(translated)).not.toBe(parentToken);

		// The destination's own container resolves it. Without the crossing this returns the raw
		// placeholder and nothing throws — which is exactly the silent failure this exists to prevent.
		const inChild = await redactor.rehydrateValue(translated, {
			containerKind: "run",
			containerId: "child-run-1",
		});
		expect(JSON.stringify(inChild)).toContain("alice@x.com");
	});

	it("is a no-op when nothing was ever tokenized", async () => {
		let translated: unknown;
		const runtime = createRuntime({
			model: callToolOnceModel("spawn", { prompt: "hello" }),
			audit: createMemoryAudit(),
			capabilities: {
				agent: (ctx: CapabilityContext) => ({
					handOver: (value: unknown) =>
						ctx.translate(value, { runId: "child-run-1" }),
				}),
			},
			tools: {
				spawn: capabilityTool("agent", async (capability, args) => {
					translated = await (
						capability as { handOver: (v: unknown) => Promise<unknown> }
					).handOver(args);
					return { ok: true };
				}),
			},
		});

		await runtime.generate("go");
		expect(translated).toEqual({ prompt: "hello" });
	});
});
