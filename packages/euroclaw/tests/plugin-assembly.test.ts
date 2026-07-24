// The ASSEMBLY-level plugin contract, proven against a minimal inline plugin rather than a real one:
// a plugin's api namespace reaches `claw.api`, a duplicate namespace fails loud, and a plugin's own
// `schema` tables are collected beside core's. These three assertions previously rode on the skills
// plugin (skills-api.test.ts, deleted with the package) — they are properties of the ASSEMBLY, not of
// skills, so they belong on a fixture that can't rot with whatever plugin happens to exist.

import { field } from "@euroclaw/contracts";
import { describe, expect, it } from "vitest";
import { createClaw, getEuroclawTables } from "../src/index";
import { textModel } from "./fixtures";

/** A minimal plugin: one api namespace + one owned table. Nothing else. */
const notesPlugin = () => ({
	id: "notes",
	$Api: {} as { notes: { ping: () => string } },
	api: () => ({ notes: { ping: () => "pong" } }),
	schema: {
		note: {
			fields: {
				id: field.string({ required: true, unique: true, immutable: true }),
				body: field.string(),
			},
		},
	},
});

describe("createClaw plugin assembly", () => {
	it("exposes a plugin's api namespace on claw.api", () => {
		const claw = createClaw({
			model: textModel("done"),
			plugins: [notesPlugin()],
		});
		expect(claw.api.notes).toBeDefined();
	});

	it("rejects duplicate plugin API namespaces", () => {
		const plugin = (id: string) => ({
			id,
			$Api: {} as { notes: { marker: string } },
			api: () => ({ notes: { marker: id } }),
		});

		expect(() =>
			createClaw({
				model: textModel("done"),
				plugins: [plugin("a"), plugin("b")],
			}),
		).toThrow(/duplicate euroclaw plugin api namespace/);
	});

	it("collects a plugin's owned tables through getEuroclawTables, beside core's", () => {
		const tables = getEuroclawTables({ plugins: [notesPlugin()] });
		// the plugin's declared table + its columns survive the round-trip
		expect(tables.note).toBeDefined();
		expect(tables.note?.fields.body).toBeDefined();
		// core tables are intact alongside it — incl. the generic access_grant ACL
		expect(tables.claw).toBeDefined();
		expect(tables.access_grant).toBeDefined();
	});
});
