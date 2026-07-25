// The escalate annotation, end to end through a REAL assembled claw: a policy names who to ask, a
// governed call doesn't go through, and the host's `onEscalate` hears about it — with the target
// byte-for-byte as the policy wrote it. The declaration and the policy come from DIFFERENT plugins
// here (escalations() declares the key, cedar() writes the rule), which is the seam's whole point.

import type { EuroclawPlugin } from "@euroclaw/contracts";
import { userPrincipal } from "@euroclaw/contracts";
import { createStoredRedactor, noopDetector } from "@euroclaw/core";
import { cedar } from "@euroclaw/policy-cedar";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createPiiMappingStore } from "@euroclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { createClaw, govern } from "euroclaw";
import { describe, expect, it } from "vitest";
import { type Escalation, escalations } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/** A mock model that calls `toolName` once (step 0), then answers "done" (step 1). */
function toolCallModel(toolName: string): V2Model {
	let step = 0;
	const usage = {
		inputTokens: {
			total: 1,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: undefined, reasoning: undefined },
	};
	return {
		specificationVersion: "v4",
		provider: "mock",
		modelId: "mock",
		supportedUrls: {},
		doGenerate: async () =>
			step++ === 0
				? {
						content: [
							{
								type: "tool-call" as const,
								toolCallId: "c1",
								toolName,
								input: "{}",
							},
						],
						finishReason: { unified: "tool-calls" as const, raw: undefined },
						usage,
						warnings: [],
					}
				: {
						content: [{ type: "text" as const, text: "done" }],
						finishReason: { unified: "stop" as const, raw: undefined },
						usage,
						warnings: [],
					},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

const caller = { principal: userPrincipal("actor-1") };

type Claw = ReturnType<typeof clawWith>;

/** One governed tool, one mock model calling it, one claw — the smallest thing the floor decides on. */
function clawWith(input: {
	toolName: string;
	access: "read" | "write";
	// `"no-cron"` so the flag survives the helper: erasing it to the default union would make
	// createClaw ask this test for a cronHandler.
	plugins: readonly EuroclawPlugin<"no-cron">[];
	onRun?: () => void;
}) {
	const db = memoryAdapter();
	return createClaw({
		database: db,
		model: toolCallModel(input.toolName),
		redaction: {
			redactor: createStoredRedactor({
				detector: noopDetector,
				mappings: createPiiMappingStore(db),
			}),
		},
		plugins: input.plugins,
		tools: {
			[input.toolName]: govern(
				tool({
					description: `${input.access} a doc`,
					inputSchema: jsonSchema<Record<string, never>>({
						type: "object",
						properties: {},
					}),
					execute: async () => {
						input.onRun?.();
						return { ok: true };
					},
				}),
				{ access: input.access },
			),
		},
	});
}

/** The rule that PARKS an autonomous write and says who to ask — the probe's determining policy. */
const escalatingPark = (target: string) =>
	cedar({
		name: "escalate:park",
		policies: `@escalate("${target}")
permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };`,
	});

/** The rule that REFUSES outright and says who to ask — "you cannot, ask them". */
const escalatingForbid = (target: string) =>
	cedar({
		name: "escalate:forbid",
		policies: `@escalate("${target}")
forbid(principal, action == Action::"read_doc", resource);`,
	});

describe("escalations() — the escalate annotation reaches the host", () => {
	it("a parked call routes the policy's target, verbatim", async () => {
		const routed: Escalation[] = [];
		let ran = false;
		const claw = clawWith({
			toolName: "write_doc",
			access: "write",
			onRun: () => {
				ran = true;
			},
			plugins: [
				escalations({ onEscalate: (e) => void routed.push(e) }),
				escalatingPark("betterauth:team_eng"),
			],
		});

		// An autonomous write parks (the floor forbids an unconfirmed autonomous write, and the slice
		// would permit it once confirmed) — so the slice DECIDES the probe, and its @escalate rides out.
		const result = await claw.api.generate({ prompt: "write" }, caller);
		expect(result.status).toBe("waiting_approval");
		expect(ran).toBe(false);
		expect(routed).toHaveLength(1);
		const escalation = routed[0];
		// Opaque and whole: an authority-tagged id, never split on the colon, never re-tagged.
		expect(escalation?.target).toBe("betterauth:team_eng");
		expect(escalation).toMatchObject({
			boundary: "tool",
			name: "write_doc",
			status: "needs-approval",
			principal: "user:actor-1",
			// The fact that makes this worth routing: nobody is watching an autonomous run.
			runMode: "autonomous",
		});
		expect(escalation?.gateId).toBeTypeOf("string");
		expect(escalation?.reason).toBeTypeOf("string");
	});

	it("a DENY escalates too — @escalate on a forbid means 'you cannot, ask them'", async () => {
		const routed: Escalation[] = [];
		let ran = false;
		const claw = clawWith({
			toolName: "read_doc",
			access: "read",
			onRun: () => {
				ran = true;
			},
			plugins: [
				escalations({ onEscalate: (e) => void routed.push(e) }),
				escalatingForbid("workday:dept_456"),
			],
		});

		// The source forbid wins over the floor's permit-reads; the model sees the denial and answers.
		const result = await claw.api.generate({ prompt: "read" }, caller);
		expect(result.status).toBe("completed");
		expect(ran).toBe(false);
		expect(routed).toHaveLength(1);
		expect(routed[0]).toMatchObject({
			target: "workday:dept_456",
			status: "denied",
			name: "read_doc",
		});
	});

	it("no escalate annotation → onEscalate never fires (a park, and a permitted call)", async () => {
		const routed: Escalation[] = [];
		const parked = clawWith({
			toolName: "write_doc",
			access: "write",
			plugins: [escalations({ onEscalate: (e) => void routed.push(e) })],
		});
		// Parks on the floor alone — a real needs-approval, with no annotated policy behind it.
		expect(
			(await parked.api.generate({ prompt: "write" }, caller)).status,
		).toBe("waiting_approval");

		let ran = false;
		const permitted = clawWith({
			toolName: "read_doc",
			access: "read",
			onRun: () => {
				ran = true;
			},
			plugins: [escalations({ onEscalate: (e) => void routed.push(e) })],
		});
		expect(
			(await permitted.api.generate({ prompt: "read" }, caller)).status,
		).toBe("completed");
		expect(ran).toBe(true);
		expect(routed).toEqual([]);
	});

	it("a throwing onEscalate does NOT fail the run — it warns", async () => {
		const warnings: string[] = [];
		let ran = false;
		const claw = clawWith({
			toolName: "write_doc",
			access: "write",
			onRun: () => {
				ran = true;
			},
			plugins: [
				escalations({
					onEscalate: () => {
						throw new Error("pager is down");
					},
					warn: (message) => void warnings.push(message),
				}),
				escalatingPark("betterauth:team_eng"),
			],
		});

		// The router runs inside governance's `finally`: an escaping throw would surface as the run's
		// failure and mask the real outcome. The park has to survive its own notification failing.
		const result = await claw.api.generate({ prompt: "write" }, caller);
		expect(result.status).toBe("waiting_approval");
		expect(ran).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("betterauth:team_eng");
		expect(warnings[0]).toContain("pager is down");
	});

	// The ordering worth pinning down: an escalation carries NO approval id, and the reason is not that
	// it runs too early. Governance keeps its sealed after-gates (audit, approval) ahead of every
	// plugin's, so the row is already persisted by the time the router runs — `approvalGate` simply
	// discards what `store.create` returns, and nothing carries the id to a later after-gate. The host
	// correlates instead, and this pins down what it correlates ON.
	it("the parked approval already exists when the router runs — and the recording ids join them", async () => {
		let seen: Escalation | undefined;
		let pending: Awaited<ReturnType<Claw["api"]["listApprovals"]>> = [];
		let claw: Claw | undefined;
		const built = clawWith({
			toolName: "write_doc",
			access: "write",
			plugins: [
				escalations({
					onEscalate: async (escalation) => {
						seen = escalation;
						pending =
							(await claw?.api.listApprovals({ status: "pending" }, caller)) ??
							[];
					},
				}),
				escalatingPark("betterauth:team_eng"),
			],
		});
		claw = built;

		// Through a CLAW (not an ad-hoc generate), because that is what makes the run recorded: only a
		// recorded run stamps clawId/threadId, and only a recorded run's approval checkpoint carries
		// them back. An ad-hoc `generate` has neither side — its escalation correlates on nothing
		// sharper than principal + tool name.
		const record = await built.api.createClaw({ name: "router" }, caller);
		const thread = await built.api.createThread({ clawId: record.id }, caller);
		const result = await built.api.sendMessage(
			{ clawId: record.id, threadId: thread.id, message: "write" },
			caller,
		);
		expect(result.result.status).toBe("waiting_approval");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.toolName).toBe("write_doc");
		expect(seen?.clawId).toBe(record.id);
		expect(seen?.threadId).toBe(thread.id);
		expect(seen?.runId).toBeTypeOf("string");
		expect(pending[0]?.metadata).toMatchObject({
			recording: {
				clawId: seen?.clawId,
				threadId: seen?.threadId,
				runId: seen?.runId,
			},
		});
	});
});
