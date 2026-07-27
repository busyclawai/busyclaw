import { MODEL_ANNOTATION_MAX_LENGTH } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import {
	actionEntitiesFromModel,
	buildAuthzModel,
	cedarEngine,
	entitiesToCedarJson,
	modelToCedarSchema,
	projectArgs,
} from "../src/index";

describe("projectArgs — JSON-Schema → Cedar, lossy-but-safe", () => {
	const schema = {
		type: "object",
		properties: {
			amount: { type: "integer" },
			note: { type: "string" },
			urgent: { type: "boolean" },
			price: { type: "number" }, // float — must NOT project
			tags: { type: "array", items: { type: "string" } },
			meta: {
				type: "object",
				properties: { region: { type: "string" } },
				required: ["region"],
			},
		},
		required: ["amount"],
	};

	it("projects primitives, enums-as-strings, sets, and nested records; drops floats", () => {
		const p = projectArgs(schema);
		expect(p).toBeDefined();
		expect(p?.cedarType).toContain('"amount": Long');
		expect(p?.cedarType).toContain('"note"?: String');
		expect(p?.cedarType).toContain('"urgent"?: Bool');
		expect(p?.cedarType).toContain('"tags"?: Set<String>');
		expect(p?.cedarType).toContain('"meta"?: {"region": String}');
		expect(p?.cedarType).not.toContain("price");
	});

	it("the filter drops unprojected and unknown keys, recursively — same walker as the render", () => {
		const p = projectArgs(schema);
		const filtered = p?.filter({
			amount: 100,
			note: "hi",
			price: 19.99, // dropped: float didn't project
			hack: "extra", // dropped: never in the schema
			meta: { region: "eu", secret: "x" }, // nested unknown dropped
		});
		expect(filtered).toEqual({
			amount: 100,
			note: "hi",
			meta: { region: "eu" },
		});
	});

	it("hostile property names (__proto__) project and filter as OWN properties — no prototype mutation", () => {
		// JSON.parse, not literals: {"__proto__": …} in a literal would set the prototype
		const hostile = JSON.parse(
			'{"type":"object","properties":{"__proto__":{"type":"string"}}}',
		);
		const p = projectArgs(hostile);
		expect(p?.cedarType).toContain('"__proto__"?: String');
		const filtered = p?.filter(JSON.parse('{"__proto__":"x","other":1}'));
		expect(filtered).toBeDefined();
		expect(Object.hasOwn(filtered ?? {}, "__proto__")).toBe(true);
		expect(Object.keys(filtered ?? {})).toEqual(["__proto__"]);
	});

	it("returns undefined when nothing projects — the action then has no args in Cedar", () => {
		expect(
			projectArgs({
				type: "object",
				properties: { ratio: { type: "number" } },
			}),
		).toBeUndefined();
		expect(projectArgs({ type: "string" })).toBeUndefined();
	});
});

describe("modelToCedarSchema — the model rendered as Cedar schema text", () => {
	const model = buildAuthzModel([
		{
			id: "refund",
			source: "tool",
			governance: { access: "write", groups: ["payments:all"] },
			args: {
				type: "object",
				properties: { amount: { type: "integer" } },
				required: ["amount"],
			},
		},
		{
			id: "lookup",
			source: "tool",
			governance: { access: "read", resource: "Candidate" },
		},
	]);

	it("declares principals, entity types with tags, groups, and typed actions", () => {
		const text = modelToCedarSchema(model);
		expect(text).toContain("entity User tags String;");
		expect(text).toContain("entity Tool tags String;");
		expect(text).toContain("entity Candidate tags String;");
		expect(text).toContain('action "writes";');
		expect(text).toContain('action "reads";');
		expect(text).toContain('action "payments:all";');
		expect(text).toContain('action "refund" in ["payments:all", "writes"]');
		expect(text).toContain('args?: {"amount": Long}');
		expect(text).toContain("resource: [Candidate]");
		expect(text).toContain("confirmationUsed: Bool");
		expect(text).toContain("runMode?: String");
	});

	it("renders parents and namespaces; declares referenced-but-undeclared parents", () => {
		const withParents = {
			...model,
			entityTypes: [{ type: "Tool", parents: ["McpServer"] }],
		};
		const text = modelToCedarSchema(withParents, { namespace: "Busyclaw" });
		expect(text).toContain("namespace Busyclaw {");
		expect(text).toContain("entity Tool in [McpServer] tags String;");
		expect(text).toContain("entity McpServer tags String;");
	});
});

describe("entity JSON renderings", () => {
	it("entitiesToCedarJson defaults attrs/parents and keeps tags", () => {
		expect(
			entitiesToCedarJson([
				{
					uid: { type: "Tool", id: "mcp:github:create_issue" },
					parents: [{ type: "McpServer", id: "github" }],
					tags: { access: "write" },
				},
			]),
		).toEqual([
			{
				uid: { type: "Tool", id: "mcp:github:create_issue" },
				attrs: {},
				parents: [{ type: "McpServer", id: "github" }],
				tags: { access: "write" },
			},
		]);
	});

	it("escapes quotes in group ids and arg property names — an untrusted spec cannot inject into the rendered schema", () => {
		const model = buildAuthzModel([
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
		const text = modelToCedarSchema(model);
		expect(text).toContain('action "tag:a\\"b";');
		expect(text).toContain('"wei\\"rd"?: String');
	});

	it("actionEntitiesFromModel emits the action hierarchy for evaluation-time `action in`", () => {
		const model = buildAuthzModel([
			{ id: "refund", source: "tool", governance: { access: "write" } },
		]);
		const entities = actionEntitiesFromModel(model);
		expect(entities).toContainEqual({
			uid: { type: "Action", id: "writes" },
			attrs: {},
			parents: [],
		});
		expect(entities).toContainEqual({
			uid: { type: "Action", id: "refund" },
			attrs: {},
			parents: [{ type: "Action", id: "writes" }],
		});
	});
});

// Policy annotations, at the engine that produces them. The AUDIENCE a key was declared for decides
// which of two DISJOINT bags a decision carries it in, and the split is made HERE — the last place
// that still knows the declarations — so no downstream door has to filter, or remember to.
describe("cedarEngine — annotations split by the audience they were declared for", () => {
	const request = {
		principal: { type: "User", id: "alice" },
		action: { type: "Action", id: "read_salary" },
		resource: { type: "Tool", id: "read_salary" },
		context: {},
	};
	const GUIDANCE =
		"Salary fields need HR approval — ask the requester to route this to People Ops.";
	// The pair the audience field exists for: who can unblock it (an internal id), and what the agent
	// should do about it (prose) — written by the same author on the same rule.
	const annotated = (body: string) => ({
		"salary:rule": `@escalate("betterauth:team_eng")
@guidance("${GUIDANCE}")
${body}`,
	});
	const declared = [
		{ key: "escalate" },
		{ key: "guidance", audience: "model" as const },
	];

	it("a deny carries the host key in `annotations` and the model key in `modelAnnotations`", async () => {
		const engine = cedarEngine({
			policies: annotated(
				`forbid(principal, action == Action::"read_salary", resource);`,
			),
			annotations: declared,
		});
		const result = await engine.authorize(request);
		expect(result.decision).toBe("deny");
		expect(result.annotations).toEqual({ escalate: "betterauth:team_eng" });
		expect(result.modelAnnotations).toEqual({ guidance: GUIDANCE });
	});

	it("so does a needs-approval — the probe's rules answer to the same two readers", async () => {
		const engine = cedarEngine({
			policies: annotated(
				`permit(principal, action == Action::"read_salary", resource) when { context.confirmationUsed };`,
			),
			annotations: declared,
		});
		const result = await engine.authorize(request);
		expect(result.decision).toBe("needs-approval");
		expect(result.annotations).toEqual({ escalate: "betterauth:team_eng" });
		expect(result.modelAnnotations).toEqual({ guidance: GUIDANCE });
	});

	it("an UNDECLARED audience is the host's — declaring a key can never, alone, start feeding a model", async () => {
		const engine = cedarEngine({
			policies: annotated(
				`forbid(principal, action == Action::"read_salary", resource);`,
			),
			// The same policy, both keys declared, neither with an audience.
			annotations: [{ key: "escalate" }, { key: "guidance" }],
		});
		const result = await engine.authorize(request);
		expect(result.modelAnnotations).toBeUndefined();
		expect(result.annotations).toEqual({
			escalate: "betterauth:team_eng",
			guidance: GUIDANCE,
		});
	});

	it("an over-long model-audience value is REJECTED at construction, naming key and policy", () => {
		const build = () =>
			cedarEngine({
				policies: {
					"salary:rule": `@guidance("${"x".repeat(MODEL_ANNOTATION_MAX_LENGTH + 1)}")
forbid(principal, action == Action::"read_salary", resource);`,
				},
				annotations: declared,
			});
		// A config bug, caught where unparseable policy text is caught. Not truncated into an
		// instruction that stops mid-sentence, and not a runtime deny for a formatting mistake.
		expect(build).toThrow(/@guidance/);
		expect(build).toThrow(/salary:rule/);
	});

	it("the HOST bag is NOT bounded — an opaque id that already works keeps working", async () => {
		// The bound is about what enters a context window, so it applies where that risk is. Extending
		// it to the host bag would retroactively break an escalation target nobody sized for it.
		const long = `betterauth:${"o".repeat(MODEL_ANNOTATION_MAX_LENGTH)}`;
		const engine = cedarEngine({
			policies: {
				"salary:rule": `@escalate("${long}")
forbid(principal, action == Action::"read_salary", resource);`,
			},
			annotations: declared,
		});
		expect((await engine.authorize(request)).annotations).toEqual({
			escalate: long,
		});
	});
});
