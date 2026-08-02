// Type tests (vitest typecheck mode). channels() registrations mode owns the channel_registration
// table, so it marks itself `$RequiresDatabase` — and createClaw's RequireDatabaseForPlugins rejects at
// compile time an enabled config that passes no database (a runtime configurationError backstops JS /
// `as any` callers). The storage mirror of the $HasCron→RequireCronHandler fold; models directly on
// dynamic-secret-aliases.test-d.ts.
import { memoryAdapter } from "@busyclaw/storage-core";
import { createClaw, type RuntimeConfig } from "busyclaw";
import { describe, test } from "vitest";
import { channels } from "../src/index";
import { telegram } from "../src/telegram/index";

declare const model: NonNullable<RuntimeConfig["model"]>;

describe("createClaw channels registrations database requirement", () => {
	test("registrations enabled without a database is a compile error", () => {
		// @ts-expect-error — channels registrations owns a table, so a database is required
		createClaw({
			model,
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
	});

	// A database is necessary but no longer sufficient: registrations also contribute the queues'
	// drain, so the cron fold applies too. Both requirements are exercised here so a change to either
	// one shows up as a failure in the test that owns it, rather than as a surprise in the other.
	test("registrations enabled WITH a database and a cron handler type-checks", () => {
		createClaw({
			cronHandler: { secret: "s" },
			model,
			database: memoryAdapter(),
			plugins: [channels([telegram()], { registrations: { enabled: true } })],
		});
	});

	test("app-bot mode — registrations off or absent — needs no database", () => {
		createClaw({ model, plugins: [channels([telegram()])] });
		createClaw({
			model,
			plugins: [channels([telegram()], { registrations: { enabled: false } })],
		});
	});
});
