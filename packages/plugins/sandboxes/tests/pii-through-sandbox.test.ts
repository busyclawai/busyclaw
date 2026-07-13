// Isolation hardening — PII THROUGH THE SANDBOX: the euroclaw-defining property. A model-authored
// script reasons on placeholders; the real value is reattached only at a trusted tool boundary, and
// the audit trail stays PII-free. The scripted model mirrors runtime.test.ts: it extracts the
// {{pii:...}} token from the redacted prompt and emits a run_code call whose `code` embeds that
// token, so the run exercises the full ingest→sandbox→nested-tool→audit path.
//
// The invoker tool runs BLIND: the runtime does not rehydrate a run_code call's args (the guest's
// `code` holds only placeholders), and re-redacts every nested tool's output before it crosses back.
// P1/P2 confirm the edge still works and the audit stays PII-free; BLIND-A/BLIND-P3/BLIND-P4 are the
// two-channel guards — the untrusted guest never holds a raw value, only a placeholder, whether it
// reads its own code, a nested tool's output, or its console logs. The real leaf tool still sees the
// rehydrated value at its trusted edge (BLIND-P3 asserts both directions).

import type { Detector, PiiSpan } from "@euroclaw/contracts";
import { createMemoryAudit, createMemoryRedactor } from "@euroclaw/core";
import { createRuntime } from "@euroclaw/runtime";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import type { ExecutionResult, Sandbox } from "../src/core/contracts";
import { runCodeTool } from "../src/index";
import { quickjs } from "../src/providers/quickjs/index";

// Known-good email detector, copied verbatim from runtime.test.ts.
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

// Step 0 extracts the {{pii:...}} token from the redacted prompt and emits a run_code call whose
// `code` is built from that token via `makeCode`; step 1 finishes with "done". Mirrors the
// placeholder-matching scripted model in runtime.test.ts.
function runCodeModel(makeCode: (token: string) => string): V2Model {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			const promptText = JSON.stringify(options.prompt);
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
				const token =
					promptText.match(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/)?.[0] ?? "NOTOKEN";
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "c1",
							toolName: "run_code",
							input: JSON.stringify({ code: makeCode(token) }),
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

const emailInputSchema = jsonSchema<{ to: string }>({
	type: "object",
	properties: { to: { type: "string" } },
	required: ["to"],
});

// Observe-only sandbox wrapper (lifted from nested-governance.test.ts): delegates to a real quickjs
// provider and records the last ExecutionResult, so a test can inspect exactly what the untrusted
// guest returned or logged. Pure instrumentation — it changes nothing about execution, and adds no
// production surface.
function recordingSandbox(): {
	sandbox: Sandbox;
	last: () => ExecutionResult | undefined;
} {
	const inner = quickjs();
	let captured: ExecutionResult | undefined;
	return {
		last: () => captured,
		sandbox: {
			provider: inner.provider,
			posture: inner.posture,
			validate: inner.validate,
			execute: async (input) => {
				const res = await inner.execute(input);
				captured = res.output;
				return res;
			},
		},
	};
}

// Decode the guest's hex string back to text. The BLIND probes hex-encode inside the sandbox so a
// leak would survive the runtime's own placeholder detector (which scans for `{{pii:...}}`, not
// hex) — the test decodes and asserts the raw value never made it into the guest.
function hexDecode(hex: string): string {
	let out = "";
	for (let i = 0; i < hex.length; i += 2) {
		out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
	}
	return out;
}

describe("@euroclaw/sandboxes PII through the sandbox", () => {
	// P1 — rehydration at the edge works THROUGH the sandbox: the script passes only the placeholder,
	// yet the real value is reattached inside the tool, downstream of the sandbox boundary. (P5: this
	// also confirms the run completes — the token embedded in `code` survived ingest and resolved in
	// the nested call.)
	it("P1: the real value is rehydrated inside the tool, downstream of the sandbox", async () => {
		let captured = "";
		const runtime = createRuntime({
			model: runCodeModel(
				(token) =>
					`return await tools.send_email({ to: ${JSON.stringify(token)} });`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: quickjs() }),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async ({ to }) => {
						captured = to;
						return { sent: true };
					},
				}),
			},
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		expect(captured).toBe("alice@personal.com");
	}, 30000);

	// P2 — the audit trail is PII-free: the audit is written from redacted text at every boundary
	// (model, run_code, and the nested send_email), so no raw email is ever recorded.
	it("P2: the audit trail contains no raw PII", async () => {
		const runtime = createRuntime({
			model: runCodeModel(
				(token) =>
					`return await tools.send_email({ to: ${JSON.stringify(token)} });`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: quickjs() }),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async () => ({ sent: true }),
				}),
			},
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		expect(JSON.stringify(runtime.audit?.entries() ?? [])).not.toContain(
			"alice@personal.com",
		);
	}, 30000);

	// BLIND-A (Channel A) — the guest's own `code` holds only a placeholder, never the raw value.
	// The script hex-encodes the token string it was given and returns the hex; decoding it must
	// yield the `{{pii:...}}` placeholder, not the real email. If run_code's args were rehydrated
	// (the pre-fix bug), the guest's code literal would carry `alice@personal.com`.
	it("BLIND-A: the guest code holds a placeholder, not raw PII", async () => {
		const rec = recordingSandbox();
		const runtime = createRuntime({
			model: runCodeModel(
				(token) =>
					`const s = ${JSON.stringify(token)}; let h = ""; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(2, "0"); return h;`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: { run_code: runCodeTool({ sandbox: rec.sandbox }) },
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		const decoded = hexDecode(String(rec.last()?.result ?? ""));
		expect(decoded).not.toContain("alice@personal.com");
		expect(decoded).toMatch(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/);
	}, 30000);

	// BLIND-P3 (Channel B) — a nested tool's OUTPUT is re-redacted before it crosses back to the
	// untrusted guest. send_email returns the value it was given; the guest hex-encodes the result
	// so a leak would survive the placeholder detector. Decoding must show a placeholder — AND the
	// real leaf tool must still have received the rehydrated value (the trusted edge still works).
	it("BLIND-P3: a nested tool's output is re-redacted before the guest sees it", async () => {
		let captured = "";
		const rec = recordingSandbox();
		const runtime = createRuntime({
			model: runCodeModel(
				(token) =>
					`const r = await tools.send_email({ to: ${JSON.stringify(token)} }); const s = JSON.stringify(r); let h = ""; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(2, "0"); return h;`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: rec.sandbox }),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async ({ to }) => {
						captured = to;
						return { sentTo: to };
					},
				}),
			},
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		// The leaf edge rehydrated the real value.
		expect(captured).toBe("alice@personal.com");
		// The guest only ever saw a placeholder in the returned output.
		const decoded = hexDecode(String(rec.last()?.result ?? ""));
		expect(decoded).not.toContain("alice@personal.com");
		expect(decoded).toMatch(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/);
	}, 30000);

	// BLIND-P3-stable — re-redaction is STABLE, not random per call: the same entity comes back as
	// the same placeholder, so guest-side orchestration (group-by, dedupe, count-distinct) works.
	// Two nested calls with the same token must return identical placeholders.
	it("BLIND-P3-stable: re-redaction yields a stable placeholder across calls", async () => {
		const rec = recordingSandbox();
		const runtime = createRuntime({
			model: runCodeModel(
				(token) =>
					`const a = await tools.send_email({ to: ${JSON.stringify(token)} }); const b = await tools.send_email({ to: ${JSON.stringify(token)} }); return a.sentTo === b.sentTo ? "stable" : "unstable";`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: {
				run_code: runCodeTool({ sandbox: rec.sandbox }),
				send_email: tool({
					description: "Send an email.",
					inputSchema: emailInputSchema,
					execute: async ({ to }) => ({ sentTo: to }),
				}),
			},
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		expect(rec.last()?.result).toBe("stable");
	}, 30000);

	// BLIND-P4 (logs channel) — the guest's console captures only a placeholder. The script logs the
	// token it holds; because the guest never holds the raw value, the captured logs cannot contain
	// the real email.
	it("BLIND-P4: guest console logs hold a placeholder, not raw PII", async () => {
		const rec = recordingSandbox();
		const runtime = createRuntime({
			model: runCodeModel(
				(token) => `console.log(${JSON.stringify(token)}); return 1;`,
			),
			redactor: createMemoryRedactor(emailDetector),
			audit: createMemoryAudit(),
			tools: { run_code: runCodeTool({ sandbox: rec.sandbox }) },
		});

		const result = await runtime.run("email alice@personal.com the offer");

		expect(result.status).toBe("completed");
		const logs = JSON.stringify(rec.last()?.logs ?? []);
		expect(logs).not.toContain("alice@personal.com");
		expect(logs).toMatch(/\{\{pii:[a-z]+:[a-z0-9]+\}\}/);
	}, 30000);
});
