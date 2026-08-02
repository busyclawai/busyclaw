// The createClaw `redaction` config group: posture resolution, the boot decision, per-claw
// routing, birth-immutability, and the schema injection. See docs/plans/redaction-dx-plan.md.
import type { ClawsStore, Detector, PiiSpan } from "@busyclaw/contracts";
import { field, UNCONTAINED, userPrincipal } from "@busyclaw/contracts";
import { memoryAdapter } from "@busyclaw/storage-core";
import type { wrapLanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaw, getBusyclawTables } from "../src/index";
import {
	REDACTION_SYSTEM_FRAGMENT,
	resolveRedaction,
	withImmutableRedaction,
} from "../src/redaction";
import {
	emailDetector,
	type MockModel,
	owned,
	textModel,
	withPrincipal,
} from "./fixtures";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function promptCaptureModel(received: { prompt: string }): MockModel {
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
			warn: (message: string) => void warnings.push(message),
		});
		expect(
			warnings.filter((message) => message.includes('posture "raw"')),
		).toHaveLength(1);

		const result = await claw.$context.runtime.generate(
			"email a@b.com the offer",
		);
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
		const result = await claw.$context.runtime.generate(
			"email a@b.com the offer",
		);
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

	// R-M05. This used to be "armed-but-silent": `redaction: {}` was accepted, the mechanism armed,
	// the mapping store built, and every value passed through untouched — a deployment that asked for
	// redaction, was told yes, and persisted cleartext. The failure had no symptom, because a
	// detector that finds nothing is indistinguishable from a corpus with nothing to find.
	it("refuses a strict posture with nothing to detect with", () => {
		expect(() =>
			owned({
				database: memoryAdapter(),
				model: textModel("ok"),
				redaction: {},
			}),
		).toThrow(/nothing to detect with/);
		// …and an explicit strict posture is refused the same way, not just the bare shorthand.
		expect(() =>
			owned({
				database: memoryAdapter(),
				model: textModel("ok"),
				redaction: { posture: "strict" },
			}),
		).toThrow(/nothing to detect with/);
	});

	// "This deployment does not redact" is still sayable — it just has to say so.
	it("still allows a deployment to declare it persists unredacted", async () => {
		const received = { prompt: "" };
		const claw = owned({
			database: memoryAdapter(),
			model: promptCaptureModel(received),
			redaction: { posture: "raw" },
		});
		await claw.$context.runtime.generate("email a@b.com the offer");
		expect(received.prompt).toContain("a@b.com");
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
		const { createMemoryAudit } = await import("@busyclaw/core");
		const { memoryAdapter } = await import("@busyclaw/storage-core");
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

	// H-07's other half. `toolCall.args`, `toolResult.output`/`error` and `checkpoint.state` are all
	// annotated `pii: "redacted"` — and the public writers handed caller data straight to the store,
	// so an authenticated caller could park raw PII inside a STRICT claw. Erasure would then report a
	// confident success having shredded mappings for a value that was never behind a placeholder.
	it("tokenizes the low-level artifact writes, not just messages", async () => {
		const { claw, agent, thread } = await chatClaw();
		const call = await claw.api.createToolCall({
			clawId: agent.id,
			threadId: thread.id,
			runId: "run-1",
			toolCallId: "c1",
			toolName: "send_email",
			args: { to: "alice@personal.com" },
		});
		expect(JSON.stringify(call.args)).not.toContain("alice@personal.com");
		expect(JSON.stringify(call.args)).toMatch(TOKEN);

		const result = await claw.api.createToolResult({
			clawId: agent.id,
			threadId: thread.id,
			runId: "run-1",
			toolCallId: "c1",
			status: "completed",
			outputMode: "redacted",
			output: { echoed: "bob@personal.com" },
		});
		expect(JSON.stringify(result.output)).not.toContain("bob@personal.com");
		expect(JSON.stringify(result.output)).toMatch(TOKEN);

		const checkpoint = await claw.api.createCheckpoint({
			clawId: agent.id,
			threadId: thread.id,
			runId: "run-1",
			kind: "step",
			state: { note: "carol@personal.com" },
		});
		expect(JSON.stringify(checkpoint.state)).not.toContain(
			"carol@personal.com",
		);
		expect(JSON.stringify(checkpoint.state)).toMatch(TOKEN);
	});

	it("forgetSubject shreds the mappings: the original view degrades to tokens, audited", async () => {
		const { claw, db, audit, thread } = await chatClaw();
		const { createPiiMappingStore } = await import("@busyclaw/storage-durable");
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

		await claw.api.forgetSubject({
			subjectId: "subject-1",
			scope: "claw",
			scopeId: "claw-1",
		});

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
		const { memoryAdapter } = await import("@busyclaw/storage-core");
		const raw = owned({
			database: memoryAdapter(),
			model: textModel("ok"),
			redaction: { posture: "raw" },
			warn: () => {}, // the expected raw-posture boot warning is not this test's subject
		});
		// A claw the caller OWNS, so the container resolves and authorization passes — this test is
		// about the posture refusing, and it would otherwise be answered by the PEP first and never
		// reach the thing it is asking about.
		const rawClaw = await raw.api.createClaw({ id: "c1", name: "raw" });
		await expect(
			raw.api.forgetSubject({
				subjectId: "s1",
				scope: "claw",
				scopeId: rawClaw.id,
			}),
		).rejects.toThrow(/erasure is impossible/);

		// No database ⇒ no claws store ⇒ no claw to own, so there is no container this caller could
		// have a claim on. The PEP is not what this case is about, and `unsafeOpen` says that out loud
		// rather than reaching the redaction check by accident.
		const none = owned({
			model: textModel("ok"),
			appAuthz: { unsafeOpen: true },
		});
		await expect(
			none.api.forgetSubject({ subjectId: "s1", scope: "claw", scopeId: "c1" }),
		).rejects.toThrow(/no redaction configured/);
	});
	// R-H01 — erasure names the container it acts in, and the container's own owner rule authorizes it.
	//
	// `forgetSubject` took a bare `subjectId`. The rows it deletes have always carried `(scope, scopeId)`,
	// but the REQUEST named none — so the sweep crossed every container the subject appeared in, and the
	// route had nothing to resolve against, which is why it was `callerOnly`. Over HTTP that is an
	// unbounded delete of any subject's mappings by any authenticated caller: destructive, cross-tenant,
	// and irreversible by construction, since a crypto-shred is the point.
	//
	// The container is part of the request now, and it binds exactly like `shareResource` does — the
	// caller NAMES a kind and an id, and the generic owner ∪ scope ∪ grant rule decides it at `manage`.
	// A `("claw", clawId)` container therefore asks the claw's owner rule; an unregistered kind resolves
	// nothing and denies. Erasing across EVERY container is still a real DSR need and still possible —
	// from in-process trusted code holding the redaction handle, never from the wire.
	describe("forgetSubject is bounded by a container (R-H01)", () => {
		it("erases in the named container and leaves another one's mappings intact", async () => {
			const { claw, db } = await chatClaw();
			const { createPiiMappingStore } = await import(
				"@busyclaw/storage-durable"
			);
			const mappings = createPiiMappingStore(db);
			// The SAME subject and the SAME token, in two containers. Only one is named by the request.
			for (const scopeId of ["claw-1", "claw-2"]) {
				await mappings.save(
					{
						placeholder: "{{pii:email:seededtoken00}}",
						original: "subject@x.com",
						kind: "email",
						scope: "claw",
						scopeId,
						createdAt: "2026-07-13T00:00:00.000Z",
					},
					["subject-1"],
				);
			}

			const { erased } = await claw.api.forgetSubject({
				subjectId: "subject-1",
				scope: "claw",
				scopeId: "claw-1",
			});
			expect(erased).toBe(1);

			// Gone where it was asked for…
			expect(
				await mappings.resolve("{{pii:email:seededtoken00}}", {
					scope: "claw",
					scopeId: "claw-1",
				}),
			).toBeNull();
			// …and untouched where it was not. The bare-subjectId sweep destroyed both.
			expect(
				await mappings.resolve("{{pii:email:seededtoken00}}", {
					scope: "claw",
					scopeId: "claw-2",
				}),
			).toBe("subject@x.com");
		});

		it("denies a caller with no claim on the named container", async () => {
			// The reason the container had to reach the request at all: with nothing to resolve, the route
			// authorized against the caller alone and every authenticated stranger passed.
			const { claw } = await chatClaw();
			await expect(
				withPrincipal(claw, userPrincipal("stranger")).api.forgetSubject({
					subjectId: "subject-1",
					scope: "claw",
					scopeId: "claw-1",
				}),
			).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED/);
		});

		it("denies a container kind nothing registers — fail closed, not fall through", async () => {
			// `busyclaw:uncontained` is core's stand-in for "this mapping belongs to no boundary". Nothing
			// registers that kind, so it resolves no resource and denies. An uncontained mapping is not
			// erasable from the wire, which is the correct answer rather than an oversight.
			const { claw } = await chatClaw();
			await expect(
				claw.api.forgetSubject({
					subjectId: "subject-1",
					...UNCONTAINED,
				}),
			).rejects.toThrow(/BUSYCLAW_AUTHORIZATION_DENIED/);
		});
	});
});

describe("per-claw schema injection", () => {
	it("adds the assembly-owned redaction column to the claw table", () => {
		const withPosture = getBusyclawTables({
			redaction: { posture: "per-claw" },
		});
		expect(withPosture["claw"]?.fields?.["redaction"]).toBeDefined();
		const without = getBusyclawTables({});
		expect(without["claw"]?.fields?.["redaction"]).toBeUndefined();
	});

	it("rejects a host redeclaring the redaction column", () => {
		expect(() =>
			getBusyclawTables({
				schema: {
					claw: { additionalFields: { redaction: field.string({}) } },
				},
				redaction: { posture: "per-claw" },
			}),
		).toThrow(/assembly-owned/);
	});
});
