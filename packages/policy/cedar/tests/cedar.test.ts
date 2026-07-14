import { buildAuthzModel } from "@euroclaw/authz";
import type { ToolCall } from "@euroclaw/contracts";
import { createGovernance } from "@euroclaw/core";
import { describe, expect, it } from "vitest";
import { cedarEngine, cedarPolicyPlugin } from "../src/index";

const runEcho = (call: ToolCall) => ({ ran: call.name });

const coreWith = (config: Parameters<typeof cedar>[0]) =>
	createGovernance({ plugins: [cedarPolicyPlugin(config)], runTool: runEcho });

describe("@euroclaw/policy-cedar — Cedar PDP", () => {
	it("permit: a tool with a matching permit policy runs", async () => {
		const core = coreWith({
			policies: `permit(principal, action == Action::"refund", resource);`,
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: { amount: 100 } },
			{ principal: "alice" },
		);
		expect(r.status).toBe("ok");
	});

	it("deny-by-default: a tool with no policy is blocked (allowlist)", async () => {
		const core = coreWith({
			policies: `permit(principal, action == Action::"refund", resource);`,
		});
		const r = await core.handleToolCall(
			{ name: "delete_account", args: {} },
			{ principal: "alice" },
		);
		expect(r.status).toBe("denied");
	});

	it("forbid overrides permit", async () => {
		const core = coreWith({
			policies: `permit(principal, action, resource);\nforbid(principal, action == Action::"refund", resource);`,
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(r.status).toBe("denied");
	});

	it("needs-approval: a confirm-gated policy cannot be satisfied by caller context", async () => {
		const policies = `permit(principal, action == Action::"refund", resource) when { context.confirmationUsed };`;
		const core = coreWith({ policies });

		const unconfirmed = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(unconfirmed.status).toBe("needs-approval");

		const spoofed = { principal: "alice", confirmationUsed: true };
		const confirmed = await core.handleToolCall(
			{ name: "refund", args: {} },
			spoofed,
		);
		expect(confirmed.status).toBe("needs-approval");
	});

	it("ABAC: a tag on the principal decides — assign a tag, the policy sorts it out", async () => {
		const policies = `permit(principal, action, resource) when { principal.hasTag("department") && principal.getTag("department") == "finance" };`;
		const entities = [
			{
				uid: { type: "User", id: "alice" },
				attrs: {},
				parents: [],
				tags: { department: "finance" },
			},
			{
				uid: { type: "User", id: "bob" },
				attrs: {},
				parents: [],
				tags: { department: "sales" },
			},
		];
		const core = createGovernance({
			plugins: [cedarPolicyPlugin({ policies, entities })],
			runTool: runEcho,
		});

		const finance = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(finance.status).toBe("ok");

		const sales = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "bob" },
		);
		expect(sales.status).toBe("denied");
	});

	it("prefix namespaces the resource id as <prefix>:<tool>", async () => {
		const core = coreWith({
			policies: `permit(principal, action, resource == Tool::"agent:refund");`,
			prefix: "agent",
		});
		const r = await core.handleToolCall(
			{ name: "refund", args: {} },
			{ principal: "alice" },
		);
		expect(r.status).toBe("ok");
	});

	it("fails loud at construction on an invalid policy set", () => {
		expect(() => cedarEngine({ policies: `this is not cedar` })).toThrow(
			/invalid Cedar policy set/,
		);
	});

	it("membership: a resolved team role flows into the Cedar context and drives the decision", async () => {
		// a policy that only permits when the actor's resolved role is `approver`
		const policies = `permit(principal, action == Action::"send_offer", resource) when { context.role == "approver" };`;
		// resolveContext stamps euroclaw__role exactly as the claw's `membership` resolver would (the role
		// came from roleMembership({ roleOf: teamStore.roleOf }) — connecting team membership → the decision)
		const asRole = (role: string) =>
			createGovernance({
				plugins: [cedarPolicyPlugin({ policies })],
				resolveContext: (ctx) => ({ ...ctx, euroclaw__role: role }),
				runTool: runEcho,
			});

		const approver = await asRole("approver").handleToolCall(
			{ name: "send_offer", args: {} },
			{ principal: "alice" },
		);
		expect(approver.status).toBe("ok"); // role == approver → permitted

		const operator = await asRole("operator").handleToolCall(
			{ name: "send_offer", args: {} },
			{ principal: "alice" },
		);
		expect(operator.status).toBe("denied"); // role != approver → no permit matches → deny-by-default
	});

	it("organizationId flows from resolution context and cannot be spoofed from caller args", async () => {
		// The router keys on the org; a policy may also condition on it directly.
		const policies = `permit(principal, action == Action::"list_pets", resource) when { context.organizationId == "org-a" };`;
		const inOrg = (organizationId: string) =>
			createGovernance({
				plugins: [cedarPolicyPlugin({ policies })],
				// resolveContext stamps euroclaw__organizationId exactly as the claw's organization resolver would.
				resolveContext: (ctx) => ({
					...ctx,
					euroclaw__organizationId: organizationId,
				}),
				runTool: runEcho,
			});

		const orgA = await inOrg("org-a").handleToolCall(
			{ name: "list_pets", args: {} },
			{ principal: "alice" },
		);
		expect(orgA.status).toBe("ok"); // context.organizationId == "org-a" → permitted

		const orgB = await inOrg("org-b").handleToolCall(
			{ name: "list_pets", args: {} },
			{ principal: "alice" },
		);
		expect(orgB.status).toBe("denied"); // different org → no permit matches

		// A caller cannot forge the org: euroclaw__ keys are stripped before the trusted stamp.
		const unstamped = createGovernance({
			plugins: [cedarPolicyPlugin({ policies })],
			runTool: runEcho,
		});
		const forged = await unstamped.handleToolCall(
			{ name: "list_pets", args: {} },
			{ principal: "alice", euroclaw__organizationId: "org-a" },
		);
		expect(forged.status).toBe("denied"); // stripped → context.organizationId absent → deny
	});
});

describe("model-driven cedar — slice 3", () => {
	const model = buildAuthzModel([
		{
			id: "refund",
			source: "tool",
			governance: { access: "write" },
			args: {
				type: "object",
				properties: {
					amount: { type: "integer" },
					note: { type: "string" },
					price: { type: "number" },
				},
				required: ["amount"],
			},
		},
		{ id: "lookup", source: "tool", governance: { access: "read" } },
	]);

	it("model + schema together fail loud", () => {
		expect(() =>
			cedarPolicyPlugin({
				model,
				schema: "entity X;",
				policies: "permit(principal, action, resource);",
			}),
		).toThrow(/not both/);
	});

	it("the rendered schema parses under cedar-wasm (construction validates it)", () => {
		expect(() =>
			cedarPolicyPlugin({ model, policies: `permit(principal, action, resource);` }),
		).not.toThrow();
	});

	it("quoted group ids and arg property names survive rendering AND parsing (injection hardening)", () => {
		const hostile = buildAuthzModel([
			{
				id: "op",
				source: "tool",
				governance: { access: "write", groups: ['tag:a"b'] },
				args: {
					type: "object",
					properties: { 'wei"rd': { type: "string" } },
				},
			},
		]);
		expect(() =>
			cedarPolicyPlugin({
				model: hostile,
				policies: `permit(principal, action, resource);`,
			}),
		).not.toThrow();
	});

	it("policies condition on projected args; unprojected/unknown args are filtered, not fatal", async () => {
		const core = createGovernance({
			plugins: [
				cedarPolicyPlugin({
					model,
					policies: `permit(principal, action == Action::"refund", resource) when { context.args.amount <= 500 };`,
				}),
			],
			runTool: runEcho,
		});

		const small = await core.handleToolCall(
			// price (float, unprojected) and hack (unknown) must be filtered out — with schema
			// validation ON, their presence would otherwise fail the closed args record.
			{
				name: "refund",
				args: { amount: 100, note: "ok", price: 9.99, hack: "x" },
			},
			{ principal: "alice" },
		);
		expect(small.status).toBe("ok");

		const big = await core.handleToolCall(
			{ name: "refund", args: { amount: 900 } },
			{ principal: "alice" },
		);
		expect(big.status).toBe("denied");
	});

	it('group policies work at evaluation time (action in Action::"writes")', async () => {
		const core = createGovernance({
			plugins: [
				cedarPolicyPlugin({
					model,
					policies: `
						permit(principal, action in Action::"reads", resource);
						permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };
					`,
				}),
			],
			runTool: runEcho,
		});

		const read = await core.handleToolCall(
			{ name: "lookup", args: {} },
			{ principal: "alice" },
		);
		expect(read.status).toBe("ok");

		const write = await core.handleToolCall(
			{ name: "refund", args: { amount: 10 } },
			{ principal: "alice" },
		);
		expect(write.status).toBe("needs-approval");
	});

	it("entities provider is re-read per decision — the reload seam", async () => {
		let department = "sales";
		const engine = cedarEngine({
			policies: `permit(principal, action, resource) when { principal.hasTag("department") && principal.getTag("department") == "finance" };`,
			entities: () => [
				{
					uid: { type: "User", id: "alice" },
					attrs: {},
					parents: [],
					tags: { department },
				},
			],
		});
		const req = {
			principal: { type: "User", id: "alice" },
			action: { type: "Action", id: "refund" },
			resource: { type: "Tool", id: "refund" },
			context: { confirmationUsed: false },
		};
		expect((await engine.authorize(req)).decision).toBe("deny");
		department = "finance"; // the provider's next read reflects the sync
		expect((await engine.authorize(req)).decision).toBe("permit");
	});
});

describe("@euroclaw/policy-cedar — context.server (spoof-proof egress fact)", () => {
	const model = buildAuthzModel([
		{ id: "petstore.getPet", source: "tool", governance: { access: "read" } },
	]);
	const serverPolicy = `permit(principal, action == Action::"petstore.getPet", resource) when { context.server == "https://api.x.com" };`;

	it("stamps context.server from serverForAction so an egress policy can match the origin", async () => {
		const core = coreWith({
			model,
			policies: serverPolicy,
			serverForAction: (id) =>
				id === "petstore.getPet" ? "https://api.x.com" : undefined,
		});
		const r = await core.handleToolCall(
			{ name: "petstore.getPet", args: {} },
			{ principal: "alice" },
		);
		expect(r.status).toBe("ok");
	});

	it("a caller cannot forge context.server — it comes from the provider, not req.context", async () => {
		// No serverForAction; the caller smuggles `server` into the turn context.
		const core = coreWith({ model, policies: serverPolicy });
		const spoofed = { principal: "alice", server: "https://api.x.com" };
		const r = await core.handleToolCall(
			{ name: "petstore.getPet", args: {} },
			spoofed,
		);
		expect(r.status).toBe("denied"); // the smuggled server is ignored; context.server is unset
	});
});
