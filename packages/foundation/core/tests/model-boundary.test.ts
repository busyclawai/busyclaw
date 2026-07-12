import type { Detector, PiiSpan } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	createGovernance,
	createMemoryAudit,
	createMemoryRedactor,
} from "../src/index";

// A tiny PII detector for tests — in real use you bring your own (regex, Presidio, NER).
const emailDetector: Detector = (text) => {
	const spans: PiiSpan[] = [];
	for (const m of text.matchAll(/\S+@\S+/g)) {
		const value = m[0];
		if (value === undefined) continue;
		const start = m.index ?? 0;
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

describe("euroclaw governance — the model boundary (handleModelCall)", () => {
	it("redacts the prompt before the model sees it", async () => {
		let modelSaw: unknown;
		const ec = createGovernance({
			redactor: createMemoryRedactor(emailDetector),
			callModel: (call) => {
				modelSaw = call.messages[0]?.content;
				return { text: "ok" };
			},
		});

		const r = await ec.handleModelCall({
			messages: [
				{ role: "user", content: "email alice@personal.com about the invoice" },
			],
		});

		expect(r).toEqual({ status: "ok", output: { text: "ok" } });
		// the model provider received placeholders, never the raw address
		expect(modelSaw).toMatch(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/);
		expect(modelSaw).not.toContain("alice@personal.com");
	});

	it("audits the model call into the same log, tagged boundary:'model', redacted", async () => {
		const audit = createMemoryAudit();
		const ec = createGovernance({
			redactor: createMemoryRedactor(emailDetector),
			audit,
			callModel: () => ({ text: "done" }),
		});

		await ec.handleModelCall({
			messages: [{ role: "user", content: "to bob@work.com" }],
		});

		const entries = audit.entries();
		expect(entries).toHaveLength(1);
		expect(entries.at(0)?.boundary).toBe("model");
		expect(JSON.stringify(entries)).not.toContain("bob@work.com"); // redacted in the log
	});

	it("tool calls and model calls share one audit log", async () => {
		const audit = createMemoryAudit();
		const ec = createGovernance({ audit, callModel: () => ({ text: "x" }) });

		await ec.handleToolCall({ name: "send_email", args: {} });
		await ec.handleModelCall({ messages: [{ role: "user", content: "hi" }] });

		expect(audit.entries().map((e) => [e.boundary, e.name])).toEqual([
			["tool", "send_email"],
			["model", "model"],
		]);
	});

	it("model calls use the registered after-gate observer path", async () => {
		const seen: Array<[string, string]> = [];
		const ec = createGovernance({ callModel: () => ({ text: "x" }) });
		ec.registerAfterGate({
			id: "observer",
			matcher: () => true,
			handler: (call, _ctx, outcome) => {
				seen.push([call.boundary, outcome.status]);
			},
		});

		await ec.handleModelCall({ messages: [{ role: "user", content: "hi" }] });

		expect(seen).toEqual([["model", "ok"]]);
	});

	it("boundary gates can deny model calls before the model runs", async () => {
		let modelRan = false;
		const ec = createGovernance({
			callModel: () => {
				modelRan = true;
				return { text: "x" };
			},
		});
		ec.registerBoundaryGate({
			id: "model-block",
			matcher: (call) => call.boundary === "model",
			handler: () => ({ decision: "deny", reason: "model denied" }),
		});

		const result = await ec.handleModelCall({
			messages: [{ role: "user", content: "hi" }],
		});

		expect(result).toEqual({
			status: "denied",
			gateId: "model-block",
			reason: "model denied",
		});
		expect(modelRan).toBe(false);
	});

	it("model boundary gates can inspect provider/model metadata", async () => {
		let modelRan = false;
		const ec = createGovernance({
			callModel: () => {
				modelRan = true;
				return { text: "x" };
			},
		});
		ec.registerBoundaryGate({
			id: "model-allowlist",
			matcher: (call) =>
				call.boundary === "model" && call.modelCall.model === "blocked-model",
			handler: () => ({ decision: "deny", reason: "model not allowed" }),
		});

		const result = await ec.handleModelCall({
			provider: "mock",
			model: "blocked-model",
			parameters: { temperature: 0 },
			estimatedInputTokens: 10,
			messages: [{ role: "user", content: "hi" }],
		});

		expect(result).toEqual({
			status: "denied",
			gateId: "model-allowlist",
			reason: "model not allowed",
		});
		expect(modelRan).toBe(false);
	});

	it("model boundary gates cannot park runtime approval waits", async () => {
		const ec = createGovernance({ callModel: () => ({ text: "x" }) });
		ec.registerBoundaryGate({
			id: "model-approval",
			matcher: (call) => call.boundary === "model",
			handler: () => ({ decision: "needs-approval", reason: "confirm" }),
		});

		await expect(
			ec.handleModelCall({ messages: [{ role: "user", content: "hi" }] }),
		).rejects.toThrow(/model boundary approval waits are unsupported/);
	});

	it("sealed audit after-gate cannot be replaced and still observes model calls", async () => {
		const audit = createMemoryAudit();
		const ec = createGovernance({ audit, callModel: () => ({ text: "x" }) });

		expect(() =>
			ec.registerAfterGate({
				id: "audit",
				matcher: () => true,
				handler: () => {},
			}),
		).toThrow(/sealed/);

		await ec.handleModelCall({ messages: [{ role: "user", content: "hi" }] });
		expect(audit.entries()).toMatchObject([{ boundary: "model" }]);
	});

	it("fails closed when model audit append fails", async () => {
		const ec = createGovernance({
			audit: {
				append: async () => {
					throw new Error("audit unavailable");
				},
				entries: () => [],
			},
			callModel: () => ({ text: "done" }),
		});

		await expect(
			ec.handleModelCall({ messages: [{ role: "user", content: "hi" }] }),
		).rejects.toThrow(/audit unavailable/);
	});

	it("throws if you call the model boundary without configuring callModel", async () => {
		const ec = createGovernance();
		await expect(
			ec.handleModelCall({ messages: [{ role: "user", content: "hi" }] }),
		).rejects.toThrow(/requires config\.callModel/);
	});

	it("rejects a malformed model call (untrusted input)", async () => {
		const ec = createGovernance({ callModel: () => ({}) });
		// @ts-expect-error — messages must be an array of {role, content}
		await expect(ec.handleModelCall({ messages: "nope" })).rejects.toThrow(
			/invalid model call/,
		);
	});
});
