// The composed authz-blueprint proof (plan: docs/plans/authz-blueprint-plan.md): an uploaded
// openapi.json becomes policy-addressable end to end — extract (runtime) → authorization model
// (@euroclaw/authz) → rendered Cedar schema → live decisions through the governance chokepoint
// (@euroclaw/policy-cedar), including arg-conditioned permits and the needs-approval probe.

import { buildAuthzModel, modelToCedarSchema } from "@euroclaw/authz";
import type { JsonObject, ToolCall } from "@euroclaw/contracts";
import { createGovernance } from "@euroclaw/core";
import { cedarPolicyPlugin } from "@euroclaw/policy-cedar";
import { toolsFromOpenApi } from "@euroclaw/runtime";
import { describe, expect, it } from "vitest";

const petstore: JsonObject = {
	openapi: "3.1.0",
	info: { title: "petstore", version: "1.0.0" },
	servers: [{ url: "https://petstore.example/v1" }],
	security: [{ apiKey: [] }],
	paths: {
		"/pets": {
			get: {
				operationId: "listPets",
				summary: "List pets",
				tags: ["pets"],
				parameters: [
					{ name: "limit", in: "query", schema: { type: "integer" } },
				],
			},
			post: {
				operationId: "addPet",
				summary: "Create a pet",
				tags: ["pets"],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/NewPet" },
						},
					},
				},
			},
		},
		"/pets/{petId}": {
			parameters: [{ $ref: "#/components/parameters/PetId" }],
			get: {
				operationId: "getPet",
				summary: "Fetch one pet",
				tags: ["pets"],
			},
			delete: {
				operationId: "removePet",
				summary: "Delete a pet",
				tags: ["pets", "admin"],
			},
		},
	},
	components: {
		parameters: {
			PetId: {
				name: "petId",
				in: "path",
				schema: { $ref: "#/components/schemas/Id" },
			},
		},
		schemas: {
			Id: { type: "integer" },
			NewPet: {
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
};

const extraction = toolsFromOpenApi(petstore);
const model = buildAuthzModel(
	extraction.tools.map((tool) => ({
		id: tool.name,
		source: "tool" as const,
		governance: tool.governance,
		args: tool.inputSchema,
	})),
);

const POLICIES = `
	permit(principal, action in Action::"reads", resource);
	permit(principal, action == Action::"addPet", resource)
		when { context has args && context.args has categoryId && context.args.categoryId <= 5 };
	permit(principal, action in Action::"writes", resource)
		when { context.confirmationUsed };
	forbid(principal, action in Action::"deletes", resource)
		unless { context.confirmationUsed };
`;

const runEcho = (call: ToolCall) => ({ ran: call.name });
const core = createGovernance({
	plugins: [cedarPolicyPlugin({ model, policies: POLICIES })],
	runTool: runEcho,
});

describe("openapi → cedar blueprint (composed slices 1–4)", () => {
	it("extracts every operation, none skipped", () => {
		expect(extraction.skipped).toEqual([]);
		expect(extraction.tools.map((t) => t.name).sort()).toEqual([
			"addPet",
			"getPet",
			"listPets",
			"removePet",
		]);
	});

	it("renders a schema whose actions carry spec-derived groups and projected args", () => {
		const schema = modelToCedarSchema(model);
		expect(schema).toContain(
			'action "removePet" in ["deletes", "tag:admin", "tag:pets", "writes"]',
		);
		expect(schema).toContain(
			'action "addPet" in ["creates", "tag:pets", "writes"]',
		);
		// $ref'd integer param projected to Long; float body prop invisible to policy
		expect(schema).toMatch(/action "getPet".*"petId": Long/);
		expect(schema).toMatch(/action "addPet".*"categoryId"\?: Long/);
		expect(schema).not.toContain("weight");
		// the rendered schema parses under cedar-wasm — cedarPolicyPlugin() construction validates it
		expect(() => cedarPolicyPlugin({ model, policies: POLICIES })).not.toThrow();
	});

	it("reads run autonomously", async () => {
		const list = await core.handleToolCall(
			{ name: "listPets", args: { limit: 10 } },
			{ principal: "alice" },
		);
		expect(list.status).toBe("ok");
		const get = await core.handleToolCall(
			{ name: "getPet", args: { petId: 7 } },
			{ principal: "alice" },
		);
		expect(get.status).toBe("ok");
	});

	it("arg-conditioned write: small categoryId runs, large needs a human", async () => {
		const small = await core.handleToolCall(
			{ name: "addPet", args: { name: "Rex", categoryId: 2, weight: 4.5 } },
			{ principal: "alice" },
		);
		expect(small.status).toBe("ok");

		const large = await core.handleToolCall(
			{ name: "addPet", args: { name: "Rex", categoryId: 9 } },
			{ principal: "alice" },
		);
		expect(large.status).toBe("needs-approval");
	});

	it("deletes always need a human (forbid unless confirmed + probe)", async () => {
		const remove = await core.handleToolCall(
			{ name: "removePet", args: { petId: 7 } },
			{ principal: "alice" },
		);
		expect(remove.status).toBe("needs-approval");
	});

	it("a tool the spec never declared stays denied (deny-by-default allowlist)", async () => {
		const unknown = await core.handleToolCall(
			{ name: "dropDatabase", args: {} },
			{ principal: "alice" },
		);
		expect(unknown.status).toBe("denied");
	});
});
