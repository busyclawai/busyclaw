// Type tests (vitest typecheck mode). A passing run means each `@ts-expect-error` produced the
// intended compile-time error — createClaw's cron-handler requirement is enforced in the type system.
import type { BusyclawPlugin } from "@busyclaw/contracts";
import { type SqlEngineStore, sqlEngine } from "@busyclaw/engine-sql";
import { cedar } from "@busyclaw/policy-cedar";
import { secrets } from "@busyclaw/secrets-plugin";
import { memoryAdapter } from "@busyclaw/storage-core";
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
		const cronPlugin: BusyclawPlugin<"has-cron"> = {
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

		const webhookOnlyPlugin: BusyclawPlugin<"no-cron"> = {
			id: "channel:telegram",
		};
		createClaw({ model, plugins: [webhookOnlyPlugin] });
	});

	// The regression guard for the DEFAULT flag: a factory whose return type is a bare
	// `BusyclawPlugin` inherits the whole flag union, which `HasCronContributor` reads as "has-cron"
	// — so installing a plugin that owns no cron at all demanded a cronHandler the host has no use
	// for. Every shipped factory states its flag; these calls fail to compile if one stops.
	test("a shipped plugin that contributes no cron needs no cronHandler", () => {
		createClaw({ model, plugins: [secrets()] });
		createClaw({ model, plugins: [secrets([], { id: "custom" })] });
		createClaw({ model, plugins: [cedar({ policies: "" })] });
		createClaw({
			database: memoryAdapter(),
			model,
			plugins: [secrets([], { store: true })],
		});
	});
});
