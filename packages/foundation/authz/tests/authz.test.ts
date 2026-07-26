import type {
	PolicyEngine,
	PolicyRequest,
	PolicyResult,
	ToolCall,
} from "@euroclaw/contracts";
import { govern } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	actionInputsFromTools,
	buildAuthzModel,
	createPolicyPlugin,
} from "../src/index";

// Unit-level: exercises the gate the plugin contributes directly (the full pipeline path is
// covered by @euroclaw/policy-cedar's integration tests through createGovernance).

const fakeEngine = (
	decide: (action: string) => PolicyResult,
): PolicyEngine => ({
	authorize: (req) => decide(req.action.id),
});

const mapCall = (
	call: ToolCall,
	_ctx: Record<string, never>,
): PolicyRequest => ({
	principal: { type: "User", id: "alice" },
	action: { type: "Action", id: call.name },
	resource: { type: "Tool", id: call.name },
	context: { args: call.args },
});

function soleGate(plugin: { gates?: readonly unknown[] }) {
	const gate = plugin.gates?.[0];
	if (!gate) throw new Error("expected the plugin to contribute one gate");
	return gate as {
		id: string;
		sealed?: boolean;
		matcher: (call: ToolCall, ctx: Record<string, unknown>) => boolean;
		handler: (
			call: ToolCall,
			ctx: Record<string, unknown>,
		) => Promise<{ decision: string; reason?: string }>;
	};
}

describe("createPolicyPlugin — the engine→gate scaffolding", () => {
	it("permit maps through untouched", async () => {
		const gate = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({ decision: "permit" })),
				mapCall,
			}),
		);
		const decision = await gate.handler({ name: "pay", args: {} }, {});
		expect(decision).toEqual({ decision: "permit" });
	});

	it("deny folds the determining-policy trail into the reason", async () => {
		const gate = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({
					decision: "deny",
					reason: "over limit",
					policies: ["p7"],
				})),
				mapCall,
			}),
		);
		const decision = await gate.handler({ name: "pay", args: {} }, {});
		expect(decision.decision).toBe("deny");
		expect(decision.reason).toContain("over limit");
		expect(decision.reason).toContain("p7");
	});

	it("deny without a reason gets the deny-by-default one", async () => {
		const gate = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({ decision: "deny" })),
				mapCall,
			}),
		);
		const decision = await gate.handler({ name: "pay", args: {} }, {});
		expect(decision.reason).toContain("no policy permits");
	});

	it("needs-approval surfaces as needs-approval", async () => {
		const gate = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({ decision: "needs-approval" })),
				mapCall,
			}),
		);
		const decision = await gate.handler({ name: "pay", args: {} }, {});
		expect(decision.decision).toBe("needs-approval");
	});

	it("matcher scopes which calls the engine governs; default is every call", () => {
		const scoped = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({ decision: "permit" })),
				mapCall,
				matcher: (call) => call.name === "pay",
			}),
		);
		expect(scoped.matcher({ name: "pay", args: {} }, {})).toBe(true);
		expect(scoped.matcher({ name: "lookup", args: {} }, {})).toBe(false);

		const everything = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({ decision: "permit" })),
				mapCall,
			}),
		);
		expect(everything.matcher({ name: "anything", args: {} }, {})).toBe(true);
	});

	it("a malformed engine result fails LOUD, never open", async () => {
		const gate = soleGate(
			createPolicyPlugin({
				engine: {
					authorize: () => ({ decision: "yes" }) as never,
				},
				mapCall,
			}),
		);
		await expect(gate.handler({ name: "pay", args: {} }, {})).rejects.toThrow(
			/result invalid/,
		);
	});

	it("a malformed mapCall request fails LOUD", async () => {
		const gate = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({ decision: "permit" })),
				mapCall: (() => ({ nope: true })) as never,
			}),
		);
		await expect(gate.handler({ name: "pay", args: {} }, {})).rejects.toThrow(
			/request invalid/,
		);
	});

	it("id and sealed flow onto the contributed gate", () => {
		const gate = soleGate(
			createPolicyPlugin({
				engine: fakeEngine(() => ({ decision: "permit" })),
				mapCall,
				id: "policy:floor",
				sealed: true,
			}),
		);
		expect(gate.id).toBe("policy:floor");
		expect(gate.sealed).toBe(true);
	});
});

describe("buildAuthzModel — facts in, canonical model out", () => {
	it("defaults are fail-closed: no stamp → write access, writes group, Tool resource", () => {
		const model = buildAuthzModel([{ id: "send_email", source: "tool" }]);
		expect(model.actions).toEqual([
			{
				id: "send_email",
				groups: ["writes"],
				resourceType: "Tool",
				access: "write",
				source: "tool",
			},
		]);
		expect(model.groups).toEqual([{ id: "writes" }]);
		expect(model.entityTypes).toEqual([{ type: "Tool" }]);
	});

	it("stamped facts flow through; the access group is derived and deduped", () => {
		const model = buildAuthzModel([
			{
				id: "hris.readEmployee",
				source: "domain",
				governance: {
					access: "read",
					groups: ["hris:all", "reads"],
					resource: "Candidate",
					audit: true,
				},
			},
		]);
		const action = model.actions[0];
		expect(action).toMatchObject({
			access: "read",
			groups: ["hris:all", "reads"],
			resourceType: "Candidate",
			audit: true,
			source: "domain",
		});
	});

	it("a descriptor feeds the model directly — path is the id, governance read as a field", () => {
		const descriptor = {
			// authz is vendor-NEUTRAL: a descriptor's inputSchema is opaque to it, so a plain JSON
			// Schema object stands in for whatever an adapter bridged.
			...govern(
				{
					description: "Read an employee record.",
					inputSchema: { type: "object" },
					execute: async () => 0,
				},
				{ access: "read", groups: ["hris:all"], resource: "Candidate" },
			),
			path: "hris.readEmployee",
		};
		const model = buildAuthzModel(actionInputsFromTools([descriptor]));
		expect(model.actions).toMatchObject([
			{
				id: "hris.readEmployee",
				access: "read",
				groups: ["hris:all", "reads"],
				resourceType: "Candidate",
				source: "tool",
			},
		]);
	});

	it("a tool declaring NO access class is modeled as a WRITE, never omitted", () => {
		// This asserted the opposite until the floor stopped matching on model membership. Omission was
		// never neutral: being absent from the model is what made the floor's gate skip the call, so a
		// forgotten `access` stamp — the single cheapest mistake available — produced a tool that
		// executed with no governance at all. `send_email` is the case that makes it concrete.
		const descriptor = {
			...govern(
				{
					description: "Send an email.",
					inputSchema: { type: "object" },
					execute: async () => 0,
				},
				{ effect: { kind: "external" } },
			),
			path: "send_email",
		};

		expect(actionInputsFromTools([descriptor])).toHaveLength(1);
		// Write is the fail-closed reading of "unstated": under the seeded posture it needs confirmation
		// interactively and is refused autonomously, so an unstamped tool announces itself on first use.
		expect(
			buildAuthzModel(actionInputsFromTools([descriptor])).actions,
		).toMatchObject([
			{ id: "send_email", access: "write", groups: ["writes"] },
		]);
	});

	it("projected args ride along untouched", () => {
		const model = buildAuthzModel([
			{
				id: "payments.refund",
				source: "tool",
				args: { amount: { type: "number" } },
			},
		]);
		expect(model.actions[0]?.args).toEqual({ amount: { type: "number" } });
	});

	it("duplicate action ids fail loud", () => {
		expect(() =>
			buildAuthzModel([
				{ id: "pay", source: "tool" },
				{ id: "pay", source: "domain" },
			]),
		).toThrow(/duplicate action id/);
	});

	it("actions sort by id and the version pins content: same in → same version, change → new version", () => {
		const a = buildAuthzModel([
			{ id: "b", source: "tool" },
			{ id: "a", source: "tool" },
		]);
		const b = buildAuthzModel([
			{ id: "a", source: "tool" },
			{ id: "b", source: "tool" },
		]);
		expect(a.actions.map((x) => x.id)).toEqual(["a", "b"]);
		expect(a.version).toBe(b.version);

		const changed = buildAuthzModel([
			{ id: "a", source: "tool" },
			{ id: "b", source: "domain" },
		]);
		expect(changed.version).not.toBe(a.version);
	});

	it("an explicit version (a spec digest) wins over the content hash", () => {
		const model = buildAuthzModel([{ id: "a", source: "tool" }], {
			version: "sha256:abc",
		});
		expect(model.version).toBe("sha256:abc");
	});
});
