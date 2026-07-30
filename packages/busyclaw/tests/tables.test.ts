import { type BusyclawPlugin, field } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { assertUniquesRepresentable, getBusyclawTables } from "../src/index";

describe("getBusyclawTables", () => {
	it("includes busyclaw's core durable tables", () => {
		const tables = getBusyclawTables({});
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
		const tables = getBusyclawTables({
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
		} satisfies BusyclawPlugin;
		const tables = getBusyclawTables({ plugins: [tagging] });
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
		} satisfies BusyclawPlugin;
		const tables = getBusyclawTables({ plugins: [notes] });
		expect(tables.note).toBeDefined();
		expect(tables.note?.fields.body).toMatchObject({ type: "string" });
		// it's a NEW table, not a mutation of any core one
		expect(tables.claw?.fields.body).toBeUndefined();
	});

	it("throws when a plugin redefines a core column instead of adding one", () => {
		const evil = {
			id: "evil",
			schema: { claw: { fields: { status: field.string() } } },
		} satisfies BusyclawPlugin;
		expect(() => getBusyclawTables({ plugins: [evil] })).toThrow(
			/redefines core column "status"/,
		);
	});

	it("merges default < plugin < host — the host wins on a shared extra field", () => {
		const plugin = {
			id: "p",
			schema: { claw: { fields: { priority: field.string() } } },
		} satisfies BusyclawPlugin;
		const tables = getBusyclawTables({
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

// R-H11. Entities declared composite uniqueness and the generators already read `table.uniques` —
// but the assembly in between held field maps only and rebuilt each entity with NO options, so every
// table-level constraint was dropped on the way and no migration ever emitted one.
//
// That is not merely missing hardening. `upsertWithRetry` in @busyclaw/storage-durable documents an
// explicit dependency: "the composite unique on each table's logical tuple is what rejects the second
// write; this is what turns that rejection into a retry". Without the constraint the rejection never
// comes, so two concurrent lookup-then-create upserts both INSERT — duplicate rows, silently, on the
// exact tables whose identity matters most.
describe("getBusyclawTables — table-level constraints survive assembly", () => {
	const uniquesOf = (model: string) =>
		(getBusyclawTables({})[model]?.uniques ?? []).map((key) => [...key]);

	it("carries the uniques the entities declare", () => {
		expect(uniquesOf("policy_slice")).toEqual([["scope", "scopeId", "name"]]);
		expect(uniquesOf("spec_registration")).toEqual([
			["scope", "scopeId", "source"],
		]);
		expect(uniquesOf("facts_overlay")).toEqual([
			["scope", "scopeId", "actionId"],
		]);
		expect(uniquesOf("pii_mapping")).toEqual([
			["scope", "scopeId", "originalHash"],
		]);
	});

	it("declares the natural keys nothing had stated", () => {
		// A duplicate tool_call row addresses one result from two runs — cross-run disclosure.
		expect(uniquesOf("tool_call")).toEqual([["runId", "toolCallId"]]);
		// Its own field comment already named this key; nobody had declared it, so inbound routing
		// could be ambiguous and a reply could land in the wrong thread.
		expect(uniquesOf("conversation_binding")).toEqual([
			["provider", "endpointKey", "externalConversationId"],
		]);
		// A second membership row is a revocation bypass: removing the one you can see leaves the
		// other one granting.
		expect(uniquesOf("team_member")).toEqual([["team", "userId"]]);
		expect(uniquesOf("team_invite")).toEqual([["team", "email"]]);
	});

	it("still carries them when a plugin EXTENDS the model", () => {
		// Extension is the case that would quietly lose them: a plugin adding a column re-merges the
		// field map, and if the constraint rode only on the original entity it would not survive.
		const plugin: BusyclawPlugin = {
			id: "ext",
			schema: { policy_slice: { fields: { note: field.string() } } },
		};
		const tables = getBusyclawTables({ plugins: [plugin] });
		expect(tables["policy_slice"]?.fields?.note).toBeDefined();
		expect((tables["policy_slice"]?.uniques ?? []).map((k) => [...k])).toEqual([
			["scope", "scopeId", "name"],
		]);
	});

	it("a constraint over a column the model lacks is REFUSED", () => {
		// Unreachable through the public API — a core model always has the columns its own key names,
		// which is what an assertion is — so this drives the predicate directly.
		//
		// It earned its keep on its first run: the first draft of `conversation_binding`'s key was
		// written from the audit's prose instead of read off the columns, and this refused it. A
		// constraint a generator cannot represent must never reach one.
		expect(() =>
			assertUniquesRepresentable("policy_slice", { scope: field.string() }, [
				["scope", "nope"],
			]),
		).toThrow(/declares a unique over "nope"/);
		// The representable case passes through silently.
		expect(() =>
			assertUniquesRepresentable(
				"policy_slice",
				{ scope: field.string(), name: field.string() },
				[["scope", "name"]],
			),
		).not.toThrow();
	});
});
