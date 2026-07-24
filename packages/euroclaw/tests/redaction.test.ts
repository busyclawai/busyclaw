// The createClaw `redaction` config group: posture resolution, the boot decision, per-claw
// routing, birth-immutability, and the schema injection. See docs/plans/redaction-dx-plan.md.
import type { ClawsStore, Detector, PiiSpan } from "@euroclaw/contracts";
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
import { emailDetector, owned, textModel } from "./fixtures";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function promptCaptureModel(received: { prompt: string }): V2Model {
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async (options) => {
			received.prompt = JSON.stringify(options.prompt);
			return {
				content: [{ type: "text", text: "done" }],
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
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
		const warnings: string[] = [];
		const received = { prompt: "" };
		const claw = owned({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: { posture: "raw" },
			warn: (message) => warnings.push(message),
		});
		expect(
			warnings.filter((message) => message.includes('posture "raw"')),
		).toHaveLength(1);

		const result = await claw.$context.runtime.generate("email a@b.com the offer");
		expect(result.status).toBe("completed");
		expect(received.prompt).toContain("a@b.com"); // raw by declaration
		expect(received.prompt).not.toContain("privacy placeholders");
	});

	it("strict + detector: redacts, and teaches the model the placeholder contract", async () => {
		const received = { prompt: "" };
		const claw = owned({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		const result = await claw.$context.runtime.generate("email a@b.com the offer");
		expect(result.status).toBe("completed");
		expect(received.prompt).not.toContain("a@b.com");
		expect(received.prompt).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);
		expect(received.prompt).toContain("privacy placeholders");
	});

	it("bare Detector[] shorthand unions detectors — strict over all of them", async () => {
		const received = { prompt: "" };
		// A second, trivial detector, unioned with the email one by the array — no composeDetectors().
		const wordDetector: Detector = (text) => {
			const spans: PiiSpan[] = [];
			for (const match of text.matchAll(/SECRET/g)) {
				const start = match.index ?? 0;
				spans.push({
					start,
					end: start + "SECRET".length,
					value: "SECRET",
					kind: "secret",
					source: "regex",
				});
			}
			return spans;
		};
		const claw = createClaw({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: [emailDetector, wordDetector],
		});
		const result = await claw.$context.runtime.generate(
			"email a@b.com re SECRET plan",
		);
		expect(result.status).toBe("completed");
		expect(received.prompt).not.toContain("a@b.com");
		expect(received.prompt).not.toContain("SECRET");
		expect(received.prompt).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);
		expect(received.prompt).toMatch(/\{\{pii:secret:[a-z0-9-]+\}\}/);
	});

	it("armed-but-silent (no detector): no placeholder contract in the system prompt", async () => {
		const received = { prompt: "" };
		const claw = owned({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: {},
		});
		await claw.$context.runtime.generate("email a@b.com the offer");
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
					detectors: [emailDetector],
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
				detectors: [emailDetector],
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
		expect(strict).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);

		// No redaction field on the row and unknown rows → the declared default.
		const bare = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "bare",
		});
		expect(bare).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);
		const unknown = await redactor.redactValue("email a@b.com", {
			scope: "claw",
			scopeId: "ghost",
		});
		expect(unknown).toMatch(/\{\{pii:email:[a-z0-9-]+\}\}/);
	});

	it("caches a row's posture forever (birth-immutable)", async () => {
		const { store, get } = fakeClawsStore({ s1: { redaction: "strict" } });
		const resolved = resolveRedaction({
			config: {
				posture: "per-claw",
				detectors: [emailDetector],
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
				config: { posture: "per-claw", detectors: [emailDetector] },
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

describe("governed read path (view + forgetSubject)", () => {
	const TOKEN = /\{\{pii:email:[a-z0-9-]+\}\}/;

	async function chatClaw() {
		const { createMemoryAudit } = await import("@euroclaw/core");
		const { memoryAdapter } = await import("@euroclaw/storage-core");
		const db = memoryAdapter();
		const audit = createMemoryAudit();
		const claw = owned({
			database: db,
			model: textModel("noted"),
			audit,
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		const agent = await claw.api.createClaw({
			id: "claw-1",
			createdBy: "user:actor-1",
			name: "assistant",
		});
		const thread = await claw.api.createThread({
			id: "thread-1",
			clawId: agent.id,
			title: "t",
		});
		return { claw, db, audit, agent, thread };
	}

	it("view defaults to redacted; original re-identifies; rows at rest stay tokens", async () => {
		const { claw, audit, thread } = await chatClaw();
		await claw.api.sendMessage({
			clawId: "claw-1",
			threadId: thread.id,
			message: "email alice@personal.com the offer",
		});

		const redacted = await claw.api.listMessages({ threadId: thread.id });
		expect(JSON.stringify(redacted)).not.toContain("alice@personal.com");
		expect(JSON.stringify(redacted)).toMatch(TOKEN);

		const original = await claw.api.listMessages({
			threadId: thread.id,
			view: "original",
		});
		expect(JSON.stringify(original)).toContain("alice@personal.com");

		// Read-side ONLY: the original view must never write back.
		const again = await claw.api.listMessages({ threadId: thread.id });
		expect(JSON.stringify(again)).not.toContain("alice@personal.com");

		const entry = audit
			.entries()
			.find((record) => record.name === "pii.reidentification");
		expect(entry).toMatchObject({
			boundary: "privacy",
			status: "ok",
			payload: { scope: "claw", scopeId: "claw-1", threadId: thread.id },
		});
	});

	it("sendMessage view original re-identifies the returned copy", async () => {
		const { claw, thread } = await chatClaw();
		const sent = await claw.api.sendMessage({
			clawId: "claw-1",
			threadId: thread.id,
			message: "email alice@personal.com the offer",
			view: "original",
		});
		expect(JSON.stringify(sent.userMessage.content)).toContain(
			"alice@personal.com",
		);
		const stored = await claw.api.listMessages({ threadId: thread.id });
		expect(JSON.stringify(stored)).not.toContain("alice@personal.com");
	});

	it("forgetSubject shreds the mappings: the original view degrades to tokens, audited", async () => {
		const { claw, db, audit, thread } = await chatClaw();
		const { createPiiMappingStore } = await import("@euroclaw/storage-durable");
		// A subject-linked mapping in the claw's own store (subjects are stamped by the
		// identity resolution in real deployments; seeded directly here).
		await createPiiMappingStore(db).save(
			{
				placeholder: "{{pii:email:seededtoken00}}",
				original: "subject@x.com",
				kind: "email",
				scope: "claw",
				scopeId: "claw-1",
				createdAt: "2026-07-13T00:00:00.000Z",
			},
			["subject-1"],
		);
		await claw.api.appendMessage({
			clawId: "claw-1",
			threadId: thread.id,
			content: { text: "reach {{pii:email:seededtoken00}}" },
			role: "user",
			visibility: "user",
		});

		const before = await claw.api.listMessages({
			threadId: thread.id,
			view: "original",
		});
		expect(JSON.stringify(before)).toContain("subject@x.com");

		await claw.api.forgetSubject({ subjectId: "subject-1" });

		const after = await claw.api.listMessages({
			threadId: thread.id,
			view: "original",
		});
		expect(JSON.stringify(after)).not.toContain("subject@x.com");
		expect(JSON.stringify(after)).toContain("{{pii:email:seededtoken00}}");
		expect(
			audit.entries().find((record) => record.name === "pii.erasure"),
		).toMatchObject({
			boundary: "privacy",
			payload: { subjectId: "subject-1" },
		});
	});

	it("fails loud where erasure would be false comfort", async () => {
		const { memoryAdapter } = await import("@euroclaw/storage-core");
		const raw = owned({
			database: memoryAdapter(),
			model: textModel("ok"),
			redaction: { posture: "raw" },
			warn: () => {}, // the expected raw-posture boot warning is not this test's subject
		});
		await expect(raw.api.forgetSubject({ subjectId: "s1" })).rejects.toThrow(
			/erasure is impossible/,
		);

		const none = owned({ model: textModel("ok") });
		await expect(none.api.forgetSubject({ subjectId: "s1" })).rejects.toThrow(
			/no redaction configured/,
		);
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
				schema: {
					claw: { additionalFields: { redaction: field.string({}) } },
				},
				redaction: { posture: "per-claw" },
			}),
		).toThrow(/assembly-owned/);
	});
});
