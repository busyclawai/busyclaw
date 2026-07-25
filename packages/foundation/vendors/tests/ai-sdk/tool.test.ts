import { createGovernance } from "@euroclaw/core";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";
import { tool } from "../../src/ai-sdk/index";

// inputSchema uses the AI SDK's jsonSchema helper (house fixture style): ai@5.0.203's
// FlexibleSchema has no standard-schema branch, so arktype Types are not accepted here.

const toSchema = jsonSchema<{ to: string }>({
	type: "object",
	properties: { to: { type: "string" } },
	required: ["to"],
});

describe("@euroclaw/ai tool() — authoring the canonical descriptor", () => {
	it("returns a descriptor with first-class governance; undefined facts are stripped", () => {
		const t = tool({
			description: "Send an offer letter",
			inputSchema: jsonSchema<{ candidateId: string; salary: number }>({
				type: "object",
				properties: {
					candidateId: { type: "string" },
					salary: { type: "number" },
				},
				required: ["candidateId", "salary"],
			}),
			execute: async ({ candidateId }) => ({ sent: candidateId }),
			access: "write",
			groups: ["hris:all"],
			resource: "Candidate",
			audit: true,
		});
		expect(t.description).toBe("Send an offer letter");
		expect(t.governance).toEqual({
			access: "write",
			groups: ["hris:all"],
			resource: "Candidate",
			audit: true,
		});
		// no undefined keys leak into the stamp — absent means absent (fail-closed default owns it)
		expect("gate" in t.governance).toBe(false);
		expect("effect" in t.governance).toBe(false);
		// the executable is behind the invocation tag: in-process code, un-storable
		expect(t.invocation.kind).toBe("local");
		// presence is not a governance fact and not stated by default — the door the tool is handed
		// to defaults it (host tools → always, plugin tools → discoverable)
		expect(t.presence).toBeUndefined();
		expect("presence" in t.governance).toBe(false);
	});

	it("presence is authored beside the facts, and stays off the stamp", () => {
		const t = tool({
			description: "Read a record",
			inputSchema: toSchema,
			execute: async () => 1,
			access: "read",
			presence: "discoverable",
		});
		expect(t.presence).toBe("discoverable");
		expect(t.governance).toEqual({ access: "read" });
	});

	it("governance facts never leak onto the descriptor's top level", () => {
		const t = tool({
			description: "Read a record",
			inputSchema: toSchema,
			execute: async () => 1,
			access: "read",
		});
		expect("access" in t).toBe(false);
		expect(t.governance.access).toBe("read");
	});

	it("the stamped gate decides at the governance chokepoint", async () => {
		let ran = false;
		const t = tool({
			description: "Send email",
			inputSchema: toSchema,
			execute: async () => {
				ran = true;
				return { ok: true };
			},
			gate: () => ({ decision: "deny", reason: "external send blocked" }),
		});
		const core = createGovernance({
			runTool: () => {
				ran = true;
				return {};
			},
		});
		// wire the gate the way the runtime does: read the descriptor's governance field
		const gate = t.governance.gate;
		if (!gate) throw new Error("expected a stamped gate");
		core.registerGate({
			id: "tool:send_email",
			matcher: (call) => call.name === "send_email",
			handler: gate,
		});
		const r = await core.handleToolCall({
			name: "send_email",
			args: { to: "a@b.c" },
		});
		expect(r.status).toBe("denied");
		expect(ran).toBe(false);
	});
});

describe("standardSchema — arktype as inputSchema via the JSON-Schema bridge", () => {
	it("emits the provider-facing JSON Schema and validates through the arktype Type", async () => {
		const { standardSchema } = await import("../../src/ai-sdk/index");
		const { type } = await import("arktype");
		const s = standardSchema(type({ amount: "number", to: "string" }));
		expect(s.jsonSchema).toMatchObject({
			type: "object",
			required: expect.arrayContaining(["amount", "to"]),
		});
		expect(s.validate?.({ amount: 5, to: "a@b.c" })).toMatchObject({
			success: true,
			value: { amount: 5, to: "a@b.c" },
		});
		expect(s.validate?.({ amount: "five" })).toMatchObject({ success: false });
	});

	it("works as a tool() inputSchema end to end", async () => {
		const { standardSchema, tool: euroTool } = await import(
			"../../src/ai-sdk/index"
		);
		const { type } = await import("arktype");
		const t = euroTool({
			description: "refund",
			inputSchema: standardSchema(type({ amount: "number" })),
			execute: async ({ amount }) => ({ refunded: amount }),
			access: "write",
		});
		expect(t.governance.access).toBe("write");
		expect(t.inputSchema).toBeDefined();
	});
});

describe("tool() inputSchema auto-detection", () => {
	it("accepts an arktype Type directly and bridges it", async () => {
		const { tool: euroTool } = await import("../../src/ai-sdk/index");
		const { type } = await import("arktype");
		const t = euroTool({
			description: "refund",
			inputSchema: type({ amount: "number" }),
			execute: async ({ amount }) => ({ refunded: amount }),
			access: "write",
		});
		const schema = t.inputSchema as {
			jsonSchema?: unknown;
			validate?: (v: unknown) => unknown;
		};
		expect(schema.jsonSchema).toMatchObject({ type: "object" });
		expect(schema.validate?.({ amount: 3 })).toMatchObject({ success: true });
		expect(schema.validate?.({ amount: "x" })).toMatchObject({
			success: false,
		});
	});

	it("fails LOUD for a standard-schema vendor with cannot emit JSON Schema", async () => {
		const { tool: euroTool } = await import("../../src/ai-sdk/index");
		const fake = { "~standard": { version: 1, vendor: "valibot" } };
		expect(() =>
			euroTool({
				description: "x",
				inputSchema: fake as never,
				execute: async () => 0,
			}),
		).toThrow(/cannot emit JSON Schema/);
	});
});
