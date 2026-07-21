import { type EuroclawPlugin, field } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { getEuroclawTables } from "../src/index";

describe("getEuroclawTables", () => {
	it("includes euroclaw's core durable tables", () => {
		const tables = getEuroclawTables({});
		for (const model of [
			"claw",
			"thread",
			"message",
			"approval",
			"effect",
			"pii_mapping",
			"team_member",
		]) {
			expect(tables[model]).toBeDefined();
		}
		// skills tables are NOT core — they only appear when the skills plugin registers them.
		expect(tables.skill_package).toBeUndefined();
	});

	it("extends a core table with the host's additionalFields", () => {
		const tables = getEuroclawTables({
			schema: {
				claw: {
					additionalFields: { priority: field.number({ required: true }) },
				},
			},
		});
		expect(tables.claw?.fields.priority).toMatchObject({
			type: "number",
			required: true,
		});
		// core columns are still there — extension is additive
		expect(tables.claw?.fields.status).toBeDefined();
	});

	it("extends a core table with a plugin's schema fields (same slot as owning)", () => {
		const tagging = {
			id: "tagging",
			schema: { claw: { fields: { tag: field.string() } } },
		} satisfies EuroclawPlugin;
		const tables = getEuroclawTables({ plugins: [tagging] });
		expect(tables.claw?.fields.tag).toMatchObject({ type: "string" });
	});

	it("declares a plugin-owned model as its own table", () => {
		const notes = {
			id: "notes",
			schema: {
				note: {
					fields: {
						id: field.string({ required: true, unique: true }),
						body: field.string({ required: true }),
					},
				},
			},
		} satisfies EuroclawPlugin;
		const tables = getEuroclawTables({ plugins: [notes] });
		expect(tables.note).toBeDefined();
		expect(tables.note?.fields.body).toMatchObject({ type: "string" });
		// it's a NEW table, not a mutation of any core one
		expect(tables.claw?.fields.body).toBeUndefined();
	});

	it("throws when a plugin redefines a core column instead of adding one", () => {
		const evil = {
			id: "evil",
			schema: { claw: { fields: { status: field.string() } } },
		} satisfies EuroclawPlugin;
		expect(() => getEuroclawTables({ plugins: [evil] })).toThrow(
			/redefines core column "status"/,
		);
	});

	it("merges default < plugin < host — the host wins on a shared extra field", () => {
		const plugin = {
			id: "p",
			schema: { claw: { fields: { priority: field.string() } } },
		} satisfies EuroclawPlugin;
		const tables = getEuroclawTables({
			schema: {
				claw: {
					additionalFields: { priority: field.number({ required: true }) },
				},
			},
			plugins: [plugin],
		});
		expect(tables.claw?.fields.priority).toMatchObject({ type: "number" });
	});
});
