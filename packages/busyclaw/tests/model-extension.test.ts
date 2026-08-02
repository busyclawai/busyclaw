import { type BusyclawPlugin, field } from "@busyclaw/contracts";
import { describe, expect, it } from "vitest";
import { createClaw } from "../src/index";
import { durableRedactor, owned, textModel } from "./fixtures";

describe("createClaw model extension", () => {
	it("persists and returns host additionalFields through the public claw api", async () => {
		const { db, redactor } = durableRedactor();
		const claw = owned({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
			schema: {
				claw: {
					additionalFields: {
						priority: field.number({ required: true }),
						squad: field.string(),
					},
				},
			},
		});

		const created = await claw.api.createClaw({
			priority: 7,
			squad: "growth",
		});
		// The extra columns come back on the record straight from create…
		expect(created).toMatchObject({ priority: 7, squad: "growth" });
		// …and round-trip through a fresh read.
		expect(await claw.api.getClaw({ id: created.id })).toMatchObject({
			priority: 7,
			squad: "growth",
		});
	});

	it("persists and returns plugin schema fields through the public claw api", async () => {
		const { db, redactor } = durableRedactor();
		const taggingPlugin = {
			id: "tagging",
			schema: { claw: { fields: { tag: field.string() } } },
		} satisfies BusyclawPlugin;
		const claw = owned({
			database: db,
			model: textModel("done"),
			redaction: { redactor },
			plugins: [taggingPlugin],
		});

		const created = await claw.api.createClaw({
			tag: "vip",
		});
		expect(created).toMatchObject({ tag: "vip" });
		expect(await claw.api.getClaw({ id: created.id })).toMatchObject({
			tag: "vip",
		});
	});

	it("fails fast at createClaw when a plugin redefines a core column", () => {
		const { db, redactor } = durableRedactor();
		const evil = {
			id: "evil",
			schema: { claw: { fields: { status: field.string() } } },
		} satisfies BusyclawPlugin;
		// The RUNTIME backstop. `createClaw` also refuses this at COMPILE time
		// (`RequireNoCoreColumnCollision`), which is what a TypeScript host meets — so the value has to
		// be cast past that gate for the runtime one to be reachable. What this pins is the JS caller.
		expect(() =>
			createClaw({
				database: db,
				model: textModel("done"),
				plugins: [evil],
				redaction: { redactor },
			} as unknown as Parameters<typeof createClaw>[0]),
		).toThrow(/redefines core column "status"/);
	});
});
