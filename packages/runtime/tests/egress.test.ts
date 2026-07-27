import { describe, expect, it, vi } from "vitest";

// The range/floor logic is tested in @busyclaw/egress. This suite covers ONLY the runtime shim:
// that it binds node:dns as the default resolver, and that an injected lookup still overrides it.
// Mock node:dns so the default path is exercised without real DNS.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import {
	assertEgressAllowed,
	type EgressLookup,
} from "../src/tools/invoke/egress";

describe("runtime egress shim — binds node:dns as the default resolver", () => {
	it("resolves a named host via node:dns when no lookup is injected", async () => {
		const decision = await assertEgressAllowed("https://example.com/x");
		expect(decision.pinnedAddress).toBe("93.184.216.34");
		expect(decision.family).toBe(4);
	});

	it("an injected lookup overrides the node default", async () => {
		const lookup: EgressLookup = async () => [
			{ address: "8.8.8.8", family: 4 },
		];
		const decision = await assertEgressAllowed("https://example.com/x", {
			lookup,
		});
		expect(decision.pinnedAddress).toBe("8.8.8.8");
	});
});
