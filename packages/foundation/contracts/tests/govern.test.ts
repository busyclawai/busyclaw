// govern() as the ADOPTION door: a foreign tool becomes the canonical descriptor. What is asserted
// here is the shape the rest of the system now depends on — governance as a FIELD (nothing to read
// back off an erasable stamp) and an invocation that NAMES how the tool runs.

import { describe, expect, it } from "vitest";
import { govern, type ToolDefinition } from "../src/index";

const plain = {
	description: "Send an email.",
	inputSchema: { type: "object", properties: { to: { type: "string" } } },
	execute: async () => ({ sent: true }),
};

describe("govern() — adopting a foreign tool as a descriptor", () => {
	it("puts governance in a field and the closure behind a `local` invocation", () => {
		const descriptor = govern(plain, { access: "write", groups: ["mail"] });
		expect(descriptor.governance).toEqual({
			access: "write",
			groups: ["mail"],
		});
		expect(descriptor.invocation.kind).toBe("local");
		expect(descriptor.invocation.execute).toBe(plain.execute);
		// `presence` is left UNSTATED unless the author says so — the door the descriptor is handed
		// to owns the default (host `tools` → always, `plugin.tools` → discoverable), and stamping
		// one here would silently make the other door wrong.
		expect(descriptor.presence).toBeUndefined();
		expect(govern(plain, {}, { presence: "discoverable" }).presence).toBe(
			"discoverable",
		);
		// The executable is NOT a top-level field: the model-facing projection is an allowlist over
		// description/inputSchema, so nothing else can leak by being forgotten.
		expect("execute" in descriptor).toBe(false);
	});

	it("carries the input schema through untouched — stated once, read three ways", () => {
		const descriptor = govern(plain, {});
		expect(descriptor.inputSchema).toBe(plain.inputSchema);
	});

	it("fails LOUD without a static description — the model's only interface to the tool", () => {
		expect(() =>
			govern(
				{ inputSchema: {}, execute: async () => 0 } as unknown as {
					inputSchema: unknown;
					execute: () => Promise<number>;
				},
				{},
			),
		).toThrow(/needs a static description/);
	});

	it("fails LOUD on a vendor's per-call description function — it has no static value", () => {
		// The AI SDK allows a description computed from a call context euroclaw does not have.
		// Invoking it with a fabricated context would be a guess; dropping it silently would ship a
		// tool the model cannot read. Restate it explicitly instead.
		expect(() =>
			govern(
				{
					description: () => "computed later",
					inputSchema: {},
					execute: async () => 0,
				},
				{},
			),
		).toThrow(/needs a static description/);
	});

	it("what it returns IS the canonical definition — no adapter in between", () => {
		const descriptor: ToolDefinition = govern(plain, { access: "read" });
		expect(descriptor.governance.access).toBe("read");
	});
});
