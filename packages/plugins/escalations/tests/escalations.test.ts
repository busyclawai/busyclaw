// The escalate annotation, end to end through a REAL assembled claw: a policy names who to ask, a
// governed call doesn't go through, and the host's `onEscalate` hears about it — with the target
// byte-for-byte as the policy wrote it. The declaration and the policy come from DIFFERENT plugins
// here (escalations() declares the key, cedar() writes the rule), which is the seam's whole point.

import type { BusyclawPlugin } from "@busyclaw/contracts";
import { userPrincipal } from "@busyclaw/contracts";
import { createStoredRedactor, noopDetector } from "@busyclaw/core";
import { cedar } from "@busyclaw/policy-cedar";
import { memoryAdapter } from "@busyclaw/storage-core";
import { createPiiMappingStore } from "@busyclaw/storage-durable";
import { jsonSchema, tool, type wrapLanguageModel } from "ai";
import { createClaw, govern } from "busyclaw";
import { describe, expect, it } from "vitest";
import { type Escalation, escalations } from "../src/index";

type V2Model = Parameters<typeof wrapLanguageModel>[0]["model"];

/**
 * A mock model that calls `toolName`, then answers "done" once a result comes back. STATELESS — it
 * reads the incoming messages rather than counting calls, because a parked run consumes exactly one
 * model call, so a shared counter would make the SECOND run through the same claw skip the tool
 * entirely and just answer.
 */
function toolCallModel(toolName: string): V2Model {
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
		doGenerate: async ({ prompt }) =>
			prompt.every((message) => message.role !== "tool")
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
	plugins: readonly BusyclawPlugin<"no-cron">[];
	onRun?: () => void;
	/** The host's one operator-notice door — what a failing observer is reported through. */
	warn?: (message: string) => void;
}) {
	const db = memoryAdapter();
	return createClaw({
		database: db,
		model: toolCallModel(input.toolName),
		...(input.warn ? { warn: input.warn } : {}),
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

/** The same refusal, written for BOTH readers: the host is told who, the agent is told what to do. */
const escalatingForbidWithGuidance = (target: string, guidance: string) =>
	cedar({
		name: "escalate:forbid",
		policies: `@escalate("${target}")
@guidance("${guidance}")
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

	it("the guidance this plugin also declares goes to the AGENT — never through onEscalate", async () => {
		// Both keys are declared by the same plugin and written on the same rule, so this is the case
		// that would break if `audience` were documentation rather than a wall: the router must see
		// its own target and nothing else, while the model gets the sentence written for it.
		const routed: Escalation[] = [];
		const guidance = "Ask the doc owner to grant you read access first.";
		const claw = clawWith({
			toolName: "read_doc",
			access: "read",
			plugins: [
				escalations({ onEscalate: (e) => void routed.push(e) }),
				escalatingForbidWithGuidance("workday:dept_456", guidance),
			],
		});

		expect((await claw.api.generate({ prompt: "read" }, caller)).status).toBe(
			"completed",
		);
		expect(routed).toHaveLength(1);
		expect(routed[0]?.target).toBe("workday:dept_456");
		// The Escalation is the HOST's view: guidance is not part of it, under any key.
		expect(JSON.stringify(routed[0])).not.toContain(guidance);
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

	it("a throwing onEscalate does NOT fail the run — it warns through the HOST's door", async () => {
		const warnings: string[] = [];
		let ran = false;
		const claw = clawWith({
			toolName: "write_doc",
			access: "write",
			onRun: () => {
				ran = true;
			},
			// The plugin takes no warn of its own: the door is `createClaw({ warn })`, threaded through
			// the runtime and governance into the after-gate handler. A host configures one door, once.
			warn: (message: string) => void warnings.push(message),
			plugins: [
				escalations({
					onEscalate: () => {
						throw new Error("pager is down");
					},
				}),
				escalatingPark("betterauth:team_eng"),
			],
		});

		// The router runs inside governance's `finally`: an escaping throw would surface as the run's
		// failure and mask the real outcome. The park has to survive its own notification failing.
		const result = await claw.api.generate({ prompt: "write" }, caller);
		expect(result.status).toBe("waiting_approval");
		expect(ran).toBe(false);
		// The ESCALATION warning specifically, not "how many things warned" — the door is shared, so a
		// total count makes this test fail whenever anything unrelated writes to it.
		const escalation = warnings.filter((message) =>
			message.includes("pager is down"),
		);
		expect(escalation).toHaveLength(1);
		expect(escalation[0]).toContain("betterauth:team_eng");
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

		// Through a CLAW (not an ad-hoc generate), because that is what makes the run RECORDED: only a
		// recorded run stamps clawId/threadId, and only a recorded run's approval checkpoint carries
		// them back. The run id is not part of that difference — see the ad-hoc case below.
		const record = await built.api.createClaw({ name: "router" }, caller);
		const thread = await built.api.createThread({ clawId: record.id }, caller);
		const result = await built.api.sendMessage(
			{ clawId: record.id, threadId: thread.id, message: "write" },
			caller,
		);
		if (!result.driven) throw new Error("expected a driven send");
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
		// The same id at the top level, so ONE lookup answers "which approval is this escalation
		// about" whether or not the run was recorded.
		expect(pending[0]?.metadata).toMatchObject({ runId: seen?.runId });
	});

	// The ad-hoc half of the same question. A `generate` has no claw and no thread — legitimately, it
	// is not a conversation — so it stamps neither, and nothing here pretends otherwise. What it DOES
	// have is a run: the runtime mints an id for every invocation, stamps it on the gated call, and
	// writes it onto the row a parked call leaves behind. Without that, a host holding an escalation
	// from this path had principal + tool name and no way to reach the approval it must resolve.
	it("an ad-hoc generate is correlatable: one runId on the escalation AND the approval", async () => {
		const routed: Escalation[] = [];
		const claw = clawWith({
			toolName: "write_doc",
			access: "write",
			plugins: [
				escalations({ onEscalate: (e) => void routed.push(e) }),
				escalatingPark("betterauth:team_eng"),
			],
		});

		// Two runs, so the join has to be exact rather than "the only pending row".
		expect((await claw.api.generate({ prompt: "write" }, caller)).status).toBe(
			"waiting_approval",
		);
		expect((await claw.api.generate({ prompt: "write" }, caller)).status).toBe(
			"waiting_approval",
		);
		expect(routed).toHaveLength(2);

		const pending = await claw.api.listApprovals({ status: "pending" }, caller);
		expect(pending).toHaveLength(2);
		for (const escalation of routed) {
			// No claw, no thread: an ad-hoc run has neither, and inventing them would be a lie.
			expect(escalation.clawId).toBeUndefined();
			expect(escalation.threadId).toBeUndefined();
			expect(escalation.runId).toBeTypeOf("string");
			const matched = pending.filter(
				(approval) =>
					(approval.metadata as { runId?: string } | undefined)?.runId ===
					escalation.runId,
			);
			expect(matched).toHaveLength(1);
			expect(matched[0]?.toolName).toBe("write_doc");
			// And no recording to fall back on — `metadata.runId` is the only join there is.
			expect(matched[0]?.metadata).not.toHaveProperty("recording");
		}
		// Two runs, two ids: the id identifies the run, not the tool or the principal.
		expect(routed[0]?.runId).not.toBe(routed[1]?.runId);
	});
});
