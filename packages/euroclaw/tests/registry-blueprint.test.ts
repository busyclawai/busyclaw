// The composed slice-5 proof: an uploaded openapi.json becomes an organization's governed tool
// surface, routed per-organization. Registration (runtime) → registry rows (storage) → assembled
// AuthzModel (authz) → per-org compiled Cedar bundle behind the org router (authz) → live decisions
// through the governance chokepoint (core + policy-cedar). Plus: the registration verb is itself a
// governed action, and the agent-facing tool binds the org from trusted context, never model args.

import {
	type AuthzActionInput,
	actionEntitiesFromModel,
	buildAuthzModel,
	createOrgPolicyRouter,
	createPolicyPlugin,
	modelToCedarSchema,
	projectArgs,
} from "@euroclaw/authz";
import type {
	AuthzModel,
	JsonObject,
	PolicyEngine,
	PolicyRequest,
	ToolCall,
} from "@euroclaw/contracts";
import { ORGANIZATION_CONTEXT_KEY } from "@euroclaw/contracts";
import { createGovernance } from "@euroclaw/core";
import { cedarEngine, cedarPolicyPlugin } from "@euroclaw/policy-cedar";
import {
	createSpecRegistry,
	REGISTER_OPENAPI_SPEC_ACTION,
} from "@euroclaw/runtime";
import { memoryAdapter } from "@euroclaw/storage-core";
import { createRegistryStores } from "@euroclaw/storage-durable";
import { describe, expect, it } from "vitest";
import { assembleOrgActions, registerOpenApiSpecTool } from "../src/index";

const petstore = (withRemove = true): JsonObject => ({
	openapi: "3.1.0",
	info: { title: "petstore", version: "1.0.0" },
	paths: {
		"/pets": {
			get: { operationId: "listPets", tags: ["pets"] },
			post: {
				operationId: "addPet",
				tags: ["pets"],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									name: { type: "string" },
									categoryId: { type: "integer" },
									weight: { type: "number" }, // float — must stay invisible to policy
								},
								required: ["name"],
							},
						},
					},
				},
			},
		},
		"/pets/{petId}": {
			get: {
				operationId: "getPet",
				tags: ["pets"],
				parameters: [
					{ name: "petId", in: "path", schema: { type: "integer" } },
				],
			},
			...(withRemove
				? {
						delete: {
							operationId: "removePet",
							tags: ["pets", "admin"],
							parameters: [
								{ name: "petId", in: "path", schema: { type: "integer" } },
							],
						},
					}
				: {}),
		},
	},
});

// A hand-stamped code tool the host wrote — it lives in the vocabulary beside the uploaded ones.
const pingTool: AuthzActionInput = {
	id: "ping",
	source: "tool",
	governance: { access: "read" },
};

const ORG_A_POLICIES = `
	permit(principal, action in Action::"reads", resource);
	permit(principal, action == Action::"petstore.addPet", resource)
		when { context has args && context.args has categoryId && context.args.categoryId <= 5 };
	permit(principal, action in Action::"writes", resource) when { context.confirmationUsed };
	forbid(principal, action in Action::"deletes", resource) unless { context.confirmationUsed };
`;
// The "system" bundle for uncustomized orgs: reads only, everything else deny-by-default.
const SYSTEM_POLICIES = `permit(principal, action in Action::"reads", resource);`;

/** Compile an org's neutral model + policies into a Cedar PolicyEngine bundle (the router's unit).
 *  Args are PROJECTED per the org's model before Cedar sees them — floats/unions never reach the PDP. */
function compileBundle(model: AuthzModel, policies: string): PolicyEngine {
	const engine = cedarEngine({
		policies,
		entities: actionEntitiesFromModel(model) as never,
	});
	const projections = new Map(
		model.actions.map(
			(a) => [a.id, a.args ? projectArgs(a.args) : undefined] as const,
		),
	);
	return {
		authorize(req) {
			const context = { ...req.context };
			if (projections.has(req.action.id)) {
				const projection = projections.get(req.action.id);
				const raw = (req.context.args ?? {}) as JsonObject;
				context.args = projection ? projection.filter(raw) : {};
			}
			return engine.authorize({ ...req, context });
		},
	};
}

const runEcho = (call: ToolCall) => ({ ran: call.name });

describe("registry blueprint (composed slice 5)", () => {
	async function setup() {
		const stores = createRegistryStores(memoryAdapter());
		const registry = createSpecRegistry(stores);
		await registry.registerOpenApiSpec({
			organizationId: "org-a",
			source: "petstore",
			document: petstore(),
			registeredBy: "user:alice",
		});

		const assembleFor = async (organizationId: string) => {
			const [registeredTools, overlay] = await Promise.all([
				stores.registeredTools.listByOrganization(organizationId),
				stores.factsOverlay.listByOrganization(organizationId),
			]);
			return assembleOrgActions({
				base: [pingTool, REGISTER_OPENAPI_SPEC_ACTION],
				registeredTools,
				overlay,
			});
		};

		const router = createOrgPolicyRouter({
			// Key on the org's registration content version — a re-registration bumps it and the next
			// decision rebuilds; orgs with nothing registered share the "system" bundle.
			keyFor: async (org) => {
				if (!org) return "system";
				const regs = await stores.specRegistrations.listByOrganization(org);
				return regs.length
					? `${org}:${regs.map((r) => r.contentVersion).join(",")}`
					: "system";
			},
			engineFor: async (org) => {
				const { model } = await assembleFor(org ?? "");
				return compileBundle(
					model,
					org === "org-a" ? ORG_A_POLICIES : SYSTEM_POLICIES,
				);
			},
		});

		const mapCall = (
			call: ToolCall,
			ctx: { principal: string },
		): PolicyRequest => {
			const organizationId = Reflect.get(ctx, ORGANIZATION_CONTEXT_KEY);
			return {
				principal: { type: "User", id: ctx.principal },
				action: { type: "Action", id: call.name },
				resource: { type: "Tool", id: call.name },
				context: {
					args: call.args,
					confirmationUsed: false,
					...(typeof organizationId === "string" ? { organizationId } : {}),
				},
			};
		};

		const coreFor = (organizationId: string) =>
			createGovernance({
				plugins: [createPolicyPlugin({ engine: router, mapCall })],
				resolveContext: (ctx) => ({
					...ctx,
					euroclaw__organizationId: organizationId,
				}),
				runTool: runEcho,
			});

		return { stores, registry, assembleFor, coreFor };
	}

	it("org-a's registered addPet is arg-conditioned: small categoryId runs, large needs a human", async () => {
		const { coreFor } = await setup();
		const core = coreFor("org-a");
		const small = await core.handleToolCall(
			{
				name: "petstore.addPet",
				args: { name: "Rex", categoryId: 2, weight: 4.5 },
			},
			{ principal: "alice" },
		);
		expect(small.status).toBe("ok"); // float weight was projected away; categoryId <= 5 permits

		const large = await core.handleToolCall(
			{ name: "petstore.addPet", args: { name: "Rex", categoryId: 9 } },
			{ principal: "alice" },
		);
		expect(large.status).toBe("needs-approval"); // writes need confirmation
	});

	it("org-b (nothing registered) is denied the same dotted action", async () => {
		const { coreFor } = await setup();
		const denied = await coreFor("org-b").handleToolCall(
			{ name: "petstore.addPet", args: { name: "Rex", categoryId: 2 } },
			{ principal: "alice" },
		);
		expect(denied.status).toBe("denied"); // the action isn't in org-b's vocabulary
	});

	it("re-registering with removePet deleted drops the action (fail-closed)", async () => {
		const { registry, coreFor } = await setup();
		const before = await coreFor("org-a").handleToolCall(
			{ name: "petstore.removePet", args: { petId: 7 } },
			{ principal: "alice" },
		);
		expect(before.status).toBe("needs-approval"); // a delete, gated but present

		await registry.registerOpenApiSpec({
			organizationId: "org-a",
			source: "petstore",
			document: petstore(false), // removePet gone from the spec
			registeredBy: "user:alice",
		});

		// The content version changed → the router misses → rebuilds without removePet.
		const after = await coreFor("org-a").handleToolCall(
			{ name: "petstore.removePet", args: { petId: 7 } },
			{ principal: "alice" },
		);
		expect(after.status).toBe("denied"); // the vanished tool is no longer permitted
	});

	it("a facts overlay changes the assembled vocabulary and the rendered Cedar", async () => {
		const { stores, assembleFor } = await setup();
		await stores.factsOverlay.upsert({
			organizationId: "org-a",
			actionId: "petstore.getPet",
			access: "write", // a read tool, forced to write by the customer overlay
			groups: ["audited"],
			updatedBy: "user:admin",
		});
		const assembled = await assembleFor("org-a");
		const getPet = assembled.actions.find((a) => a.id === "petstore.getPet");
		expect(getPet?.access).toBe("write");
		expect(getPet?.groups).toEqual(["audited", "writes"]); // overlay groups + fail-closed write group
		// write→read would be a loosening; write is a tightening — none reported here.
		expect(assembled.loosenings).toEqual([]);
		const schema = modelToCedarSchema(assembled.model);
		expect(schema).toContain(
			'action "petstore.getPet" in ["audited", "writes"]',
		);
	});

	it("listActions-style assembly includes the domain verb with no tool row behind it", async () => {
		const { assembleFor } = await setup();
		const assembled = await assembleFor("org-a");
		const ids = assembled.actions.map((a) => a.id).sort();
		expect(ids).toContain("register_openapi_spec"); // a domain verb — not a tool
		expect(ids).toContain("ping"); // a code tool
		expect(ids).toContain("petstore.addPet"); // a registered tool
		const verb = assembled.actions.find(
			(a) => a.id === "register_openapi_spec",
		);
		expect(verb?.source).toBe("domain");
	});
});

describe("the registration verb is itself governed", () => {
	function registerSetup(principalOrg: string) {
		const stores = createRegistryStores(memoryAdapter());
		const registry = createSpecRegistry(stores);
		const registerTool = registerOpenApiSpecTool(registry, {
			organizationId: principalOrg,
			registeredBy: "user:alice",
		});
		const model = buildAuthzModel([REGISTER_OPENAPI_SPEC_ACTION]);
		const runTool = async (call: ToolCall) =>
			call.name === "register_openapi_spec"
				? registerTool.execute(
						call.args as never,
						{ toolCallId: "t", messages: [] } as never,
					)
				: runEcho(call);
		const coreWith = (policies: string) =>
			createGovernance({ plugins: [cedarPolicyPlugin({ model, policies })], runTool });
		return { stores, coreWith };
	}

	it("a policy that forbids register_openapi_spec denies it (no row written)", async () => {
		const { stores, coreWith } = registerSetup("org-a");
		const core = coreWith(
			`permit(principal, action == Action::"ping", resource);`,
		);
		const denied = await core.handleToolCall(
			{
				name: "register_openapi_spec",
				args: { source: "petstore", document: petstore() },
			},
			{ principal: "mallory" },
		);
		expect(denied.status).toBe("denied");
		expect(await stores.specRegistrations.listByOrganization("org-a")).toEqual(
			[],
		);
	});

	it("a policy that permits it registers the spec", async () => {
		const { stores, coreWith } = registerSetup("org-a");
		const core = coreWith(
			`permit(principal, action == Action::"register_openapi_spec", resource);`,
		);
		const ok = await core.handleToolCall(
			{
				name: "register_openapi_spec",
				args: { source: "petstore", document: petstore() },
			},
			{ principal: "alice" },
		);
		expect(ok.status).toBe("ok");
		const regs = await stores.specRegistrations.listByOrganization("org-a");
		expect(regs).toHaveLength(1);
	});

	it("organizationId comes from bound context, never model args — no cross-org registration", async () => {
		const { stores, coreWith } = registerSetup("org-a"); // the tool is bound to org-a
		const core = coreWith(
			`permit(principal, action == Action::"register_openapi_spec", resource);`,
		);
		// A prompt-injected model smuggles organizationId: "org-b" into the args.
		await core.handleToolCall(
			{
				name: "register_openapi_spec",
				args: {
					source: "petstore",
					document: petstore(),
					organizationId: "org-b",
				},
			},
			{ principal: "alice" },
		);
		// The injected org was ignored: the row landed in the BOUND org, and org-b got nothing.
		expect(
			await stores.specRegistrations.listByOrganization("org-a"),
		).toHaveLength(1);
		expect(await stores.specRegistrations.listByOrganization("org-b")).toEqual(
			[],
		);
	});
});
