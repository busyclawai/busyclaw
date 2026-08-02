import { describe, expect, it } from "vitest";
import type { AuthzActionInput, FactsOverlayEntry } from "../src/index";
import {
	actionInputsFromRegisteredTools,
	buildAuthzModel,
	mergeFactsOverlay,
	modelToCedarSchema,
} from "../src/index";

const base: AuthzActionInput[] = [
	{
		id: "refund",
		source: "tool",
		governance: { access: "write", groups: ["payments"] },
		args: {
			type: "object",
			properties: { amount: { type: "integer" } },
		},
	},
	{ id: "lookup", source: "tool", governance: { access: "read" } },
];

describe("mergeFactsOverlay", () => {
	it("overlay-wins per field (access, resource, audit REPLACE)", () => {
		const overlay: FactsOverlayEntry[] = [
			{ actionId: "lookup", access: "write", resource: "Ledger", audit: true },
		];
		const { inputs } = mergeFactsOverlay(base, overlay);
		const lookup = inputs.find((i) => i.id === "lookup");
		expect(lookup?.governance?.access).toBe("write");
		expect(lookup?.governance?.resource).toBe("Ledger");
		expect(lookup?.governance?.audit).toBe(true);
	});

	it("groups REPLACE the stamped groups (never a union)", () => {
		const { inputs } = mergeFactsOverlay(base, [
			{ actionId: "refund", groups: ["audited"] },
		]);
		const refund = inputs.find((i) => i.id === "refund");
		expect(refund?.governance?.groups).toEqual(["audited"]); // "payments" is gone
	});

	it("a write→read change is a LOOSENING (reported, still applied)", () => {
		const { inputs, loosenings } = mergeFactsOverlay(base, [
			{ actionId: "refund", access: "read" },
		]);
		expect(loosenings).toEqual([
			{ actionId: "refund", from: "write", to: "read" },
		]);
		expect(inputs.find((i) => i.id === "refund")?.governance?.access).toBe(
			"read",
		); // still applied
	});

	it("a read→write tightening is NOT a loosening", () => {
		const { loosenings } = mergeFactsOverlay(base, [
			{ actionId: "lookup", access: "write" },
		]);
		expect(loosenings).toEqual([]);
	});

	it("an override whose actionId matched nothing is reported as unmatched", () => {
		const { unmatched } = mergeFactsOverlay(base, [
			{ actionId: "ghost", access: "read" },
		]);
		expect(unmatched).toEqual(["ghost"]);
	});

	it("a duplicate override for one actionId throws (config bug)", () => {
		expect(() =>
			mergeFactsOverlay(base, [
				{ actionId: "refund", access: "read" },
				{ actionId: "refund", audit: true },
			]),
		).toThrow(/duplicate override/);
	});

	it("the merged output feeds buildAuthzModel and changes the rendered Cedar", () => {
		const plain = modelToCedarSchema(buildAuthzModel(base));
		expect(plain).toContain('action "refund" in ["payments", "writes"]');

		const { inputs } = mergeFactsOverlay(base, [
			{ actionId: "refund", groups: ["audited"] },
		]);
		const overlaid = modelToCedarSchema(buildAuthzModel(inputs));
		expect(overlaid).toContain('action "refund" in ["audited", "writes"]');
		expect(overlaid).not.toContain("payments");
	});
});

describe("actionInputsFromRegisteredTools", () => {
	it("maps stored rows to action inputs with dotted ids and source 'tool'", () => {
		const inputs = actionInputsFromRegisteredTools([
			{
				address: "petstore.addPet",
				governance: { access: "write", groups: ["creates"] },
				inputSchema: {
					type: "object",
					properties: { name: { type: "string" } },
				},
			},
		]);
		expect(inputs).toEqual([
			{
				id: "petstore.addPet",
				source: "tool",
				governance: { access: "write", groups: ["creates"] },
				args: { type: "object", properties: { name: { type: "string" } } },
			},
		]);
	});

	it("fails LOUD on a stored governance blob that no longer validates", () => {
		expect(() =>
			actionInputsFromRegisteredTools([
				// Deliberately invalid — this asserts the RUNTIME validator rejects it, so the value has
				// to get past the compiler to be tested at all. Typed as the untrusted shape it really
				// is (a stored row nobody has validated yet) rather than cast at the call.
				{
					address: "petstore.addPet",
					governance: { access: "sideways" }, // not read|write
					inputSchema: { type: "object" },
				} as never,
			]),
		).toThrow(/governance invalid/);
	});

	it("its output feeds buildAuthzModel cleanly", () => {
		const inputs = actionInputsFromRegisteredTools([
			{
				address: "petstore.addPet",
				governance: { access: "write", groups: ["creates"] },
				inputSchema: { type: "object", properties: {} },
			},
		]);
		const schema = modelToCedarSchema(buildAuthzModel(inputs));
		expect(schema).toContain(
			'action "petstore.addPet" in ["creates", "writes"]',
		);
	});
});
