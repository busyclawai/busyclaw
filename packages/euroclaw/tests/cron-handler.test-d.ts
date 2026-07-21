// Type tests (vitest typecheck mode). A passing run means each `@ts-expect-error` produced the
// intended compile-time error — createClaw's cron-handler requirement is enforced in the type system.
import type { EuroclawPlugin } from "@euroclaw/contracts";
import { type SqlEngineStore, sqlEngine } from "@euroclaw/engine-sql";
import { describe, test } from "vitest";
import { createClaw, type RuntimeConfig } from "../src/index";

declare const model: NonNullable<RuntimeConfig["model"]>;
declare const store: SqlEngineStore;

describe("createClaw cronHandler requirement", () => {
	test("an engine contributing cron work requires cronHandler (unless cron is off)", () => {
		createClaw({
			cronHandler: { secret: "secret" },
			engine: sqlEngine({ store }),
			model,
		});
		createClaw({ cronHandler: false, engine: sqlEngine({ store }), model });
		createClaw({ engine: sqlEngine({ cron: false, store }), model });
		// @ts-expect-error — SQL contributes cron work by default, so cronHandler is required
		createClaw({ engine: sqlEngine({ store }), model });
	});

	test("a cron-capable plugin requires cronHandler; a webhook-only plugin does not", () => {
		const cronPlugin: EuroclawPlugin<"has-cron"> = {
			id: "channel:telegram",
			cron: [
				{
					id: "channel:telegram:poll",
					handler: () => ({ status: "idle" as const }),
				},
			],
		};
		createClaw({
			cronHandler: { secret: "secret" },
			model,
			plugins: [cronPlugin],
		});
		// @ts-expect-error — cron-capable plugins require createClaw({ cronHandler })
		createClaw({ model, plugins: [cronPlugin] });

		const webhookOnlyPlugin: EuroclawPlugin<"no-cron"> = {
			id: "channel:telegram",
		};
		createClaw({ model, plugins: [webhookOnlyPlugin] });
	});
});
