// Plugin redaction handles (docs/plans/observability-plan.md, slice 6): `ctx.redact` /
// `ctx.rehydrate` on the plugin configure context — container rules, token coherence with the
// transcript, the audited rehydrate, the inert-claw-token fence, and the unarmed identity.
import type {
	EuroclawPluginConfigureContext,
	PiiMapping,
	PiiMappingStore,
} from "@euroclaw/contracts";
import {
	createMemoryAudit,
	createMemoryPiiMappingStore,
	createStoredRedactor,
} from "@euroclaw/core";
import { memoryAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { emailDetector, owned, textModel } from "./fixtures";

const TOKEN = /\{\{pii:email:[a-z0-9-]+\}\}/;

type CapturedHandles = {
	redact?: EuroclawPluginConfigureContext["redact"];
	rehydrate?: EuroclawPluginConfigureContext["rehydrate"];
};

/** A plugin that only captures its configure-context handles, `door = ctx.events`-style. */
function capture(id = "keeper") {
	const captured: CapturedHandles = {};
	const plugin = {
		id,
		configure(ctx: EuroclawPluginConfigureContext) {
			captured.redact = ctx.redact;
			captured.rehydrate = ctx.rehydrate;
			return undefined;
		},
	};
	return { captured, plugin };
}

function requireHandles(captured: CapturedHandles) {
	const { redact, rehydrate } = captured;
	if (!redact || !rehydrate) {
		throw new Error("expected redaction handles on the configure context");
	}
	return { redact, rehydrate };
}

/** A memory mapping store with `save` spied, so tests can assert WHICH container a handle
 *  redaction minted into. */
function spiedMappings() {
	const saved: PiiMapping[] = [];
	const base = createMemoryPiiMappingStore();
	const mappings: PiiMappingStore = {
		...base,
		save(mapping, subjectIds) {
			saved.push(mapping);
			return base.save(mapping, subjectIds);
		},
	};
	return { mappings, saved };
}

describe("plugin redaction handles", () => {
	it("redact without clawId tokenizes into the plugin's own container", async () => {
		const { mappings, saved } = spiedMappings();
		const { captured, plugin } = capture();
		createClaw({
			model: textModel("done"),
			plugins: [plugin],
			redaction: {
				redactor: createStoredRedactor({
					detector: emailDetector,
					indexKey: "test-key",
					mappings,
				}),
			},
		});
		const { redact } = requireHandles(captured);

		const out = await redact("reach alice@personal.com");

		expect(out).toMatch(TOKEN);
		expect(out).not.toContain("alice@personal.com");
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			kind: "email",
			original: "alice@personal.com",
			scope: "plugin",
			scopeId: "keeper",
		});
	});

	// core/redact.ts findByHash filters by the (scope, scopeId) container, so lookup-or-mint is
	// container-LOCAL: sharing the claw's container with the transcript means sharing its tokens.
	it("redact({ clawId }) mints the SAME token the transcript minted for the same value", async () => {
		const { captured, plugin } = capture();
		const claw = owned({
			database: memoryAdapter(),
			model: textModel("noted"),
			plugins: [plugin],
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
		await claw.api.sendMessage({
			clawId: agent.id,
			threadId: thread.id,
			message: "reach alice@personal.com",
		});
		const stored = await claw.api.listMessages({ threadId: thread.id });
		const transcriptToken = JSON.stringify(stored).match(TOKEN)?.[0];
		expect(transcriptToken).toBeDefined();

		const { redact } = requireHandles(captured);
		// The claw's container → token coherence with the transcript…
		const viaClaw = await redact("reach alice@personal.com", {
			clawId: agent.id,
		});
		expect(viaClaw).toBe(`reach ${transcriptToken}`);
		// …the plugin's own container → its OWN token for the same value.
		const viaPlugin = await redact("reach alice@personal.com");
		expect(viaPlugin).toMatch(TOKEN);
		expect(viaPlugin).not.toBe(`reach ${transcriptToken}`);
	});

	it("per-claw: redact({ clawId }) follows the claw's birth posture — strict tokenizes, raw passes", async () => {
		const { captured, plugin } = capture();
		const claw = owned({
			database: memoryAdapter(),
			model: textModel("done"),
			plugins: [plugin],
			redaction: {
				posture: "per-claw",
				detectors: [emailDetector],
				indexKey: "test-key",
			},
		});
		await claw.api.createClaw({
			id: "strict-claw",
			createdBy: "user:actor-1",
			name: "strict",
			redaction: "strict",
		});
		await claw.api.createClaw({
			id: "raw-claw",
			createdBy: "user:actor-1",
			name: "raw",
			redaction: "raw",
		});
		const { redact } = requireHandles(captured);

		const strict = await redact("reach alice@personal.com", {
			clawId: "strict-claw",
		});
		expect(strict).toMatch(TOKEN);
		const raw = await redact("reach alice@personal.com", {
			clawId: "raw-claw",
		});
		expect(raw).toBe("reach alice@personal.com");
	});

	it("rehydrate round-trips the plugin's own token and lands ONE pii.reidentification audit record", async () => {
		const audit = createMemoryAudit();
		const { captured, plugin } = capture();
		createClaw({
			audit,
			model: textModel("done"),
			plugins: [plugin],
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		const { redact, rehydrate } = requireHandles(captured);

		const token = await redact("reach alice@personal.com");
		expect(token).toMatch(TOKEN);
		expect(await rehydrate(token)).toBe("reach alice@personal.com");

		const records = audit
			.entries()
			.filter((record) => record.name === "pii.reidentification");
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			boundary: "privacy",
			status: "ok",
			payload: { scope: "plugin", scopeId: "keeper" },
		});
	});

	// The structural-security test: rehydration is fenced by CONTAINMENT (the mapping store
	// resolves a placeholder only within its minting container), never by token filtering.
	// This must fail if plugin rehydrate is ever widened beyond the plugin's own container.
	it("the fence: a claw-container token stays INERT through plugin rehydrate", async () => {
		const { captured, plugin } = capture();
		createClaw({
			model: textModel("done"),
			plugins: [plugin],
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		const { redact, rehydrate } = requireHandles(captured);

		const clawScoped = await redact("reach alice@personal.com", {
			clawId: "claw-1",
		});
		expect(clawScoped).toMatch(TOKEN);

		const back = await rehydrate(clawScoped);
		expect(back).toBe(clawScoped); // the placeholder comes back UNRESOLVED
		expect(back).not.toContain("alice@personal.com");
	});

	it("unarmed (no redaction / posture raw): both handles are the identity — same reference, no audit", async () => {
		const audit = createMemoryAudit();
		const payload = { note: "reach alice@personal.com" };

		const none = capture();
		createClaw({ audit, model: textModel("done"), plugins: [none.plugin] });
		const noneHandles = requireHandles(none.captured);
		// The SAME object reference: identity never walks the value, so nothing is stored.
		expect(await noneHandles.redact(payload)).toBe(payload);
		expect(await noneHandles.rehydrate(payload)).toBe(payload);

		const raw = capture();
		createClaw({
			audit,
			database: memoryAdapter(),
			model: textModel("done"),
			plugins: [raw.plugin],
			redaction: { posture: "raw" },
			warn: () => {}, // the expected raw-posture boot warning is not this test's subject
		});
		const rawHandles = requireHandles(raw.captured);
		expect(
			await rawHandles.redact(payload, { clawId: "c1", subjectIds: ["s1"] }),
		).toBe(payload);
		expect(await rawHandles.rehydrate(payload)).toBe(payload);

		expect(
			audit.entries().filter((record) => record.boundary === "privacy"),
		).toHaveLength(0);
	});

	it("subjectIds joins the erasure index: after forgetSubject the plugin token no longer resolves", async () => {
		const { captured, plugin } = capture();
		const claw = owned({
			model: textModel("done"),
			plugins: [plugin],
			redaction: { detectors: [emailDetector], indexKey: "test-key" },
		});
		const { redact, rehydrate } = requireHandles(captured);

		const token = await redact("reach subject@x.com", {
			subjectIds: ["subject-1"],
		});
		expect(token).toMatch(TOKEN);
		expect(await rehydrate(token)).toBe("reach subject@x.com");

		await claw.api.forgetSubject({ subjectId: "subject-1" });

		// Crypto-shredded: the mapping is gone, so the plugin's own token is now inert too.
		expect(await rehydrate(token)).toBe(token);
	});
});
