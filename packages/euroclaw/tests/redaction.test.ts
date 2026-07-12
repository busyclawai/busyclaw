// The createClaw `redaction` config group: posture resolution, the boot decision, per-claw
// routing, birth-immutability, and the schema injection. See docs/plans/redaction-dx-plan.md.
import type { ClawsStore } from "@euroclaw/contracts";
import { field } from "@euroclaw/contracts";
import { memoryAdapter } from "@euroclaw/storage-core";
import type { wrapLanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaw, getEuroclawTables } from "../src/index";
import {
	REDACTION_SYSTEM_FRAGMENT,
	resolveRedaction,
	withImmutableRedaction,
} from "../src/redaction";
import { emailDetector, textModel } from "./fixtures";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function promptCaptureModel(received: { prompt: string }): V2Model {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			received.prompt = JSON.stringify(options.prompt);
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createClaw redaction group", () => {
	it("database without redaction fails loud, naming the group", () => {
		expect(() =>
			createClaw({ database: memoryAdapter(), model: textModel("ok") }),
		).toThrow(/configure redaction/);
	});

	it('posture "raw" boots with a database, warns once, and redacts nothing', async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const received = { prompt: "" };
		const claw = createClaw({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: { posture: "raw" },
		});
		expect(
			warn.mock.calls.some(([message]) =>
				String(message).includes('posture "raw"'),
			),
		).toBe(true);

		const result = await claw.$context.runtime.run("email a@b.com the offer");
		expect(result.status).toBe("completed");
		expect(received.prompt).toContain("a@b.com"); // raw by declaration
		expect(received.prompt).not.toContain("privacy placeholders");
	});

	it("strict + detector: redacts, and teaches the model the placeholder contract", async () => {
		const received = { prompt: "" };
		const claw = createClaw({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: { detector: emailDetector, indexKey: "test-key" },
		});
		const result = await claw.$context.runtime.run("email a@b.com the offer");
		expect(result.status).toBe("completed");
		expect(received.prompt).not.toContain("a@b.com");
		expect(received.prompt).toMatch(/\{\{pii:email:[a-z0-9]+\}\}/);
		expect(received.prompt).toContain("privacy placeholders");
	});

	it("armed-but-silent (no detector): no placeholder contract in the system prompt", async () => {
		const received = { prompt: "" };
		const claw = createClaw({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: {},
		});
		await claw.$context.runtime.run("email a@b.com the offer");
		expect(received.prompt).toContain("a@b.com"); // nothing detected
		expect(received.prompt).not.toContain("privacy placeholders");
	});

	it("custom redactor is mutually exclusive with detector/indexKey", () => {
		expect(() =>
			createClaw({
				database: memoryAdapter(),
				model: textModel("ok"),
				redaction: {
					redactor: {
						durable: true,
						redactValue: async (value) => value,
						rehydrateValue: async (value) => value,
					},
					detector: emailDetector,
				},
			}),
		).toThrow(/mutually exclusive/);
	});
});

describe("per-claw posture routing", () => {
	function fakeClawsStore(rows: Record<string, Record<string, unknown>>) {
		const get = vi.fn(async (id: string) => {
			const row = rows[id];
			return row ? ({ id, ...row } as never) : null;
		});
		return {
			store: { claws: { get } } as unknown as ClawsStore,
			get,
		};
	}

	it("routes by the claw row's redaction field; unknown rows use the default", async () => {
		const { store } = fakeClawsStore({
			r1: { redaction: "raw" },
			s1: { redaction: "strict" },
			bare: {},
		});
		const resolved = resolveRedaction({
			config: {
				posture: "per-claw",
				default: "strict",
				detector: emailDetector,
				indexKey: "test-key",
			},
			adapter: undefined,
			clawsStore: store,
			warn: () => {},
		});
		const redactor = resolved.redactor;
		if (!redactor) throw new Error("expected a redactor");

		const raw = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "r1",
		});
		expect(raw).toBe("email a@b.com");

		const strict = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "s1",
		});
		expect(strict).toMatch(/\{\{pii:email:[a-z0-9]+\}\}/);

		// No redaction field on the row and unknown rows → the declared default.
		const bare = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "bare",
		});
		expect(bare).toMatch(/\{\{pii:email:[a-z0-9]+\}\}/);
		const unknown = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "ghost",
		});
		expect(unknown).toMatch(/\{\{pii:email:[a-z0-9]+\}\}/);
	});

	it("caches a row's posture forever (birth-immutable)", async () => {
		const { store, get } = fakeClawsStore({ s1: { redaction: "strict" } });
		const resolved = resolveRedaction({
			config: {
				posture: "per-claw",
				detector: emailDetector,
				indexKey: "test-key",
			},
			adapter: undefined,
			clawsStore: store,
			warn: () => {},
		});
		const redactor = resolved.redactor;
		if (!redactor) throw new Error("expected a redactor");
		const ctx = { scope: "claw", scopeId: "s1" };
		await redactor.redactValue("email a@b.com", ctx);
		await redactor.redactValue("email c@d.com", ctx);
		await redactor.redactValue("email e@f.com", ctx);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('requires a database ("per-claw" without a claws store fails loud)', () => {
		expect(() =>
			resolveRedaction({
				config: { posture: "per-claw", detector: emailDetector },
				adapter: undefined,
				clawsStore: undefined,
				warn: () => {},
			}),
		).toThrow(/requires a database/);
	});

	it("withImmutableRedaction rejects posture patches, passes everything else", async () => {
		const update = vi.fn(async () => null);
		const store = {
			claws: { update },
		} as unknown as ClawsStore;
		const wrapped = withImmutableRedaction(store);
		await expect(
			wrapped.claws.update("c1", { redaction: "raw" } as never),
		).rejects.toThrow(/immutable/);
		expect(update).not.toHaveBeenCalled();
		await wrapped.claws.update("c1", { name: "renamed" } as never);
		expect(update).toHaveBeenCalledTimes(1);
	});
});

describe("per-claw schema injection", () => {
	it("adds the assembly-owned redaction column to the claw table", () => {
		const withPosture = getEuroclawTables({
			redaction: { posture: "per-claw" },
		});
		expect(withPosture["claw"]?.fields?.["redaction"]).toBeDefined();
		const without = getEuroclawTables({});
		expect(without["claw"]?.fields?.["redaction"]).toBeUndefined();
	});

	it("rejects a host redeclaring the redaction column", () => {
		expect(() =>
			getEuroclawTables({
				models: {
					claw: { additionalFields: { redaction: field.string({}) } },
				},
				redaction: { posture: "per-claw" },
			}),
		).toThrow(/assembly-owned/);
	});
});
