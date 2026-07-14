// slice-0 proof: the governance FLOOR is assembly-internal and ALWAYS-ON. A claw with ZERO policy
// config is governed by SYSTEM_POSTURE (reads run; an unconfirmed autonomous write → needs-approval),
// and a `cedar({ policies })` SOURCE merges UNDER the sealed floor (`forbid` wins over the floor's
// permit; a source `permit` cannot punch through the floor's forbid). No `cedar()` is connected for
// the engine here — the engine is the assembly's; `cedar()` only contributes policy TEXT.

import { cedar } from "@euroclaw/policy-cedar";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import { durableRedactor, type V2Model } from "./fixtures";

/** A mock model that calls `toolName` once (step 0), then answers "done" (step 1). */
function toolCallModel(toolName: string): V2Model {
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
							type: "tool-call" as const,
							toolCallId: "c1",
							toolName,
							input: "{}",
						},
					],
					finishReason: { unified: "tool-calls" as const, raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text" as const, text: "done" }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			throw new Error("stream not used");
		},
	};
}

const classedTool = (access: "read" | "write", onRun: () => void) =>
	govern(
		tool({
			description: `${access} a doc`,
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
			}),
			execute: async () => {
				onRun();
				return { ok: true };
			},
		}),
		{ access },
	);

const runCtx = { principal: "alice" };

describe("createClaw authz floor (slice 0)", () => {
	it("zero-source claw: a read-class action runs, an unconfirmed autonomous write → needs-approval", async () => {
		// A read: the floor permits reads unconditionally → the tool runs, the run completes.
		let readRan = false;
		const { db: readDb, redactor: readRedactor } = durableRedactor();
		const readClaw = createClaw({
			database: readDb,
			redaction: { redactor: readRedactor },
			model: toolCallModel("readDoc"),
			tools: { readDoc: classedTool("read", () => (readRan = true)) },
		});
		const readResult = await readClaw.api.run({ prompt: "read", ctx: runCtx });
		expect(readResult.status).toBe("completed");
		expect(readRan).toBe(true);

		// A write, run autonomously (the default): the floor forbids an unconfirmed autonomous write,
		// but confirmation WOULD unblock it → needs-approval, and the tool never ran.
		let writeRan = false;
		const { db: writeDb, redactor: writeRedactor } = durableRedactor();
		const writeClaw = createClaw({
			database: writeDb,
			redaction: { redactor: writeRedactor },
			model: toolCallModel("writeDoc"),
			tools: { writeDoc: classedTool("write", () => (writeRan = true)) },
		});
		const writeResult = await writeClaw.api.run({ prompt: "write", ctx: runCtx });
		expect(writeResult.status).toBe("waiting_approval");
		expect(writeRan).toBe(false);
	});

	it("a cedar({ policies }) source merges UNDER the floor: forbid wins, permit can't punch through", async () => {
		// A source FORBID on a read wins over the floor's permit-reads → denied, the tool never ran.
		// (The run completes: the model sees the tool denial and answers.)
		let readRan = false;
		const { db: readDb, redactor: readRedactor } = durableRedactor();
		const forbidClaw = createClaw({
			database: readDb,
			redaction: { redactor: readRedactor },
			model: toolCallModel("readDoc"),
			tools: { readDoc: classedTool("read", () => (readRan = true)) },
			plugins: [
				cedar({
					policies: `forbid(principal, action == Action::"readDoc", resource);`,
				}),
			],
		});
		const forbidResult = await forbidClaw.api.run({ prompt: "read", ctx: runCtx });
		expect(forbidResult.status).toBe("completed");
		expect(readRan).toBe(false);

		// A source PERMIT on a write cannot punch through the floor's forbid on an unconfirmed
		// autonomous write → still needs-approval, the tool never ran.
		let writeRan = false;
		const { db: writeDb, redactor: writeRedactor } = durableRedactor();
		const permitClaw = createClaw({
			database: writeDb,
			redaction: { redactor: writeRedactor },
			model: toolCallModel("writeDoc"),
			tools: { writeDoc: classedTool("write", () => (writeRan = true)) },
			plugins: [
				cedar({
					policies: `permit(principal, action == Action::"writeDoc", resource);`,
				}),
			],
		});
		const permitResult = await permitClaw.api.run({
			prompt: "write",
			ctx: runCtx,
		});
		expect(permitResult.status).toBe("waiting_approval");
		expect(writeRan).toBe(false);
	});
});
