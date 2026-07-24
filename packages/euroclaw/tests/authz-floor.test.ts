// slice-0 proof: the governance FLOOR is assembly-internal and ALWAYS-ON. A claw with ZERO policy
// config is governed by SYSTEM_POSTURE (reads run; an unconfirmed autonomous write → needs-approval),
// and a `cedar({ policies })` SOURCE merges UNDER the sealed floor (`forbid` wins over the floor's
// permit; a source `permit` cannot punch through the floor's forbid). No `cedar()` is connected for
// the engine here — the engine is the assembly's; `cedar()` only contributes policy TEXT.

import { createMemoryAudit } from "@euroclaw/core";
import { cedar } from "@euroclaw/policy-cedar";
import { runtimeRunOptionsWithCaller } from "@euroclaw/runtime";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createClaw, govern } from "../src/index";
import {
	durableRedactor,
	owned,
	type V2Model,
	withPrincipal,
} from "./fixtures";

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
		const readClaw = owned({
			database: readDb,
			redaction: { redactor: readRedactor },
			model: toolCallModel("readDoc"),
			tools: { readDoc: classedTool("read", () => (readRan = true)) },
		});
		const readResult = await readClaw.api.generate({ prompt: "read", ctx: runCtx });
		expect(readResult.status).toBe("completed");
		expect(readRan).toBe(true);

		// A write, run autonomously (the default): the floor forbids an unconfirmed autonomous write,
		// but confirmation WOULD unblock it → needs-approval, and the tool never ran.
		let writeRan = false;
		const { db: writeDb, redactor: writeRedactor } = durableRedactor();
		const writeClaw = owned({
			database: writeDb,
			redaction: { redactor: writeRedactor },
			model: toolCallModel("writeDoc"),
			tools: { writeDoc: classedTool("write", () => (writeRan = true)) },
		});
		const writeResult = await writeClaw.api.generate({ prompt: "write", ctx: runCtx });
		expect(writeResult.status).toBe("waiting_approval");
		expect(writeRan).toBe(false);
	});

	it("a cedar({ policies }) source merges UNDER the floor: forbid wins, permit can't punch through", async () => {
		// A source FORBID on a read wins over the floor's permit-reads → denied, the tool never ran.
		// (The run completes: the model sees the tool denial and answers.)
		let readRan = false;
		const { db: readDb, redactor: readRedactor } = durableRedactor();
		const forbidClaw = owned({
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
		const forbidResult = await forbidClaw.api.generate({ prompt: "read", ctx: runCtx });
		expect(forbidResult.status).toBe("completed");
		expect(readRan).toBe(false);

		// A source PERMIT on a write cannot punch through the floor's forbid on an unconfirmed
		// autonomous write → still needs-approval, the tool never ran.
		let writeRan = false;
		const { db: writeDb, redactor: writeRedactor } = durableRedactor();
		const permitClaw = owned({
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
		const permitResult = await permitClaw.api.generate({
			prompt: "write",
			ctx: runCtx,
		});
		expect(permitResult.status).toBe("waiting_approval");
		expect(writeRan).toBe(false);
	});
});

// Audit #7 — one principal, resolved once, one read. The tool floor's `cedarMapCall` authorizes as the
// ONE stamped `euroclaw__principal` (seeded by the trusted assembly from the authenticated caller), NEVER
// the caller-controllable unprefixed `ctx.principal`. Pre-fix, a forged `ctx.principal` drove the Cedar
// decision while audit recorded the stamped one — decision ≠ record, an impersonation with a divergent
// audit trail. These prove the divergence is closed.
describe("identity seam — audit #7 (the stamped principal is the ONE the floor reads)", () => {
	it("a forged ctx.principal does NOT drive the decision; audit records the stamped principal", async () => {
		// The inverted #7 repro: a FORGED unprefixed `principal: "admin"` in the ctx, next to the stamped
		// `euroclaw__principal: "user:bob"` the caller seeds. A slice FORBIDS bob's read (but would let the
		// forged admin read, since SYSTEM_POSTURE permits reads for any principal).
		let readRan = false;
		const audit = createMemoryAudit();
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			redaction: { redactor },
			audit,
			model: toolCallModel("readDoc"),
			tools: { readDoc: classedTool("read", () => (readRan = true)) },
			plugins: [
				cedar({
					policies: `forbid(principal == User::"user:bob", action == Action::"readDoc", resource);`,
				}),
			],
		});
		// `$context.runtime` runs the SAME assembled floor; the ctx carries the forged `admin`, the caller
		// option seeds the trusted `user:bob` (post-stripReserved, spoof-proof).
		const result = await claw.$context.runtime.generate(
			"read",
			{ principal: "admin" },
			runtimeRunOptionsWithCaller(undefined, "user:bob"),
		);
		// DENIED — the mapper used the STAMPED bob (whom the forbid targets), not the forged admin (whom
		// the floor would have let read). Pre-fix (mapper read `ctx.principal`), this read would have RUN.
		expect(result.status).toBe("completed");
		expect(readRan).toBe(false);
		// …and the audit recorded bob — the SAME identity the decision was made as (no divergence).
		const readEntry = audit.entries().find((entry) => entry.name === "readDoc");
		expect(readEntry?.status).toBe("denied");
		expect(readEntry?.principal).toBe("user:bob");
	});

	it("the caller of a run becomes the floor's principal (the seed, end-to-end through the api)", async () => {
		// No identity resolver — the ONLY principal source is the authenticated api caller. A slice forbids
		// that caller's read, so the read denying PROVES the caller became the floor's PARC principal.
		let readRan = false;
		const audit = createMemoryAudit();
		const { db, redactor } = durableRedactor();
		const claw = withPrincipal(
			createClaw({
				database: db,
				redaction: { redactor },
				audit,
				model: toolCallModel("readDoc"),
				tools: { readDoc: classedTool("read", () => (readRan = true)) },
				plugins: [
					cedar({
						policies: `forbid(principal == User::"user:alice", action == Action::"readDoc", resource);`,
					}),
				],
			}),
			"user:alice",
		);
		// The api caller `{ principal: "user:alice" }` (injected by withPrincipal at arg index 1) is seeded
		// as `euroclaw__principal` in the trusted context assembly.
		const result = await claw.api.generate({ prompt: "read", ctx: {} });
		expect(result.status).toBe("completed");
		expect(readRan).toBe(false);
		const readEntry = audit.entries().find((entry) => entry.name === "readDoc");
		expect(readEntry?.principal).toBe("user:alice");
	});

	it("no stamped principal → the floor fails CLOSED (a modeled action is refused)", async () => {
		// No caller, no identity resolver → nothing seeds `euroclaw__principal`. The mapper refuses to
		// build a request for nobody, so even a floor-permitted read is refused (fail-closed, not permit).
		let readRan = false;
		const { db, redactor } = durableRedactor();
		const claw = createClaw({
			database: db,
			redaction: { redactor },
			model: toolCallModel("readDoc"),
			tools: { readDoc: classedTool("read", () => (readRan = true)) },
		});
		await expect(
			claw.$context.runtime.generate("read", {}),
		).rejects.toThrow(/no stamped principal/);
		expect(readRan).toBe(false);
	});
});
